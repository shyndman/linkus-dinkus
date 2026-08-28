import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { errorDetail, logger } from "../logger.ts";
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
import {
  PAGE_CHECK_CONCURRENCY,
  runConcurrentPageChecks,
  type UrlCheckInput,
  type UrlCheckResult,
} from "./concurrent-page-checks.ts";

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
  classifyUrl: (url: string) => Promise<UrlStateResult>;
  capturePage: (url: string) => Promise<string>;
  extractSnapshot: (snapshot: string) => Promise<string>;
  compareSnapshots: (snapshotDirectory: string) => Promise<SnapshotComparison>;
  htmlChanged: (snapshotDirectory: string, currentSnapshot: string) => Promise<boolean>;
  incrementHtmlChangeCount: (snapshotDirectory: string) => Promise<number>;
  runScriptAgent: (task: ScriptAgentTask) => Promise<void>;
  runJudgeAgent: (task: JudgeAgentTask) => Promise<void>;
  recordResult: (url: string, result: UrlResult) => Promise<void>;
  collectExpiredSnapshots: () => Promise<void>;
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

export async function htmlChanged(snapshotDirectory: string, currentSnapshot: string): Promise<boolean> {
  const directory = absolutePath(snapshotDirectory);
  const currentName = basename(currentSnapshot);
  const snapshots = (await readdir(directory))
    .filter((name: string): boolean => HTML_SNAPSHOT_PATTERN.test(name))
    .sort();
  logger.info("found HTML snapshots for comparison.", {
    snapshotCount: snapshots.length,
    currentSnapshot: currentName,
  });
  const currentIndex = snapshots.indexOf(currentName);
  if (currentIndex === -1) {
    logger.error("current HTML snapshot is missing.", {
      currentSnapshot: currentName,
      snapshotDirectory,
    });
    throw new Error(`Current HTML snapshot is absent from ${snapshotDirectory}: ${currentSnapshot}`);
  }
  if (currentIndex === 0) {
    logger.info("current HTML snapshot establishes the baseline.", {
      currentSnapshot: currentName,
    });
    return false;
  }

  const previousName = snapshots[currentIndex - 1];
  if (previousName === undefined) return false;
  const [previous, current] = await Promise.all([
    readFile(join(directory, previousName)),
    readFile(join(directory, currentName)),
  ]);
  const changed = !previous.equals(current);
  if (changed) {
    logger.info("rendered HTML changed.", {
      currentSnapshot: currentName,
      previousSnapshot: previousName,
      currentBytes: current.byteLength,
      previousBytes: previous.byteLength,
    });
  } else {
    logger.info("rendered HTML did not change.", {
      currentSnapshot: currentName,
      previousSnapshot: previousName,
      bytes: current.byteLength,
    });
  }
  return changed;
}

export async function incrementHtmlChangeCount(snapshotDirectory: string): Promise<number> {
  const directory = absolutePath(snapshotDirectory);
  const countPath = join(directory, HTML_CHANGE_COUNT_FILE);
  let previous = 0;
  try {
    const text = (await readFile(countPath, "utf8")).trim();
    if (!/^(0|[1-9]\d*)$/.test(text)) {
      logger.error("html change count is invalid.", { file: HTML_CHANGE_COUNT_FILE });
      throw new Error(`${countPath} does not contain a nonnegative integer`);
    }
    previous = Number(text);
    logger.info("read the saved HTML change count.", { changeCount: previous });
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    logger.info("no HTML change count exists yet. The count starts at zero.");
  }
  const next = previous + 1;
  await mkdir(directory, { recursive: true });
  await writeFile(countPath, `${next}\n`, "utf8");
  logger.info("saved the HTML change count.", { changeCount: next });
  return next;
}

