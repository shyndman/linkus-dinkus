import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { compareSnapshots, type SnapshotComparison } from "../src/snapshots/compare.ts";
import { extractSnapshot, readSnapshotJobCount, recordSnapshotInspection } from "../src/snapshots/extract.ts";
import { discardSnapshotAttempt } from "../src/snapshots/discard-attempt.ts";
import {
  htmlChanged,
  incrementHtmlChangeCount,
  rollbackHtmlChangeCount,
} from "../src/snapshots/change-tracking.ts";
import {
  CanonicalSnapshotPathSchema,
  HtmlSnapshotPathSchema,
  OrganizationNameSchema,
  SnapshotDirectorySchema,
} from "../src/page-watch/domain.ts";
import {
  readJudgmentResult,
  type JudgmentResult,
} from "../src/page-watch/judgment.ts";
import { readOrganizationName as readSavedOrganizationName } from "../src/page-watch/organization-name.ts";
import type {
  JudgeAgentTask,
  PageWatchDependencies,
  ScriptAgentTask,
  ZeroJobInspectionTask,
} from "../src/page-watch/ports.ts";
import { watchUrl, watchUrls } from "../src/page-watch/watch-urls.ts";
import {
  runConcurrentPageChecks,
  urlLogTag,
} from "../src/page-watch/concurrent-page-checks.ts";
import type { UrlState } from "../src/page-watch/url-state.ts";

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

type DependencyOverrides = Readonly<{
  classifyUrl: (url: string) => Promise<Readonly<{ state: UrlState; snapshotDirectory: string }>>;
  capturePage: (url: string, renderSettleMs: number) => Promise<string>;
  extractSnapshot: (snapshot: string) => Promise<string>;
  compareSnapshots: (snapshotDirectory: string) => Promise<SnapshotComparison>;
  htmlChanged: (snapshotDirectory: string, currentSnapshot: string) => Promise<boolean>;
  incrementHtmlChangeCount: (snapshotDirectory: string) => Promise<number>;
  readOrganizationName: (snapshotDirectory: string) => Promise<string | null>;
  runScriptAgent: (task: ScriptAgentTask) => Promise<void>;
  runJudgeAgent: (task: JudgeAgentTask) => Promise<JudgmentResult>;
  readJobCount: (snapshot: string) => Promise<number>;
  inspectZeroJobs: (task: ZeroJobInspectionTask) => Promise<JudgmentResult>;
  sendNotification: (text: string) => Promise<void>;
  recordResult: (url: string, result: "success" | "failure", detail: string | null) => Promise<void>;
  collectExpiredSnapshots: () => Promise<void>;
  discardSnapshotAttempt: (snapshot: string) => Promise<void>;
  rollbackHtmlChangeCount: (snapshotDirectory: string) => Promise<void>;
  waitForRetry: (milliseconds: number) => Promise<void>;
}>;

