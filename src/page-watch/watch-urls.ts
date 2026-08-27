import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { errorDetail, logger } from "../logger.ts";
import { PROJECT_ROOT, runTool } from "../runtime.ts";

const SCRIPT_AGENT_MODEL = "openai-codex/gpt-5.6-sol";
const JUDGE_AGENT_MODEL = "openrouter/z-ai/glm-5.3-flash";
const SCRIPT_AGENT_MAX_TIME_SECONDS = "900";
const JUDGE_AGENT_MAX_TIME_SECONDS = "900";
const HTML_CHANGE_REVIEW_INTERVAL = 5;
const HTML_CHANGE_COUNT_FILE = "html-change-count.txt";
const HTML_SNAPSHOT_PATTERN = /^snapshot-\d{8}T\d{6}Z\.html$/;

const UrlStateResultSchema = z.object({
  state: z.enum(["new", "incomplete", "configured"]),
  cacheDirectory: z.string(),
});
const BaselineComparisonSchema = z.object({
  state: z.literal("baseline"),
  current: z.string(),
});
const UnchangedComparisonSchema = z.object({
  state: z.literal("unchanged"),
  previous: z.string(),
  current: z.string(),
  diff: z.string(),
});
const ChangedComparisonSchema = z.object({
  state: z.literal("changed"),
  previous: z.string(),
  current: z.string(),
  diff: z.string(),
});
const SnapshotComparisonSchema = z.discriminatedUnion("state", [
  BaselineComparisonSchema,
  UnchangedComparisonSchema,
  ChangedComparisonSchema,
]);

type UrlStateResult = z.infer<typeof UrlStateResultSchema>;
export type SnapshotComparison = z.infer<typeof SnapshotComparisonSchema>;
export type ScriptAgentTask = Readonly<{
  reason: "setup" | "fifth-html-change";
  url: string;
  notificationTrigger: string;
  cacheDirectory: string;
  currentSnapshot: string;
}>;
export type JudgeAgentTask = Readonly<{
  url: string;
  notificationTrigger: string;
  cacheDirectory: string;
  currentSnapshot: string;
  comparison: z.infer<typeof ChangedComparisonSchema>;
}>;
export type UrlWatchOperations = Readonly<{
  classifyUrl: (url: string) => UrlStateResult;
  capturePage: (url: string) => string;
  extractSnapshot: (snapshot: string) => string;
  compareSnapshots: (cacheDirectory: string) => SnapshotComparison;
  htmlChanged: (cacheDirectory: string, currentSnapshot: string) => boolean;
  incrementHtmlChangeCount: (cacheDirectory: string) => number;
  runScriptAgent: (task: ScriptAgentTask) => void;
  runJudgeAgent: (task: JudgeAgentTask) => void;
  recordResult: (url: string, result: "success" | "failure") => void;
}>;
export type UrlWatchResult = Readonly<{
  url: string;
  state: "set-up" | "baseline" | "unchanged" | "changed";
  htmlChanged: boolean;
  scriptAgentRan: boolean;
  judgeAgentRan: boolean;
}>;

type WatchInput = Readonly<{
  notificationTrigger: string;
  urls: readonly string[];
}>;

function parseCommandJson<T>(output: string, schema: z.ZodType<T>, command: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error: unknown) {
    throw new Error(`${command} returned invalid JSON: ${output}`, { cause: error });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error(`${command} returned an invalid result: ${output}`);
  return result.data;
}

function classifyUrl(url: string): UrlStateResult {
  const output = runTool("bin/url-state", [url]).trim();
  return parseCommandJson(output, UrlStateResultSchema, "bin/url-state");
}

function capturePage(url: string): string {
  return runTool("bin/capture-page", [url]).trim();
}

function extractSnapshot(snapshot: string): string {
  return runTool("bin/extract-snapshot", [snapshot]).trim();
}