async function runOmpAgent(
  model: string,
  thinking: "high" | "xhigh",
  maxTime: string,
  prompt: string,
): Promise<void> {
  const startedAt = performance.now();
  logger.info("starting an agent.", { model, timeLimitSeconds: Number(maxTime) });
  await new Promise<void>((resolveAgent, rejectAgent): void => {
    const child = spawn(process.execPath, [
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
    let startFailed = false;
    child.once("error", (error: Error): void => {
      startFailed = true;
      logger.error("agent could not start.", { error: error.message });
      rejectAgent(new Error(`omp failed to start: ${error.message}`));
    });
    child.once("close", (status: number | null): void => {
      if (startFailed) return;
      if (status !== 0) {
        logger.error("agent failed.", {
          durationMilliseconds: Math.round(performance.now() - startedAt),
          status,
        });
        rejectAgent(new Error(`omp failed with exit status ${status}`));
        return;
      }
      resolveAgent();
    });
  });
  logger.info("agent finished.", {
    durationMilliseconds: Math.round(performance.now() - startedAt),
  });
}

async function runScriptAgent(task: ScriptAgentTask): Promise<void> {
  const action = task.reason === "setup"
    ? "Create and test the extractor for this new or incomplete URL."
    : "Examine the saved extractor against the current HTML and extracted output. Fix and test it only if it is wrong.";
  logger.info(
    task.reason === "setup" ? "starting extractor setup." : "starting the scheduled extractor audit.",
    { snapshot: basename(task.currentSnapshot) },
  );
  const prompt = [
    "Act only as the extractor agent described in AGENTS.md.",
    action,
    "Do not evaluate notification conditions and do not send notifications.",
    `Task: ${JSON.stringify(task)}`,
  ].join("\n");
  await runOmpAgent(AGENT_MODEL, "xhigh", SCRIPT_AGENT_MAX_TIME_SECONDS, prompt);
  logger.info(task.reason === "setup" ? "extractor setup finished." : "extractor audit finished.");
}

async function runJudgeAgent(task: JudgeAgentTask): Promise<void> {
  logger.info("starting the change judge.", { snapshot: basename(task.currentSnapshot) });
  const prompt = [
    "Act only as the change judge described in AGENTS.md.",
    "Evaluate the supplied Markdown difference against notificationTrigger.",
    "Send a notification only when the difference matches the trigger.",
    `Task: ${JSON.stringify(task)}`,
  ].join("\n");
  await runOmpAgent(AGENT_MODEL, "high", JUDGE_AGENT_MAX_TIME_SECONDS, prompt);
  logger.info("change judge finished.");
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
  collectExpiredSnapshots: async (): Promise<void> => {
    await collectExpiredSnapshots();
  },
};

async function setUpUrl(
  url: string,
  notificationTrigger: string,
  initialState: UrlStateResult,
  operations: UrlWatchOperations,
): Promise<UrlWatchResult> {
  logger.info("setting up a page.", {
    initialState: initialState.state,
    snapshotDirectory: initialState.snapshotDirectory,
  });
  const currentSnapshot = await operations.capturePage(url);
  logger.info("captured an HTML snapshot for extractor setup.", {
    snapshot: basename(currentSnapshot),
  });
  await operations.runScriptAgent({
    reason: "setup",
    url,
    notificationTrigger,
    snapshotDirectory: initialState.snapshotDirectory,
    currentSnapshot,
  });
  const configured = await operations.classifyUrl(url);
  logger.info("extractor setup finished.", { state: configured.state });
  if (configured.state !== "configured") throw new Error(`The extractor agent did not configure ${url}`);
  const canonicalSnapshot = await operations.extractSnapshot(currentSnapshot);
  logger.info("created canonical Markdown with the new extractor.", {
    snapshot: basename(canonicalSnapshot),
  });
  const comparison = await operations.compareSnapshots(configured.snapshotDirectory);
  logger.info("compared the setup snapshot.", { result: comparison.state });
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
async function auditExtractorAfterHtmlChange(
  didHtmlChange: boolean,
  url: string,
  notificationTrigger: string,
  snapshotDirectory: string,
  currentSnapshot: string,
  operations: UrlWatchOperations,
): Promise<boolean> {
  if (!didHtmlChange) return false;
  const count = await operations.incrementHtmlChangeCount(snapshotDirectory);
  const auditDue = count % HTML_CHANGE_REVIEW_INTERVAL === 0;
  logger.info(
    auditDue
      ? "html change requires the scheduled extractor audit."
      : "html change does not require an extractor audit.",
    { changeCount: count, auditInterval: HTML_CHANGE_REVIEW_INTERVAL },
  );
  if (!auditDue) return false;
  await operations.runScriptAgent({
    reason: "fifth-html-change",
    url,
    notificationTrigger,
    snapshotDirectory,
    currentSnapshot,
  });
  return true;
}


async function watchConfiguredUrl(
  url: string,
  notificationTrigger: string,
  urlState: UrlStateResult,
  operations: UrlWatchOperations,
): Promise<UrlWatchResult> {
  logger.info("checking a configured page.", { snapshotDirectory: urlState.snapshotDirectory });
  const currentSnapshot = await operations.capturePage(url);
  logger.info("captured an HTML snapshot.", { snapshot: basename(currentSnapshot) });
  const didHtmlChange = await operations.htmlChanged(urlState.snapshotDirectory, currentSnapshot);
  const scriptAgentRan = await auditExtractorAfterHtmlChange(
    didHtmlChange,
    url,
    notificationTrigger,
    urlState.snapshotDirectory,
    currentSnapshot,
    operations,
  );

  const canonicalSnapshot = await operations.extractSnapshot(currentSnapshot);
  logger.info("created canonical Markdown.", { snapshot: basename(canonicalSnapshot) });
  const comparison = await operations.compareSnapshots(urlState.snapshotDirectory);
  logger.info("compared the canonical Markdown.", { result: comparison.state });
  if (comparison.state !== "changed") {
    logger.info("change judge is not needed.");
    return {
      url,
      state: comparison.state,
      htmlChanged: didHtmlChange,
      scriptAgentRan,
      judgeAgentRan: false,
    };
  }

  logger.info("canonical Markdown changed. The change judge is required.", {
    differenceBytes: Buffer.byteLength(comparison.diff),
  });
  await operations.runJudgeAgent({
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

export async function watchUrl(
  url: string,
  notificationTrigger: string,
  operations: UrlWatchOperations = DEFAULT_URL_WATCH_OPERATIONS,
): Promise<UrlWatchResult> {
  const state = await operations.classifyUrl(url);
  logger.info("classified the page.", { state: state.state, snapshotDirectory: state.snapshotDirectory });
  return state.state === "configured"
    ? watchConfiguredUrl(url, notificationTrigger, state, operations)
    : setUpUrl(url, notificationTrigger, state, operations);
}


async function runUrlCheck(input: UrlCheckInput, operations: UrlWatchOperations): Promise<UrlCheckResult> {
  logger.info("starting a page check.", {
    url: input.url,
    pageNumber: input.pageNumber,
    pageCount: input.pageCount,
  });
  try {
    const result = await watchUrl(input.url, input.notificationTrigger, operations);
    await operations.recordResult(input.url, "success");
    logger.info("page check finished.", {
      pageNumber: input.pageNumber,
      result: result.state,
    });
    return { state: "success", result };
  } catch (error: unknown) {
    const detail = errorDetail(error);
    logger.error("page check failed.", { pageNumber: input.pageNumber, error: detail });
    try {
      await operations.recordResult(input.url, "failure");
      logger.info("recorded the page-check failure.", { pageNumber: input.pageNumber });
      return { state: "failure", error: detail, recordError: null };
    } catch (recordError: unknown) {
      const recordDetail = errorDetail(recordError);
      logger.error("could not record the page-check failure.", {
        pageNumber: input.pageNumber,
        error: recordDetail,
      });
      return { state: "failure", error: detail, recordError: recordDetail };
    }
  }
}


export async function watchUrls(
  input: WatchInput,
  operations: UrlWatchOperations = DEFAULT_URL_WATCH_OPERATIONS,
): Promise<readonly UrlWatchResult[]> {
  logger.info("starting page checks.", {
    concurrency: PAGE_CHECK_CONCURRENCY,
    pageCount: input.urls.length,
  });
  let results: readonly UrlWatchResult[] = [];
  const failures: string[] = [];
  try {
    results = await runConcurrentPageChecks(
      input,
      async (checkInput: UrlCheckInput): Promise<UrlCheckResult> => runUrlCheck(checkInput, operations),
    );
  } catch (error: unknown) {
    failures.push(errorDetail(error));
  }
  try {
    await operations.collectExpiredSnapshots();
  } catch (error: unknown) {
    const detail = errorDetail(error);
    logger.error("snapshot garbage collection failed.", { error: detail });
    failures.push(`snapshot garbage collection: ${detail}`);
  }
  if (failures.length > 0) {
    logger.error("some page checks failed.", {
      failureCount: failures.length,
      pageCount: input.urls.length,
    });
    throw new Error(failures.join("\n"));
  }
  logger.info("all page checks finished successfully.", { pageCount: results.length });
  return results;
}
