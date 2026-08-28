import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import type { SnapshotComparison } from "../src/snapshots/compare.ts";
import {
  htmlChanged,
  incrementHtmlChangeCount,
  watchUrl,
  watchUrls,
  type UrlWatchOperations,
} from "../src/page-watch/watch-urls.ts";
import {
  runConcurrentPageChecks,
  urlLogTag,
} from "../src/page-watch/concurrent-page-checks.ts";

const URL = "https://example.com/jobs";
const SNAPSHOT_DIRECTORY = "snapshots/example";
const CURRENT_SNAPSHOT = "snapshots/example/snapshot-20260826T120000Z.html";
const UNCHANGED_COMPARISON: SnapshotComparison = {
  state: "unchanged",
  previous: "snapshots/example/snapshot-20260826T110000Z.md",
  current: "snapshots/example/snapshot-20260826T120000Z.md",
  diff: "",
};
const CHANGED_COMPARISON: SnapshotComparison = {
  state: "changed",
  previous: "snapshots/example/snapshot-20260826T110000Z.md",
  current: "snapshots/example/snapshot-20260826T120000Z.md",
  diff: "+New job",
};

function makeOperations(
  calls: string[],
  overrides: Partial<UrlWatchOperations> = {},
): UrlWatchOperations {
  return {
    classifyUrl: async (): Promise<Readonly<{ state: "configured"; snapshotDirectory: string }>> => {
      calls.push("classify");
      return { state: "configured", snapshotDirectory: SNAPSHOT_DIRECTORY };
    },
    capturePage: async (): Promise<string> => {
      calls.push("capture");
      return CURRENT_SNAPSHOT;
    },
    extractSnapshot: async (): Promise<string> => {
      calls.push("extract");
      return CURRENT_SNAPSHOT.replace(/\.html$/, ".md");
    },
    compareSnapshots: async (): Promise<SnapshotComparison> => {
      calls.push("compare-markdown");
      return UNCHANGED_COMPARISON;
    },
    htmlChanged: async (): Promise<boolean> => {
      calls.push("compare-html");
      return false;
    },
    incrementHtmlChangeCount: async (): Promise<number> => {
      calls.push("increment-html-count");
      return 1;
    },
    runScriptAgent: async (): Promise<void> => {
      calls.push("script-agent");
    },
    runJudgeAgent: async (): Promise<void> => {
      calls.push("judge-agent");
    },
    recordResult: async (_url: string, result: "success" | "failure"): Promise<void> => {
      calls.push(`record-${result}`);
    },
    collectExpiredSnapshots: async (): Promise<void> => {
      calls.push("collect-expired-snapshots");
    },
    ...overrides,
  };
}