function compareSnapshots(cacheDirectory: string): SnapshotComparison {
  const output = runTool("bin/compare-snapshots", [cacheDirectory]).trim();
  return parseCommandJson(output, SnapshotComparisonSchema, "bin/compare-snapshots");
}

function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);
}

export function htmlChanged(cacheDirectory: string, currentSnapshot: string): boolean {
  const directory = absolutePath(cacheDirectory);
  const currentName = basename(currentSnapshot);
  const snapshots = readdirSync(directory)
    .filter((name: string): boolean => HTML_SNAPSHOT_PATTERN.test(name))
    .sort();
  logger.info(`Found ${snapshots.length} HTML snapshots while checking ${currentName}.`);
  const currentIndex = snapshots.indexOf(currentName);
  if (currentIndex === -1) {
    logger.error(`${currentName} is missing from ${cacheDirectory}.`);
    throw new Error(`Current HTML snapshot is absent from ${cacheDirectory}: ${currentSnapshot}`);
  }
  if (currentIndex === 0) {
    logger.info(`${currentName} is the first HTML snapshot, so there is no earlier page to compare.`);
    return false;
  }

  const previousName = snapshots[currentIndex - 1];
  if (previousName === undefined) return false;
  const previous = readFileSync(join(directory, previousName));
  const current = readFileSync(join(directory, currentName));
  const changed = !previous.equals(current);
  logger.info(
    changed
      ? `${currentName} differs from ${previousName}. Their sizes are ${current.byteLength} and ${previous.byteLength} bytes.`
      : `${currentName} matches ${previousName} byte for byte at ${current.byteLength} bytes.`,
  );
  return changed;
}

export function incrementHtmlChangeCount(cacheDirectory: string): number {
  const directory = absolutePath(cacheDirectory);
  const countPath = join(directory, HTML_CHANGE_COUNT_FILE);
  let previous = 0;
  try {
    const text = readFileSync(countPath, "utf8").trim();
    if (!/^(0|[1-9]\d*)$/.test(text)) {
      logger.error(`${HTML_CHANGE_COUNT_FILE} contains an invalid change count.`);
      throw new Error(`${countPath} does not contain a nonnegative integer`);
    }
    previous = Number(text);
    logger.info(`The saved HTML change count is ${previous}.`);
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    logger.info("No HTML change count exists yet. The count starts at zero.");
  }
  const next = previous + 1;
  mkdirSync(directory, { recursive: true });
  writeFileSync(countPath, `${next}\n`, "utf8");
  logger.info(`Saved an HTML change count of ${next}.`);
  return next;
}

