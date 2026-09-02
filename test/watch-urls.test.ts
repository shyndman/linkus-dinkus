import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import type { SnapshotComparison } from "../src/snapshots/compare.ts";
import {
  readJudgmentResult,
  type JudgmentResult,
} from "../src/page-watch/judgment.ts";
import { readOrganizationName as readSavedOrganizationName } from "../src/page-watch/organization-name.ts";
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
    readOrganizationName: async (): Promise<string> => "Example Company",
    runScriptAgent: async (): Promise<void> => {
      calls.push("script-agent");
    },
    runJudgeAgent: async (): Promise<JudgmentResult> => {
      calls.push("judge-agent");
      return { state: "not-matched" };
    },
    sendNotification: async (text: string): Promise<void> => {
      calls.push(`send-notification:${text}`);
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
    organizationName: "Example Company",
    state: "unchanged",
    htmlChanged: false,
    scriptAgentRan: false,
    judgment: null,
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
  assert.equal(result.judgment, null);
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
  assert.deepEqual(result.judgment, { state: "not-matched" });
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
  assert.deepEqual(result.judgment, { state: "not-matched" });
});

test("returns matched judgment text without sending it", async (): Promise<void> => {
  const calls: string[] = [];
  const text = "New role: Engineer\nhttps://example.com/jobs/engineer";
  const operations = makeOperations(calls, {
    compareSnapshots: async (): Promise<SnapshotComparison> => CHANGED_COMPARISON,
    runJudgeAgent: async (): Promise<JudgmentResult> => ({ state: "matched", text }),
  });

  const result = await watchUrl(URL, "notify for new jobs", operations);

  assert.deepEqual(result.judgment, { state: "matched", text });
  assert.ok(!calls.some((call: string): boolean => call.startsWith("send-notification:")));
});

test("sends failure judgment text and keeps the URL check successful", async (): Promise<void> => {
  const calls: string[] = [];
  const text = "The extractor omitted the job links.";
  const operations = makeOperations(calls, {
    compareSnapshots: async (): Promise<SnapshotComparison> => CHANGED_COMPARISON,
    runJudgeAgent: async (): Promise<JudgmentResult> => ({ state: "failure", text }),
  });

  await watchUrls({ notificationTrigger: "notify for new jobs", urls: [URL] }, operations);

  assert.ok(calls.includes(`send-notification:${text}`));
  assert.ok(calls.includes("record-success"));
  assert.ok(!calls.includes("record-failure"));
});

test("sends one consolidated message with organization sections", async (): Promise<void> => {
  const calls: string[] = [];
  const firstUrl = `${URL}/first`;
  const secondUrl = `${URL}/second`;
  const operations = makeOperations(calls, {
    classifyUrl: async (url: string): Promise<Readonly<{ state: "configured"; snapshotDirectory: string }>> => ({
      state: "configured",
      snapshotDirectory: url === firstUrl ? "snapshots/first" : "snapshots/second",
    }),
    readOrganizationName: async (snapshotDirectory: string): Promise<string> => (
      snapshotDirectory === "snapshots/first" ? "First Organization" : "Second Organization"
    ),
    compareSnapshots: async (): Promise<SnapshotComparison> => CHANGED_COMPARISON,
    runJudgeAgent: async (task): Promise<JudgmentResult> => ({
      state: "matched",
      text: task.organizationName === "First Organization" ? "Added first role." : "Added second role.",
    }),
  });

  await watchUrls({
    notificationTrigger: "notify for new jobs",
    urls: [firstUrl, secondUrl],
  }, operations);

  const notificationCalls = calls.filter((call: string): boolean => call.startsWith("send-notification:"));
  assert.deepEqual(notificationCalls, [
    "send-notification:First Organization\nAdded first role.\n\nSecond Organization\nAdded second role.",
  ]);
});

test("sends matched judgments when another page check fails", async (): Promise<void> => {
  const calls: string[] = [];
  const matchedUrl = `${URL}/matched`;
  const failedUrl = `${URL}/failed`;
  const operations = makeOperations(calls, {
    classifyUrl: async (url: string): Promise<Readonly<{ state: "configured"; snapshotDirectory: string }>> => ({
      state: "configured",
      snapshotDirectory: url === failedUrl ? "snapshots/failed" : "snapshots/matched",
    }),
    capturePage: async (url: string): Promise<string> => {
      if (url === failedUrl) throw new Error("capture failed");
      return CURRENT_SNAPSHOT;
    },
    readOrganizationName: async (): Promise<string> => "Matched Organization",
    compareSnapshots: async (): Promise<SnapshotComparison> => CHANGED_COMPARISON,
    runJudgeAgent: async (): Promise<JudgmentResult> => ({
      state: "matched",
      text: "Added matched role.",
    }),
  });

  await assert.rejects(
    watchUrls({
      notificationTrigger: "notify for new jobs",
      urls: [matchedUrl, failedUrl],
    }, operations),
    /capture failed/,
  );

  assert.ok(calls.includes("send-notification:Matched Organization\nAdded matched role."));
  assert.ok(calls.includes("record-success"));
  assert.ok(calls.includes("record-failure"));
  assert.equal(calls.at(-1), "collect-expired-snapshots");
});

test("backfills an organization name without extractor setup", async (): Promise<void> => {
  const calls: string[] = [];
  let nameReadCount = 0;
  const operations = makeOperations(calls, {
    readOrganizationName: async (): Promise<string | null> => {
      nameReadCount += 1;
      return nameReadCount === 1 ? null : "Backfilled Organization";
    },
    runScriptAgent: async (task): Promise<void> => {
      calls.push(`script-agent:${task.reason}`);
    },
  });

  const result = await watchUrl(URL, "notify for new jobs", operations);

  assert.equal(result.organizationName, "Backfilled Organization");
  assert.equal(result.scriptAgentRan, true);
  assert.ok(calls.includes("script-agent:organization-name"));
  assert.ok(!calls.includes("script-agent:setup"));
});

test("reads a saved one-line organization name", async (): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), "page-watch-organization-name-test-"));
  try {
    writeFileSync(join(directory, "organization-name.txt"), "Example Organization\n", "utf8");
    assert.equal(await readSavedOrganizationName(directory), "Example Organization");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects an invalid saved judgment", async (): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), "page-watch-judgment-test-"));
  const resultPath = join(directory, "result.json");
  try {
    writeFileSync(resultPath, JSON.stringify({ state: "not-matched", text: "unexpected" }), "utf8");
    await assert.rejects(readJudgmentResult(resultPath));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
          organizationName: "Example Company",
          state: "unchanged",
          htmlChanged: false,
          scriptAgentRan: false,
          judgment: null,
        },
      };
    },
  );
  assert.equal(maximumActiveChecks, 3);
  if (releaseChecks.resolve === null) throw new Error("The test completion gate is not ready.");
  releaseChecks.resolve();
  const outcome = await resultsPromise;

  assert.deepEqual(outcome.results.map((result): string => result.url), urls);
  assert.deepEqual(outcome.failures, []);
});
