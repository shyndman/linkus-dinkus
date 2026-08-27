import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import {
  htmlChanged,
  incrementHtmlChangeCount,
  watchUrl,
  watchUrls,
  type SnapshotComparison,
  type UrlWatchOperations,
} from "../src/page-watch/watch-urls.ts";

const URL = "https://example.com/jobs";
const CACHE_DIRECTORY = "cache/example";
const CURRENT_SNAPSHOT = "cache/example/snapshot-20260826T120000Z.html";
const UNCHANGED_COMPARISON: SnapshotComparison = {
  state: "unchanged",
  previous: "cache/example/snapshot-20260826T110000Z.md",
  current: "cache/example/snapshot-20260826T120000Z.md",
  diff: "",
};
const CHANGED_COMPARISON: SnapshotComparison = {
  state: "changed",
  previous: "cache/example/snapshot-20260826T110000Z.md",
  current: "cache/example/snapshot-20260826T120000Z.md",
  diff: "+New job",
};

function makeOperations(
  calls: string[],
  overrides: Partial<UrlWatchOperations> = {},
): UrlWatchOperations {
  return {
    classifyUrl: (): Readonly<{ state: "configured"; cacheDirectory: string }> => {
      calls.push("classify");
      return { state: "configured", cacheDirectory: CACHE_DIRECTORY };
    },
    capturePage: (): string => {
      calls.push("capture");
      return CURRENT_SNAPSHOT;
    },
    extractSnapshot: (): string => {
      calls.push("extract");
      return CURRENT_SNAPSHOT.replace(/\.html$/, ".md");
    },
    compareSnapshots: (): SnapshotComparison => {
      calls.push("compare-markdown");
      return UNCHANGED_COMPARISON;
    },
    htmlChanged: (): boolean => {
      calls.push("compare-html");
      return false;
    },
    incrementHtmlChangeCount: (): number => {
      calls.push("increment-html-count");
      return 1;
    },
    runScriptAgent: (): void => {
      calls.push("script-agent");
    },
    runJudgeAgent: (): void => {
      calls.push("judge-agent");
    },
    recordResult: (_url: string, result: "success" | "failure"): void => {
      calls.push(`record-${result}`);
    },
    ...overrides,
  };
}

test("detects whether the newest HTML snapshot changed", (): void => {
  const directory = mkdtempSync(join(tmpdir(), "page-watch-html-"));
  try {
    const previous = join(directory, "snapshot-20260826T110000Z.html");
    const current = join(directory, "snapshot-20260826T120000Z.html");
    writeFileSync(previous, "<html>same</html>", "utf8");
    writeFileSync(current, "<html>same</html>", "utf8");
    assert.equal(htmlChanged(directory, current), false);
    writeFileSync(current, "<html>changed</html>", "utf8");
    assert.equal(htmlChanged(directory, current), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persists a separate HTML-change count in the URL cache", (): void => {
  const directory = mkdtempSync(join(tmpdir(), "page-watch-count-"));
  try {
    assert.equal(incrementHtmlChangeCount(directory), 1);
    assert.equal(incrementHtmlChangeCount(directory), 2);
    assert.equal(incrementHtmlChangeCount(directory), 3);
    assert.equal(incrementHtmlChangeCount(directory), 4);
    assert.equal(incrementHtmlChangeCount(directory), 5);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runs no agent when HTML and Markdown are unchanged", (): void => {
  const calls: string[] = [];
  const result = watchUrl(URL, "notify for new jobs", makeOperations(calls));

  assert.deepEqual(result, {
    url: URL,
    state: "unchanged",
    htmlChanged: false,
    scriptAgentRan: false,
    judgeAgentRan: false,
  });
  assert.deepEqual(calls, ["classify", "capture", "compare-html", "extract", "compare-markdown"]);
});

test("runs the script agent on every fifth HTML change", (): void => {
  const calls: string[] = [];
  const operations = makeOperations(calls, {
    htmlChanged: (): boolean => {
      calls.push("compare-html");
      return true;
    },
    incrementHtmlChangeCount: (): number => {
      calls.push("increment-html-count");
      return 5;
    },
  });

  const result = watchUrl(URL, "notify for new jobs", operations);

  assert.equal(result.scriptAgentRan, true);
  assert.equal(result.judgeAgentRan, false);
  assert.deepEqual(calls, [
    "classify",
    "capture",
    "compare-html",
    "increment-html-count",
    "script-agent",
    "extract",
    "compare-markdown",
  ]);
});

test("runs both agents when the fifth HTML change changes Markdown", (): void => {
  const calls: string[] = [];
  const operations = makeOperations(calls, {
    htmlChanged: (): boolean => {
      calls.push("compare-html");
      return true;
    },
    incrementHtmlChangeCount: (): number => {
      calls.push("increment-html-count");
      return 10;
    },
    compareSnapshots: (): SnapshotComparison => {
      calls.push("compare-markdown");
      return CHANGED_COMPARISON;
    },
  });

  const result = watchUrl(URL, "notify for new jobs", operations);

  assert.equal(result.scriptAgentRan, true);
  assert.equal(result.judgeAgentRan, true);
  assert.deepEqual(calls, [
    "classify",
    "capture",
    "compare-html",
    "increment-html-count",
    "script-agent",
    "extract",
    "compare-markdown",
    "judge-agent",
  ]);
});

test("runs only the judge when Markdown changes before the fifth HTML change", (): void => {
  const calls: string[] = [];
  const operations = makeOperations(calls, {
    htmlChanged: (): boolean => true,
    incrementHtmlChangeCount: (): number => 3,
    compareSnapshots: (): SnapshotComparison => CHANGED_COMPARISON,
  });

  const result = watchUrl(URL, "notify for new jobs", operations);

  assert.equal(result.scriptAgentRan, false);
  assert.equal(result.judgeAgentRan, true);
});

test("uses the script agent to set up a new URL", (): void => {
  const calls: string[] = [];
  let classification = 0;
  const operations = makeOperations(calls, {
    classifyUrl: () => {
      calls.push("classify");
      classification += 1;
      return classification === 1
        ? { state: "new", cacheDirectory: CACHE_DIRECTORY }
        : { state: "configured", cacheDirectory: CACHE_DIRECTORY };
    },
    compareSnapshots: (): SnapshotComparison => {
      calls.push("compare-markdown");
      return { state: "baseline", current: CURRENT_SNAPSHOT.replace(/\.html$/, ".md") };
    },
  });

  const result = watchUrl(URL, "notify for new jobs", operations);

  assert.equal(result.state, "set-up");
  assert.equal(result.scriptAgentRan, true);
  assert.deepEqual(calls, ["classify", "capture", "script-agent", "classify", "extract", "compare-markdown"]);
});

test("records each URL result exactly once", (): void => {
  const calls: string[] = [];
  const operations = makeOperations(calls);

  const results = watchUrls({ notificationTrigger: "notify for new jobs", urls: [URL] }, operations);

  assert.equal(results.length, 1);
  assert.equal(calls.filter((call: string): boolean => call.startsWith("record-")).length, 1);
  assert.equal(calls.at(-1), "record-success");
});