function makeDependencies(
  calls: string[],
  overrides: Partial<DependencyOverrides> = {},
): PageWatchDependencies {
  const classifyUrl = overrides.classifyUrl ?? (async () => {
    calls.push("classify");
    return { state: "configured" as const, snapshotDirectory: SNAPSHOT_DIRECTORY };
  });
  const capturePage = overrides.capturePage ?? (async () => {
    calls.push("capture");
    return CURRENT_SNAPSHOT;
  });
  const extractSnapshot = overrides.extractSnapshot ?? (async () => {
    calls.push("extract");
    return CURRENT_SNAPSHOT.replace(/\.html$/, ".md");
  });
  const compareSnapshots = overrides.compareSnapshots ?? (async () => {
    calls.push("compare-markdown");
    return UNCHANGED_COMPARISON;
  });
  const compareHtml = overrides.htmlChanged ?? (async () => {
    calls.push("compare-html");
    return false;
  });
  const incrementCount = overrides.incrementHtmlChangeCount ?? (async () => {
    calls.push("increment-html-count");
    return 1;
  });
  const readName = overrides.readOrganizationName ?? (async () => "Example Company");
  const runScriptAgent = overrides.runScriptAgent ?? (async () => {
    calls.push("script-agent");
  });
  const runJudgeAgent = overrides.runJudgeAgent ?? (async () => {
    calls.push("judge-agent");
    return { state: "not-matched" as const };
  });
  const sendNotification = overrides.sendNotification ?? (async (text: string) => {
    calls.push(`send-notification:${text}`);
  });
  const recordResult = overrides.recordResult ?? (async (_url: string, result: "success" | "failure") => {
    calls.push(`record-${result}`);
  });
  const collectExpired = overrides.collectExpiredSnapshots ?? (async () => {
    calls.push("collect-expired-snapshots");
  });
  const discardAttempt = overrides.discardSnapshotAttempt ?? (async (snapshot: string) => {
    calls.push(`discard-attempt:${snapshot}`);
  });
  const rollbackChangeCount = overrides.rollbackHtmlChangeCount ?? (async (snapshotDirectory: string) => {
    calls.push(`rollback-html-count:${snapshotDirectory}`);
  });
  const waitForRetry = overrides.waitForRetry ?? (async (milliseconds: number) => {
    calls.push(`wait-for-retry:${milliseconds}`);
  });


  return {
    pageState: {
      classify: async (url) => {
        const result = await classifyUrl(url);
        return {
          state: result.state,
          snapshotDirectory: SnapshotDirectorySchema.parse(result.snapshotDirectory),
        };
      },
      recordResult,
    },
    snapshots: {
      capture: async (url, renderSettleMs) => HtmlSnapshotPathSchema.parse(await capturePage(url, renderSettleMs)),
      extract: async (snapshot) => CanonicalSnapshotPathSchema.parse(await extractSnapshot(snapshot)),
      jobCount: overrides.readJobCount ?? (async () => 1),
      recordInspection: async () => {},
      compare: compareSnapshots,
      htmlChanged: compareHtml,
      incrementHtmlChangeCount: incrementCount,
      collectExpired,
      discardAttempt,
      rollbackHtmlChangeCount: rollbackChangeCount,
    },
    organizations: {
      read: async (snapshotDirectory) => {
        const name = await readName(snapshotDirectory);
        return name === null ? null : OrganizationNameSchema.parse(name);
      },
    },
    extractorAgent: { run: runScriptAgent },
    changeJudge: { run: runJudgeAgent },
    zeroJobInspector: {
      run: overrides.inspectZeroJobs ?? (async () => { throw new Error("Unexpected zero-job inspection"); }),
    },
    notifier: { send: sendNotification },
    retryClock: { wait: waitForRetry },
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
    await rollbackHtmlChangeCount(directory);
    assert.equal(await incrementHtmlChangeCount(directory), 5);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runs no agent when HTML and Markdown are unchanged", async (): Promise<void> => {
  const calls: string[] = [];
  const result = await watchUrl(URL, "notify for new jobs", makeDependencies(calls));

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
  const operations = makeDependencies(calls, {
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
  const operations = makeDependencies(calls, {
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
  const operations = makeDependencies(calls, {
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
  const operations = makeDependencies(calls, {
    compareSnapshots: async (): Promise<SnapshotComparison> => CHANGED_COMPARISON,
    runJudgeAgent: async (): Promise<JudgmentResult> => ({ state: "matched", text }),
  });

  const result = await watchUrl(URL, "notify for new jobs", operations);

  assert.deepEqual(result.judgment, { state: "matched", text });
  assert.ok(!calls.some((call: string): boolean => call.startsWith("send-notification:")));
});

test("keeps failed judgments out of accepted results and records the reason", async (): Promise<void> => {
  const calls: string[] = [];
  const text = "The extractor omitted the job links.";
  let recordedDetail: string | null = null;
  const operations = makeDependencies(calls, {
    compareSnapshots: async (): Promise<SnapshotComparison> => CHANGED_COMPARISON,
    runJudgeAgent: async (): Promise<JudgmentResult> => ({ state: "failure", text }),
    recordResult: async (_url, result, detail) => {
      assert.equal(result, "failure");
      recordedDetail = detail;
    },
  });

  const results = await watchUrls({ notificationTrigger: "notify for new jobs", urls: [URL] }, operations);
  assert.deepEqual(results, []);
  assert.equal(recordedDetail, text);
  assert.equal(calls.filter(call => call.startsWith("discard-attempt:")).length, 3);
  assert.ok(!calls.some(call => call.startsWith("send-notification:")));
});

test("sends one consolidated message with organization sections", async (): Promise<void> => {
  const calls: string[] = [];
  const firstUrl = `${URL}/first`;
  const secondUrl = `${URL}/second`;
  const operations = makeDependencies(calls, {
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
  const operations = makeDependencies(calls, {
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

  const results = await watchUrls({
    notificationTrigger: "notify for new jobs",
    urls: [matchedUrl, failedUrl],
  }, operations);
  assert.deepEqual(results.map(result => result.url), [matchedUrl]);

  assert.ok(calls.includes("send-notification:Matched Organization\nAdded matched role."));
  assert.ok(calls.includes("record-success"));
  assert.ok(calls.includes("record-failure"));
  assert.equal(calls.at(-1), "collect-expired-snapshots");
});

test("backfills an organization name without extractor setup", async (): Promise<void> => {
  const calls: string[] = [];
  let nameReadCount = 0;
  const operations = makeDependencies(calls, {
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
  const operations = makeDependencies(calls, {
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
  const operations = makeDependencies(calls);

  const results = await watchUrls({ notificationTrigger: "notify for new jobs", urls: [URL] }, operations);

  assert.equal(results.length, 1);
  assert.equal(calls.filter((call: string): boolean => call.startsWith("record-")).length, 1);
  assert.equal(calls.at(-1), "collect-expired-snapshots");
});

test("retries a page stream after extraction failures", async (): Promise<void> => {
  const calls: string[] = [];
  let extractionAttempts = 0;
  const dependencies = makeDependencies(calls, {
    htmlChanged: async (): Promise<boolean> => true,
    extractSnapshot: async (): Promise<string> => {
      calls.push("extract");
      extractionAttempts += 1;
      if (extractionAttempts < 3) throw new Error("job list was absent");
      return CURRENT_SNAPSHOT.replace(/\.html$/, ".md");
    },
  });

  const results = await watchUrls(
    { notificationTrigger: "notify for new jobs", urls: [URL] },
    dependencies,
  );

  assert.equal(results.length, 1);
  assert.equal(extractionAttempts, 3);
  assert.equal(calls.filter((call: string): boolean => call === "classify").length, 3);
  assert.equal(calls.filter((call: string): boolean => call === "capture").length, 3);
  assert.equal(calls.filter((call: string): boolean => call.startsWith("discard-attempt:")).length, 2);
  assert.equal(calls.filter((call: string): boolean => call === "increment-html-count").length, 3);
  assert.equal(calls.filter((call: string): boolean => call.startsWith("rollback-html-count:")).length, 2);
  assert.deepEqual(
    calls.filter((call: string): boolean => call.startsWith("wait-for-retry:")),
    ["wait-for-retry:10000", "wait-for-retry:10000"],
  );
  assert.equal(calls.filter((call: string): boolean => call === "record-success").length, 1);
});

test("recovers an incomplete capture with a longer render wait on retry", async (): Promise<void> => {
  const calls: string[] = [];
  const boardReadyMs = 20_000;
  let boardLoaded = false;
  let captureCount = 0;
  const dependencies = makeDependencies(calls, {
    capturePage: async (_url: string, renderSettleMs: number): Promise<string> => {
      captureCount += 1;
      boardLoaded = renderSettleMs >= boardReadyMs;
      return CURRENT_SNAPSHOT;
    },
    extractSnapshot: async (): Promise<string> => {
      if (!boardLoaded) throw new Error("BambooHR job board not found in snapshot");
      return CURRENT_SNAPSHOT.replace(/\.html$/, ".md");
    },
  });

  const results = await watchUrls(
    { notificationTrigger: "notify for new jobs", urls: [URL] },
    dependencies,
  );

  assert.equal(results[0]?.state, "unchanged");
  assert.equal(captureCount, 2);
  assert.equal(calls.includes("record-failure"), false);
});

test("finishes a poll with unresolved pages after recording their alerts", async (): Promise<void> => {
  const calls: string[] = [];
  const operations = makeDependencies(calls, {
    capturePage: async (): Promise<never> => {
      throw new Error("capture failed");
    },
  });

  const results = await watchUrls({ notificationTrigger: "notify for new jobs", urls: [URL] }, operations);
  assert.deepEqual(results, []);
  assert.equal(calls.at(-1), "collect-expired-snapshots");
  assert.equal(calls.filter((call: string): boolean => call === "classify").length, 3);
  assert.equal(calls.filter((call: string): boolean => call === "record-failure").length, 1);
  assert.deepEqual(
    calls.filter((call: string): boolean => call.startsWith("wait-for-retry:")),
    ["wait-for-retry:10000", "wait-for-retry:10000"],
  );
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
          organizationName: OrganizationNameSchema.parse("Example Company"),
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

test("accepts zero-job baselines and stable empty pages without inspection", async () => {
  const calls: string[] = [];
  const operations = makeDependencies(calls, {
    readJobCount: async () => 0,
    compareSnapshots: async () => ({ state: "baseline", current: UNCHANGED_COMPARISON.current }),
  });
  assert.equal((await watchUrl(URL, "new jobs", operations)).state, "baseline");
  const stable = makeDependencies(calls, { readJobCount: async () => 0 });
  assert.equal((await watchUrl(URL, "new jobs", stable)).state, "unchanged");
  assert.ok(!calls.some(call => call.startsWith("send-notification:")));
});

test("inspects a drop to zero and reports confirmed closure even for a new-job trigger", async () => {
  const calls: string[] = [];
  const operations = makeDependencies(calls, {
    compareSnapshots: async () => CHANGED_COMPARISON,
    readJobCount: async path => path === CHANGED_COMPARISON.current ? 0 : 4,
    inspectZeroJobs: async task => {
      assert.equal(task.previousJobCount, 4);
      return { state: "matched", text: "The complete career section is empty." };
    },
    runJudgeAgent: async () => { throw new Error("The confirmed closure must not use the new-job trigger"); },
  });
  const results = await watchUrls({ urls: [URL], notificationTrigger: "new jobs only" }, operations);
  assert.equal(results[0]?.judgment?.state, "matched");
  assert.ok(calls.some(call => call.includes("No jobs remain.") && call.startsWith("send-notification:")));
});

test("discards every unresolved zero capture and accepts the previous count on recovery", async () => {
  const calls: string[] = [];
  let currentCount = 0;
  let discarded = 0;
  const statuses: Array<Readonly<{ result: string; detail: string | null }>> = [];
  const operations = makeDependencies(calls, {
    compareSnapshots: async () => currentCount === 0 ? CHANGED_COMPARISON : UNCHANGED_COMPARISON,
    readJobCount: async path => path === CHANGED_COMPARISON.current ? currentCount : 4,
    inspectZeroJobs: async () => ({ state: "failure", text: "The job board shows a bot challenge." }),
    discardSnapshotAttempt: async () => { discarded += 1; },
    recordResult: async (_url, result, detail) => { statuses.push({ result, detail }); },
  });
  assert.deepEqual(await watchUrls({ urls: [URL], notificationTrigger: "new jobs" }, operations), []);
  assert.equal(discarded, 3);
  assert.deepEqual(statuses, [{ result: "failure", detail: "The job board shows a bot challenge." }]);
  currentCount = 4;
  const results = await watchUrls({ urls: [URL], notificationTrigger: "new jobs" }, operations);
  assert.equal(results[0]?.state, "unchanged");
  assert.deepEqual(statuses[1], { result: "success", detail: null });
  assert.ok(!calls.some(call => call.startsWith("send-notification:")));
});

test("retains the accepted files across an unresolved zero-job incident", async () => {
  const directory = mkdtempSync(join(tmpdir(), "page-watch-zero-"));
  const previous = join(directory, "snapshot-20260826T110000Z.html");
  const current = join(directory, "snapshot-20260826T120000Z.html");
  const extractor = resolve("snapshots/https-apply-workable-com-veritree/extract.ts");
  const completePage = (jobs: string): string =>
    `<html><body><ul data-ui="list">${jobs}</ul></body></html>`;
  const jobs = '<li data-ui="job"><a href="/jobs/biologist"><h3 data-ui="job-title"><span>Biologist</span></h3></a></li>';
  let capturedJobs = "";
  const calls: string[] = [];
  try {
    writeFileSync(join(directory, "extract"), `#!/bin/sh\nexec "${process.execPath}" --import tsx "${extractor}" "$@"\n`, { mode: 0o755 });
    writeFileSync(previous, completePage(jobs));
    const acceptedMarkdown = await extractSnapshot(previous);
    const operations = makeDependencies(calls, {
      classifyUrl: async () => ({ state: "configured", snapshotDirectory: directory }),
      capturePage: async () => {
        writeFileSync(current, completePage(capturedJobs));
        return current;
      },
      extractSnapshot,
      compareSnapshots,
      readJobCount: readSnapshotJobCount,
      inspectZeroJobs: async () => ({ state: "failure", text: "The live board remains uncertain." }),
      discardSnapshotAttempt: async snapshot => discardSnapshotAttempt(HtmlSnapshotPathSchema.parse(snapshot)),
    });
    const dependencies: PageWatchDependencies = {
      ...operations,
      snapshots: { ...operations.snapshots, recordInspection: recordSnapshotInspection },
    };
    assert.deepEqual(await watchUrls({ urls: [URL], notificationTrigger: "new jobs" }, dependencies), []);
    assert.equal(existsSync(current), false);
    assert.equal(existsSync(current.replace(".html", ".md")), false);
    assert.equal(existsSync(acceptedMarkdown), true);
    assert.equal(await readSnapshotJobCount(acceptedMarkdown), 1);
    const retained = await compareSnapshots(directory);
    assert.equal(retained.state, "baseline");
    capturedJobs = jobs;
    const recovered = await watchUrls({ urls: [URL], notificationTrigger: "new jobs" }, dependencies);
    assert.equal(recovered[0]?.state, "unchanged");
    assert.ok(!calls.some(call => call.startsWith("send-notification:")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("surfaces notification delivery failures instead of classifying them as unresolved pages", async () => {
  const calls: string[] = [];
  const results: string[] = [];
  const dependencies = makeDependencies(calls, {
    recordResult: async (_url, result) => {
      results.push(result);
      throw new Error("Telegram delivery failed");
    },
  });
  await assert.rejects(watchUrls({ urls: [URL], notificationTrigger: "new jobs" }, dependencies), /Telegram delivery failed/);
  assert.deepEqual(results, ["success"]);
});
