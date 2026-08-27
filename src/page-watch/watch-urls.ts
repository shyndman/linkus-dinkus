import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { logger, errorDetail } from "../logger.ts";
import { PROJECT_ROOT } from "../runtime.ts";
import { capturePage } from "../snapshots/capture.ts";
import {
  compareSnapshots,
  type ChangedComparison,
  type SnapshotComparison,
} from "../snapshots/compare.ts";
import { extractSnapshot } from "../snapshots/extract.ts";
import { collectExpiredSnapshots } from "../snapshots/collect.ts";
import { recordUrlResult, type UrlResult } from "./record-result.ts";
import { getUrlState, type UrlStateResult } from "./url-state.ts";

const AGENT_MODEL = "openrouter/z-ai/glm-5.3-flash";
const SCRIPT_AGENT_MAX_TIME_SECONDS = "900";
const JUDGE_AGENT_MAX_TIME_SECONDS = "900";
const HTML_CHANGE_REVIEW_INTERVAL = 5;
const HTML_CHANGE_COUNT_FILE = "html-change-count.txt";
const HTML_SNAPSHOT_PATTERN = /^snapshot-\d{8}T\d{6}Z\.html$/;
const STYLED_OMP_RUNNER_PATH = resolve(PROJECT_ROOT, "src", "integrations", "run-omp-with-styled-output.ts");

export type ScriptAgentTask = Readonly<{
  reason: "setup" | "fifth-html-change";
  url: string;
  notificationTrigger: string;
  snapshotDirectory: string;
  currentSnapshot: string;
}>;
export type JudgeAgentTask = Readonly<{
  url: string;
  notificationTrigger: string;
  snapshotDirectory: string;
  currentSnapshot: string;
  comparison: ChangedComparison;
}>;
export type UrlWatchOperations = Readonly<{
  classifyUrl: (url: string) => UrlStateResult;
  capturePage: (url: string) => string;
  extractSnapshot: (snapshot: string) => string;
  compareSnapshots: (snapshotDirectory: string) => SnapshotComparison;
  htmlChanged: (snapshotDirectory: string, currentSnapshot: string) => boolean;
  incrementHtmlChangeCount: (snapshotDirectory: string) => number;
  runScriptAgent: (task: ScriptAgentTask) => void;
  runJudgeAgent: (task: JudgeAgentTask) => void;
  recordResult: (url: string, result: UrlResult) => Promise<void>;
  collectExpiredSnapshots: () => void;
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


function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);
}

export function htmlChanged(snapshotDirectory: string, currentSnapshot: string): boolean {
  const directory = absolutePath(snapshotDirectory);
  const currentName = basename(currentSnapshot);
  const snapshots = readdirSync(directory)
    .filter((name: string): boolean => HTML_SNAPSHOT_PATTERN.test(name))
    .sort();
  logger.info("Found HTML snapshots for comparison.", {
    snapshotCount: snapshots.length,
    currentSnapshot: currentName,
  });
  const currentIndex = snapshots.indexOf(currentName);
  if (currentIndex === -1) {
    logger.error("The current HTML snapshot is missing.", {
      currentSnapshot: currentName,
      snapshotDirectory,
    });
    throw new Error(`Current HTML snapshot is absent from ${snapshotDirectory}: ${currentSnapshot}`);
  }
  if (currentIndex === 0) {
    logger.info("The current HTML snapshot establishes the baseline.", {
      currentSnapshot: currentName,
    });
    return false;
  }

  const previousName = snapshots[currentIndex - 1];
  if (previousName === undefined) return false;
  const previous = readFileSync(join(directory, previousName));
  const current = readFileSync(join(directory, currentName));
  const changed = !previous.equals(current);
  if (changed) {
    logger.info("The rendered HTML changed.", {
      currentSnapshot: currentName,
      previousSnapshot: previousName,
      currentBytes: current.byteLength,
      previousBytes: previous.byteLength,
    });
  } else {
    logger.info("The rendered HTML did not change.", {
      currentSnapshot: currentName,
      previousSnapshot: previousName,
      bytes: current.byteLength,
    });
  }
  return changed;
}

