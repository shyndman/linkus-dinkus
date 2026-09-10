import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { APPLICATION_CONFIG } from "../src/config.ts";
import { compareSnapshots, type SnapshotComparison } from "../src/snapshots/compare.ts";
import { extractSnapshot, readSnapshotJobCount, recordSnapshotInspection } from "../src/snapshots/extract.ts";
import { discardSnapshotAttempt } from "../src/snapshots/discard-attempt.ts";
import { extractorAuditDue, recordExtractorAudit } from "../src/snapshots/extractor-audit.ts";
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
  extractorAuditDue: (snapshotDirectory: string) => Promise<boolean>;
  recordExtractorAudit: (snapshotDirectory: string) => Promise<void>;
  readOrganizationName: (snapshotDirectory: string) => Promise<string | null>;
  runScriptAgent: (task: ScriptAgentTask) => Promise<void>;
  runJudgeAgent: (task: JudgeAgentTask) => Promise<JudgmentResult>;
  readJobCount: (snapshot: string) => Promise<number>;
  inspectZeroJobs: (task: ZeroJobInspectionTask) => Promise<JudgmentResult>;
  sendNotification: (text: string) => Promise<void>;
  recordResult: (url: string, result: "success" | "failure", detail: string | null) => Promise<void>;
  collectExpiredSnapshots: () => Promise<void>;
  discardSnapshotAttempt: (snapshot: string) => Promise<void>;
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
  const auditDue = overrides.extractorAuditDue ?? (async () => false);
  const recordAudit = overrides.recordExtractorAudit ?? (async () => {
    calls.push("record-audit");
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
      collectExpired,
      discardAttempt,
    },
    extractorAudits: { isDue: auditDue, recordSuccess: recordAudit },
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

test("persists the audit schedule and makes an audit due at the seven-day boundary", async (): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), "page-watch-audit-"));
  const completedAt = Date.parse("2026-09-10T12:00:00.000Z");
  const nextAuditAt = Date.parse("2026-09-17T12:00:00.000Z");
  try {
    assert.equal(await extractorAuditDue(directory, completedAt), true);
    await recordExtractorAudit(directory, completedAt);
    assert.equal(await extractorAuditDue(directory, nextAuditAt - 1), false);
    assert.equal(await extractorAuditDue(directory, nextAuditAt), true);
    await recordExtractorAudit(directory, nextAuditAt);
    assert.equal(await extractorAuditDue(directory, nextAuditAt), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runs no agent when Markdown is unchanged and no audit is due", async (): Promise<void> => {
  const calls: string[] = [];
  const result = await watchUrl(URL, "notify for new jobs", makeDependencies(calls));
  assert.equal(result.state, "unchanged");
  assert.equal(result.scriptAgentRan, false);
  assert.equal(result.judgment, null);
  assert.ok(!calls.includes("script-agent"));
  assert.ok(!calls.includes("judge-agent"));
});

test("audits unchanged pages only when the saved schedule expires", async (): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), "page-watch-scheduled-audit-"));
  const calls: string[] = [];
  let now = Date.parse("2026-09-10T12:00:00.000Z");
  const operations = makeDependencies(calls, {
    extractorAuditDue: async () => extractorAuditDue(directory, now),
    recordExtractorAudit: async () => recordExtractorAudit(directory, now),
  });
  try {
    await recordExtractorAudit(directory, now);
    assert.equal((await watchUrl(URL, "new jobs", operations)).scriptAgentRan, false);
    now = Date.parse("2026-09-17T12:00:00.000Z");
    assert.equal((await watchUrl(URL, "new jobs", operations)).scriptAgentRan, true);
    assert.equal((await watchUrl(URL, "new jobs", operations)).scriptAgentRan, false);
    assert.equal(calls.filter(call => call === "script-agent").length, 1);
    assert.ok(!calls.includes("judge-agent"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps an audit due after failure and schedules it only after a successful retry", async (): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), "page-watch-failed-audit-"));
  const calls: string[] = [];
  let failAudit = true;
  const operations = makeDependencies(calls, {
    extractorAuditDue: async () => extractorAuditDue(directory),
    recordExtractorAudit: async () => recordExtractorAudit(directory),
    runScriptAgent: async () => {
      if (failAudit) throw new Error("The captured job board is incomplete.");
    },
  });
  try {
    await assert.rejects(watchUrl(URL, "new jobs", operations), /job board is incomplete/);
    assert.equal(await extractorAuditDue(directory), true);
    failAudit = false;
    assert.equal((await watchUrl(URL, "new jobs", operations)).scriptAgentRan, true);
    assert.equal(await extractorAuditDue(directory), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("judges changed Markdown after a scheduled audit", async (): Promise<void> => {
  const calls: string[] = [];
  const operations = makeDependencies(calls, {
    extractorAuditDue: async () => true,
    compareSnapshots: async () => CHANGED_COMPARISON,
  });
  const result = await watchUrl(URL, "notify for new jobs", operations);
  assert.equal(result.scriptAgentRan, true);
  assert.deepEqual(result.judgment, { state: "not-matched" });
  assert.equal(calls.filter(call => call === "judge-agent").length, 1);
});

test("runs only the judge when Markdown changes before the next audit", async (): Promise<void> => {
  const calls: string[] = [];
  const operations = makeDependencies(calls, {
    compareSnapshots: async () => CHANGED_COMPARISON,
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
  assert.ok(calls.includes("record-audit"));
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
    extractorAuditDue: async (): Promise<boolean> => true,
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
  assert.equal(calls.filter((call: string): boolean => call === "record-audit").length, 1);
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

test("limits active page checks to the configured concurrency", async (): Promise<void> => {
  const concurrency = APPLICATION_CONFIG.pageChecks.concurrency;
  const urls = Array.from({ length: concurrency + 1 }, (_value: unknown, index: number): string => `${URL}/${index}`);
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
          scriptAgentRan: false,
          judgment: null,
        },
      };
    },
  );
  assert.equal(maximumActiveChecks, concurrency);
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