function runOmpAgent(model: string, thinking: "high" | "xhigh", maxTime: string, prompt: string): void {
  const startedAt = performance.now();
  logger.info(`Starting an agent with ${model} and a ${maxTime}-second time limit.`);
  const result: SpawnSyncReturns<Buffer> = spawnSync("omp", [
    "--model", model,
    `--thinking=${thinking}`,
    `--max-time=${maxTime}`,
    "--print",
    "--mode=text",
    "--no-session",
    prompt,
  ], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.error) {
    logger.error(`The agent could not start. ${result.error.message}`);
    throw new Error(`omp failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    logger.error(`The agent failed after ${Math.round(performance.now() - startedAt)} milliseconds with status ${String(result.status)}.`);
    throw new Error(`omp failed with exit status ${result.status}`);
  }
  logger.info(`The agent finished after ${Math.round(performance.now() - startedAt)} milliseconds.`);
}

function runScriptAgent(task: ScriptAgentTask): void {
  const action = task.reason === "setup"
    ? "Create and test the extractor for this new or incomplete URL."
    : "Examine the saved extractor against the current HTML and extracted output. Fix and test it only if it is wrong.";
  logger.info(
    task.reason === "setup"
      ? `Starting extractor setup for ${basename(task.currentSnapshot)}.`
      : `Starting the scheduled extractor audit for ${basename(task.currentSnapshot)}.`,
  );
  const prompt = [
    "Act only as the extractor agent described in AGENTS.md.",
    action,
    "Do not evaluate notification conditions and do not send notifications.",
    `Task: ${JSON.stringify(task)}`,
  ].join("\n");
  runOmpAgent(SCRIPT_AGENT_MODEL, "xhigh", SCRIPT_AGENT_MAX_TIME_SECONDS, prompt);
  logger.info(task.reason === "setup" ? "The extractor setup finished." : "The extractor audit finished.");
}

function runJudgeAgent(task: JudgeAgentTask): void {
  logger.info(`Starting the change judge for ${basename(task.currentSnapshot)}.`);
  const prompt = [
    "Act only as the change judge described in AGENTS.md.",
    "Evaluate the supplied Markdown difference against notificationTrigger.",
    "Send a notification only when the difference matches the trigger.",
    `Task: ${JSON.stringify(task)}`,
  ].join("\n");
  runOmpAgent(JUDGE_AGENT_MODEL, "high", JUDGE_AGENT_MAX_TIME_SECONDS, prompt);
  logger.info("The change judge finished.");
}

function recordResult(url: string, result: "success" | "failure"): void {
  runTool("bin/record-url-result", [url, result]);
}

export const DEFAULT_URL_WATCH_OPERATIONS: UrlWatchOperations = {
  classifyUrl,
  capturePage,
  extractSnapshot,
  compareSnapshots,
  htmlChanged,
  incrementHtmlChangeCount,
  runScriptAgent,
  runJudgeAgent,
  recordResult,
};

function setUpUrl(
  url: string,
  notificationTrigger: string,
  initialState: UrlStateResult,
  operations: UrlWatchOperations,
): UrlWatchResult {
  logger.info(`Setting up a ${initialState.state} page in ${initialState.cacheDirectory}.`);
  const currentSnapshot = operations.capturePage(url);
  logger.info(`Captured ${basename(currentSnapshot)} for extractor setup.`);
  operations.runScriptAgent({
    reason: "setup",
    url,
    notificationTrigger,
    cacheDirectory: initialState.cacheDirectory,
    currentSnapshot,
  });
  const configured = operations.classifyUrl(url);
  logger.info(`The extractor setup left the page in the ${configured.state} state.`);
  if (configured.state !== "configured") throw new Error(`The extractor agent did not configure ${url}`);
  const canonicalSnapshot = operations.extractSnapshot(currentSnapshot);
  logger.info(`Created ${basename(canonicalSnapshot)} with the new extractor.`);
  const comparison = operations.compareSnapshots(configured.cacheDirectory);
  logger.info(`The setup comparison result is ${comparison.state}.`);
  if (initialState.state === "new" && comparison.state !== "baseline") {
    throw new Error(`The first canonical snapshot for ${url} was not a baseline`);
  }
  return {
    url,
    state: "set-up",
    htmlChanged: false,
    scriptAgentRan: true,
    judgeAgentRan: false,
  };
}
function auditExtractorAfterHtmlChange(
  didHtmlChange: boolean,
  url: string,
  notificationTrigger: string,
  cacheDirectory: string,
  currentSnapshot: string,
  operations: UrlWatchOperations,
): boolean {
  if (!didHtmlChange) return false;
  const count = operations.incrementHtmlChangeCount(cacheDirectory);
  const auditDue = count % HTML_CHANGE_REVIEW_INTERVAL === 0;
  logger.info(
    auditDue
      ? `HTML change ${count} requires the scheduled extractor audit.`
      : `HTML change ${count} does not require an extractor audit. The audit interval is ${HTML_CHANGE_REVIEW_INTERVAL} changes.`,
  );
  if (!auditDue) return false;
  operations.runScriptAgent({
    reason: "fifth-html-change",
    url,
    notificationTrigger,
    cacheDirectory,
    currentSnapshot,
  });
  return true;
}


function watchConfiguredUrl(
  url: string,
  notificationTrigger: string,
  urlState: UrlStateResult,
  operations: UrlWatchOperations,
): UrlWatchResult {
  logger.info(`Checking a configured page in ${urlState.cacheDirectory}.`);
  const currentSnapshot = operations.capturePage(url);
  logger.info(`Captured ${basename(currentSnapshot)}.`);
  const didHtmlChange = operations.htmlChanged(urlState.cacheDirectory, currentSnapshot);
  logger.info(didHtmlChange ? "The rendered HTML changed." : "The rendered HTML did not change.");
  const scriptAgentRan = auditExtractorAfterHtmlChange(
    didHtmlChange,
    url,
    notificationTrigger,
    urlState.cacheDirectory,
    currentSnapshot,
    operations,
  );

  const canonicalSnapshot = operations.extractSnapshot(currentSnapshot);
  logger.info(`Created ${basename(canonicalSnapshot)}.`);
  const comparison = operations.compareSnapshots(urlState.cacheDirectory);
  logger.info(`The canonical comparison result is ${comparison.state}.`);
  if (comparison.state !== "changed") {
    logger.info("The change judge is not needed.");
    return {
      url,
      state: comparison.state,
      htmlChanged: didHtmlChange,
      scriptAgentRan,
      judgeAgentRan: false,
    };
  }

  logger.info(`The canonical difference contains ${Buffer.byteLength(comparison.diff)} bytes. The change judge is required.`);
  operations.runJudgeAgent({
    url,
    notificationTrigger,
    cacheDirectory: urlState.cacheDirectory,
    currentSnapshot,
    comparison,
  });
  return {
    url,
    state: "changed",
    htmlChanged: didHtmlChange,
    scriptAgentRan,
    judgeAgentRan: true,
  };
}

export function watchUrl(
  url: string,
  notificationTrigger: string,
  operations: UrlWatchOperations = DEFAULT_URL_WATCH_OPERATIONS,
): UrlWatchResult {
  const state = operations.classifyUrl(url);
  logger.info(`Classified the page as ${state.state} in ${state.cacheDirectory}.`);
  return state.state === "configured"
    ? watchConfiguredUrl(url, notificationTrigger, state, operations)
    : setUpUrl(url, notificationTrigger, state, operations);
}

export function watchUrls(
  input: WatchInput,
  operations: UrlWatchOperations = DEFAULT_URL_WATCH_OPERATIONS,
): readonly UrlWatchResult[] {
  logger.info(`Starting ${input.urls.length} page checks.`);
  const results: UrlWatchResult[] = [];
  const failures: string[] = [];
  for (const [index, url] of input.urls.entries()) {
    logger.info(`Starting page check ${index + 1} of ${input.urls.length}.`);
    try {
      const result = watchUrl(url, input.notificationTrigger, operations);
      operations.recordResult(url, "success");
      logger.info(`Page check ${index + 1} finished with the ${result.state} result.`);
      results.push(result);
    } catch (error: unknown) {
      const detail = errorDetail(error);
      logger.error(`Page check ${index + 1} failed. ${detail}`);
      failures.push(`${url}: ${detail}`);
      try {
        operations.recordResult(url, "failure");
        logger.info(`Recorded the failure for page check ${index + 1}.`);
      } catch (recordError: unknown) {
        const recordDetail = errorDetail(recordError);
        logger.error(`Could not record the failure for page check ${index + 1}. ${recordDetail}`);
        failures.push(`${url}: could not record failure: ${recordDetail}`);
      }
    }
  }
  if (failures.length > 0) {
    logger.error(`${failures.length} of ${input.urls.length} page checks failed.`);
    throw new Error(`URL watch failures:\n${failures.join("\n")}`);
  }
  logger.info(`All ${results.length} page checks finished successfully.`);
  return results;
}