export function incrementHtmlChangeCount(snapshotDirectory: string): number {
  const directory = absolutePath(snapshotDirectory);
  const countPath = join(directory, HTML_CHANGE_COUNT_FILE);
  let previous = 0;
  try {
    const text = readFileSync(countPath, "utf8").trim();
    if (!/^(0|[1-9]\d*)$/.test(text)) {
      logger.error("The HTML change count is invalid.", { file: HTML_CHANGE_COUNT_FILE });
      throw new Error(`${countPath} does not contain a nonnegative integer`);
    }
    previous = Number(text);
    logger.info("Read the saved HTML change count.", { changeCount: previous });
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    logger.info("No HTML change count exists yet. The count starts at zero.");
  }
  const next = previous + 1;
  mkdirSync(directory, { recursive: true });
  writeFileSync(countPath, `${next}\n`, "utf8");
  logger.info("Saved the HTML change count.", { changeCount: next });
  return next;
}

function runOmpAgent(model: string, thinking: "high" | "xhigh", maxTime: string, prompt: string): void {
  const startedAt = performance.now();
  logger.info("Starting an agent.", { model, timeLimitSeconds: Number(maxTime) });
  const result: SpawnSyncReturns<Buffer> = spawnSync(process.execPath, [
    "--import",
    "tsx",
    STYLED_OMP_RUNNER_PATH,
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
    logger.error("The agent could not start.", { error: result.error.message });
    throw new Error(`omp failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    logger.error("The agent failed.", {
      durationMilliseconds: Math.round(performance.now() - startedAt),
      status: result.status,
    });
    throw new Error(`omp failed with exit status ${result.status}`);
  }
  logger.info("The agent finished.", {
    durationMilliseconds: Math.round(performance.now() - startedAt),
  });
}

function runScriptAgent(task: ScriptAgentTask): void {
  const action = task.reason === "setup"
    ? "Create and test the extractor for this new or incomplete URL."
    : "Examine the saved extractor against the current HTML and extracted output. Fix and test it only if it is wrong.";
  logger.info(
    task.reason === "setup" ? "Starting extractor setup." : "Starting the scheduled extractor audit.",
    { snapshot: basename(task.currentSnapshot) },
  );
  const prompt = [
    "Act only as the extractor agent described in AGENTS.md.",
    action,
    "Do not evaluate notification conditions and do not send notifications.",
    `Task: ${JSON.stringify(task)}`,
  ].join("\n");
  runOmpAgent(AGENT_MODEL, "xhigh", SCRIPT_AGENT_MAX_TIME_SECONDS, prompt);
  logger.info(task.reason === "setup" ? "The extractor setup finished." : "The extractor audit finished.");
}

function runJudgeAgent(task: JudgeAgentTask): void {
  logger.info("Starting the change judge.", { snapshot: basename(task.currentSnapshot) });
  const prompt = [
    "Act only as the change judge described in AGENTS.md.",
    "Evaluate the supplied Markdown difference against notificationTrigger.",
    "Send a notification only when the difference matches the trigger.",
    `Task: ${JSON.stringify(task)}`,
  ].join("\n");
  runOmpAgent(AGENT_MODEL, "high", JUDGE_AGENT_MAX_TIME_SECONDS, prompt);
  logger.info("The change judge finished.");
}


export const DEFAULT_URL_WATCH_OPERATIONS: UrlWatchOperations = {
  classifyUrl: getUrlState,
  capturePage,
  extractSnapshot,
  compareSnapshots,
  htmlChanged,
  incrementHtmlChangeCount,
  runScriptAgent,
  runJudgeAgent,
  recordResult: async (url: string, result: UrlResult): Promise<void> => {
    await recordUrlResult(url, result);
  },
  collectExpiredSnapshots: (): void => {
    collectExpiredSnapshots();
  },
};

function setUpUrl(
  url: string,
  notificationTrigger: string,
  initialState: UrlStateResult,
  operations: UrlWatchOperations,
): UrlWatchResult {
  logger.info("Setting up a page.", {
    initialState: initialState.state,
    snapshotDirectory: initialState.snapshotDirectory,
  });
  const currentSnapshot = operations.capturePage(url);
  logger.info("Captured an HTML snapshot for extractor setup.", {
    snapshot: basename(currentSnapshot),
  });
  operations.runScriptAgent({
    reason: "setup",
    url,
    notificationTrigger,
    snapshotDirectory: initialState.snapshotDirectory,
    currentSnapshot,
  });
  const configured = operations.classifyUrl(url);
  logger.info("The extractor setup finished.", { state: configured.state });
  if (configured.state !== "configured") throw new Error(`The extractor agent did not configure ${url}`);
  const canonicalSnapshot = operations.extractSnapshot(currentSnapshot);
  logger.info("Created canonical Markdown with the new extractor.", {
    snapshot: basename(canonicalSnapshot),
  });
  const comparison = operations.compareSnapshots(configured.snapshotDirectory);
  logger.info("Compared the setup snapshot.", { result: comparison.state });
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
  snapshotDirectory: string,
  currentSnapshot: string,
  operations: UrlWatchOperations,
): boolean {
  if (!didHtmlChange) return false;
  const count = operations.incrementHtmlChangeCount(snapshotDirectory);
  const auditDue = count % HTML_CHANGE_REVIEW_INTERVAL === 0;
  logger.info(
    auditDue
      ? "The HTML change requires the scheduled extractor audit."
      : "The HTML change does not require an extractor audit.",
    { changeCount: count, auditInterval: HTML_CHANGE_REVIEW_INTERVAL },
  );
  if (!auditDue) return false;
  operations.runScriptAgent({
    reason: "fifth-html-change",
    url,
    notificationTrigger,
    snapshotDirectory: snapshotDirectory,
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
  logger.info("Checking a configured page.", { snapshotDirectory: urlState.snapshotDirectory });
  const currentSnapshot = operations.capturePage(url);
  logger.info("Captured an HTML snapshot.", { snapshot: basename(currentSnapshot) });
  const didHtmlChange = operations.htmlChanged(urlState.snapshotDirectory, currentSnapshot);
  const scriptAgentRan = auditExtractorAfterHtmlChange(
    didHtmlChange,
    url,
    notificationTrigger,
    urlState.snapshotDirectory,
    currentSnapshot,
    operations,
  );

  const canonicalSnapshot = operations.extractSnapshot(currentSnapshot);
  logger.info("Created canonical Markdown.", { snapshot: basename(canonicalSnapshot) });
  const comparison = operations.compareSnapshots(urlState.snapshotDirectory);
  logger.info("Compared the canonical Markdown.", { result: comparison.state });
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

  logger.info("The canonical Markdown changed. The change judge is required.", {
    differenceBytes: Buffer.byteLength(comparison.diff),
  });
  operations.runJudgeAgent({
    url,
    notificationTrigger,
    snapshotDirectory: urlState.snapshotDirectory,
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
  logger.info("Classified the page.", { state: state.state, snapshotDirectory: state.snapshotDirectory });
  return state.state === "configured"
    ? watchConfiguredUrl(url, notificationTrigger, state, operations)
    : setUpUrl(url, notificationTrigger, state, operations);
}

export async function watchUrls(
  input: WatchInput,
  operations: UrlWatchOperations = DEFAULT_URL_WATCH_OPERATIONS,
): Promise<readonly UrlWatchResult[]> {
  logger.info("Starting page checks.", { pageCount: input.urls.length });
  const results: UrlWatchResult[] = [];
  const failures: string[] = [];
  for (const [index, url] of input.urls.entries()) {
    logger.info("Starting a page check.", {
      pageNumber: index + 1,
      pageCount: input.urls.length,
    });
    try {
      const result = watchUrl(url, input.notificationTrigger, operations);
      await operations.recordResult(url, "success");
      logger.info("The page check finished.", {
        pageNumber: index + 1,
        result: result.state,
      });
      results.push(result);
    } catch (error: unknown) {
      const detail = errorDetail(error);
      logger.error("The page check failed.", { pageNumber: index + 1, error: detail });
      failures.push(`${url}: ${detail}`);
      try {
        await operations.recordResult(url, "failure");
        logger.info("Recorded the page-check failure.", { pageNumber: index + 1 });
      } catch (recordError: unknown) {
        const recordDetail = errorDetail(recordError);
        logger.error("Could not record the page-check failure.", {
          pageNumber: index + 1,
          error: recordDetail,
        });
        failures.push(`${url}: could not record failure: ${recordDetail}`);
      }
    }
  }
  try {
    operations.collectExpiredSnapshots();
  } catch (error: unknown) {
    const detail = errorDetail(error);
    logger.error("Snapshot garbage collection failed.", { error: detail });
    failures.push(`snapshot garbage collection: ${detail}`);
  }
  if (failures.length > 0) {
    logger.error("Some page checks failed.", {
      failureCount: failures.length,
      pageCount: input.urls.length,
    });
    throw new Error(`URL watch failures:\n${failures.join("\n")}`);
  }
  logger.info("All page checks finished successfully.", { pageCount: results.length });
  return results;
}