test("detects whether the newest HTML snapshot changed", async (): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), "page-watch-html-"));
  try {
    const previous = join(directory, "snapshot-20260826T110000Z.html");
    const current = join(directory, "snapshot-20260826T120000Z.html");
    writeFileSync(previous, "<html>same</html>", "utf8");
    writeFileSync(current, "<html>same</html>", "utf8");
    assert.equal(await htmlChanged(directory, current), false);
    writeFileSync(current, "<html>changed</html>", "utf8");
    assert.equal(await htmlChanged(directory, current), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persists a separate HTML-change count in the URL snapshot directory", async (): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), "page-watch-count-"));
  try {
    assert.equal(await incrementHtmlChangeCount(directory), 1);
    assert.equal(await incrementHtmlChangeCount(directory), 2);
    assert.equal(await incrementHtmlChangeCount(directory), 3);
    assert.equal(await incrementHtmlChangeCount(directory), 4);
    assert.equal(await incrementHtmlChangeCount(directory), 5);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runs no agent when HTML and Markdown are unchanged", async (): Promise<void> => {
  const calls: string[] = [];
  const result = await watchUrl(URL, "notify for new jobs", makeOperations(calls));

  assert.deepEqual(result, {
    url: URL,
    state: "unchanged",
    htmlChanged: false,
    scriptAgentRan: false,
    judgeAgentRan: false,
  });
  assert.deepEqual(calls, ["classify", "capture", "compare-html", "extract", "compare-markdown"]);
});

test("runs the script agent on every fifth HTML change", async (): Promise<void> => {
  const calls: string[] = [];
  const operations = makeOperations(calls, {
    htmlChanged: async (): Promise<boolean> => {
      calls.push("compare-html");
      return true;
    },
    incrementHtmlChangeCount: async (): Promise<number> => {
      calls.push("increment-html-count");
      return 5;
    },
  });

  const result = await watchUrl(URL, "notify for new jobs", operations);

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

test("runs both agents when the fifth HTML change changes Markdown", async (): Promise<void> => {
  const calls: string[] = [];
  const operations = makeOperations(calls, {
    htmlChanged: async (): Promise<boolean> => {
      calls.push("compare-html");
      return true;
    },
    incrementHtmlChangeCount: async (): Promise<number> => {
      calls.push("increment-html-count");
      return 10;
    },
    compareSnapshots: async (): Promise<SnapshotComparison> => {
      calls.push("compare-markdown");
      return CHANGED_COMPARISON;
    },
  });

  const result = await watchUrl(URL, "notify for new jobs", operations);

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

test("runs only the judge when Markdown changes before the fifth HTML change", async (): Promise<void> => {
  const calls: string[] = [];
  const operations = makeOperations(calls, {
    htmlChanged: async (): Promise<boolean> => true,
    incrementHtmlChangeCount: async (): Promise<number> => 3,
    compareSnapshots: async (): Promise<SnapshotComparison> => CHANGED_COMPARISON,
  });

  const result = await watchUrl(URL, "notify for new jobs", operations);

  assert.equal(result.scriptAgentRan, false);
  assert.equal(result.judgeAgentRan, true);
});

test("uses the script agent to set up a new URL", async (): Promise<void> => {
  const calls: string[] = [];
  let classification = 0;
  const operations = makeOperations(calls, {
    classifyUrl: async (): Promise<Readonly<{ state: "new" | "configured"; snapshotDirectory: string }>> => {
      calls.push("classify");
      classification += 1;
      return classification === 1
        ? { state: "new", snapshotDirectory: SNAPSHOT_DIRECTORY }
        : { state: "configured", snapshotDirectory: SNAPSHOT_DIRECTORY };
    },
    compareSnapshots: async (): Promise<SnapshotComparison> => {
      calls.push("compare-markdown");
      return { state: "baseline", current: CURRENT_SNAPSHOT.replace(/\.html$/, ".md") };
    },
  });

  const result = await watchUrl(URL, "notify for new jobs", operations);

  assert.equal(result.state, "set-up");
  assert.equal(result.scriptAgentRan, true);
  assert.deepEqual(calls, ["classify", "capture", "script-agent", "classify", "extract", "compare-markdown"]);
});

test("records each URL result exactly once", async (): Promise<void> => {
  const calls: string[] = [];
  const operations = makeOperations(calls);

  const results = await watchUrls({ notificationTrigger: "notify for new jobs", urls: [URL] }, operations);

  assert.equal(results.length, 1);
  assert.equal(calls.filter((call: string): boolean => call.startsWith("record-")).length, 1);
  assert.equal(calls.at(-1), "collect-expired-snapshots");
});

test("collects expired snapshots after a failed poll cycle", async (): Promise<void> => {
  const calls: string[] = [];
  const operations = makeOperations(calls, {
    capturePage: async (): Promise<never> => {
      throw new Error("capture failed");
    },
  });

  await assert.rejects(
    watchUrls({ notificationTrigger: "notify for new jobs", urls: [URL] }, operations),
    /capture failed/,
  );
  assert.equal(calls.at(-1), "collect-expired-snapshots");
});

test("derives a stable three-letter log tag from the URL", (): void => {
  assert.match(urlLogTag(URL), /^[a-z]{3}$/);
  assert.equal(urlLogTag(URL), urlLogTag(URL));
  assert.notEqual(urlLogTag(URL), urlLogTag("https://example.org/jobs"));
});

test("runs at most three page checks at one time", async (): Promise<void> => {
  const urls = Array.from({ length: 7 }, (_value: unknown, index: number): string => `${URL}/${index}`);
  let activeChecks = 0;
  let maximumActiveChecks = 0;
  const releaseChecks: { resolve: (() => void) | null } = { resolve: null };
  const checksCanFinish = new Promise<void>((resolveChecks): void => {
    releaseChecks.resolve = resolveChecks;
  });
  const resultsPromise = runConcurrentPageChecks(
    { notificationTrigger: "notify for new jobs", urls },
    async (input) => {
      activeChecks += 1;
      maximumActiveChecks = Math.max(maximumActiveChecks, activeChecks);
      await checksCanFinish;
      activeChecks -= 1;
      return {
        state: "success",
        result: {
          url: input.url,
          state: "unchanged",
          htmlChanged: false,
          scriptAgentRan: false,
          judgeAgentRan: false,
        },
      };
    },
  );
  assert.equal(maximumActiveChecks, 3);
  if (releaseChecks.resolve === null) throw new Error("The test completion gate is not ready.");
  releaseChecks.resolve();
  const results = await resultsPromise;

  assert.deepEqual(results.map((result): string => result.url), urls);
});
