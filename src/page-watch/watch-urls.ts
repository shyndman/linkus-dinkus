import { basename } from "node:path";
import { APPLICATION_CONFIG } from "../config.ts";
import { errorDetail, logger, type LogFields } from "../logger.ts";
import type { ChangedComparison, SnapshotComparison } from "../snapshots/compare.ts";
import {
  CanonicalSnapshotPathSchema,
  NotificationTriggerSchema,
  WatchedUrlSchema,
  type HtmlSnapshotPath,
  type NotificationTrigger,
  type OrganizationName,
  type WatchedUrl,
} from "./domain.ts";
import { organizationNamePath } from "./organization-name.ts";
import type { JudgmentResult } from "./judgment.ts";
import type { PageWatchDependencies } from "./ports.ts";
import { deliverJobUpdates, readJobUpdate, type JobUpdate } from "./job-updates.ts";
import type { UrlStateResult } from "./url-state.ts";
import {
  runConcurrentPageChecks,
  type UrlCheckInput,
  type UrlCheckResult,
} from "./concurrent-page-checks.ts";

export type UrlWatchResult = Readonly<{
  url: WatchedUrl;
  organizationName: OrganizationName;
  state: "set-up" | "baseline" | "unchanged" | "changed";
  scriptAgentRan: boolean;
  judgment: JudgmentResult | null;
  jobUpdate: JobUpdate;
}>;

export type WatchInput = Readonly<{
  notificationTrigger: string;
  urls: readonly string[];
}>;

type PageCheckProgress = { attempts: number };
const PAGE_SUMMARY_MESSAGE = "━━ Page complete ━━";
const POLL_SUMMARY_MESSAGE = "━━ Poll complete ━━";
const MILLISECONDS_PER_SECOND = 1_000;

async function setUpUrl(
  url: WatchedUrl,
  notificationTrigger: NotificationTrigger,
  initialState: UrlStateResult,
  currentSnapshot: HtmlSnapshotPath,
  dependencies: PageWatchDependencies,
): Promise<UrlWatchResult> {
  logger.info("setting up a page.", {
    initialState: initialState.state,
    snapshotDirectory: initialState.snapshotDirectory,
  });
  await dependencies.extractorAgent.run({
    reason: "setup",
    url,
    notificationTrigger,
    snapshotDirectory: initialState.snapshotDirectory,
    currentSnapshot,
    organizationNamePath: organizationNamePath(initialState.snapshotDirectory),
  });
  const configured = await dependencies.pageState.classify(url);
  logger.debug("extractor setup finished.", { state: configured.state });
  if (configured.state !== "configured") throw new Error(`The extractor agent did not configure ${url}`);
  const organizationName = await dependencies.organizations.read(configured.snapshotDirectory);
  if (organizationName === null) {
    logger.error("extractor setup did not save the organization name.");
    throw new Error(`The extractor agent did not save an organization name for ${url}`);
  }
  const canonicalSnapshot = await dependencies.snapshots.extract(currentSnapshot);
  logger.debug("created canonical Markdown with the new extractor.", {
    snapshot: basename(canonicalSnapshot),
  });
  const comparison = await dependencies.snapshots.compare(configured.snapshotDirectory);
  logger.debug("compared the setup snapshot.", { result: comparison.state });
  if (initialState.state === "new" && comparison.state !== "baseline") {
    throw new Error(`The first canonical snapshot for ${url} was not a baseline`);
  }
  const judgment = await inspectJobCount({
    url,
    snapshotDirectory: configured.snapshotDirectory,
    currentSnapshot,
    organizationName,
    comparison,
  }, dependencies);
  await dependencies.extractorAudits.recordSuccess(configured.snapshotDirectory);
  return {
    url,
    organizationName,
    state: "set-up",
    scriptAgentRan: true,
    judgment,
    jobUpdate: await readJobUpdate(url, organizationName, comparison, dependencies),
  };
}


async function auditExtractorIfDue(
  url: WatchedUrl,
  notificationTrigger: NotificationTrigger,
  urlState: UrlStateResult,
  currentSnapshot: HtmlSnapshotPath,
  dependencies: PageWatchDependencies,
): Promise<boolean> {
  const auditDue = await dependencies.extractorAudits.isDue(urlState.snapshotDirectory);
  if (!auditDue) return false;
  logger.info("the scheduled extractor audit is due.", {
    auditIntervalDays: APPLICATION_CONFIG.pageChecks.extractorAuditIntervalDays,
  });
  await dependencies.extractorAgent.run({
    reason: "scheduled-audit",
    url,
    notificationTrigger,
    snapshotDirectory: urlState.snapshotDirectory,
    currentSnapshot,
  });
  return true;
}

type OrganizationNameResult = Readonly<{ name: OrganizationName; agentRan: boolean }>;

async function getOrganizationName(
  url: WatchedUrl,
  urlState: UrlStateResult,
  currentSnapshot: HtmlSnapshotPath,
  dependencies: PageWatchDependencies,
): Promise<OrganizationNameResult> {
  const savedName = await dependencies.organizations.read(urlState.snapshotDirectory);
  if (savedName !== null) return { name: savedName, agentRan: false };

  await dependencies.extractorAgent.run({
    reason: "organization-name",
    url,
    snapshotDirectory: urlState.snapshotDirectory,
    currentSnapshot,
    organizationNamePath: organizationNamePath(urlState.snapshotDirectory),
  });
  const capturedName = await dependencies.organizations.read(urlState.snapshotDirectory);
  if (capturedName === null) {
    logger.error("the organization-name agent did not save a name.");
    throw new Error(`The organization-name agent did not save a name for ${url}`);
  }
  return { name: capturedName, agentRan: true };
}
type ChangedPage = Readonly<{
  url: WatchedUrl;
  notificationTrigger: NotificationTrigger;
  snapshotDirectory: UrlStateResult["snapshotDirectory"];
  currentSnapshot: HtmlSnapshotPath;
  organizationName: OrganizationName;
  comparison: ChangedComparison;
}>;

async function judgeChangedPage(
  page: ChangedPage,
  dependencies: PageWatchDependencies,
): Promise<JudgmentResult> {
  logger.info("canonical Markdown changed. The change judge is required.", {
    differenceBytes: Buffer.byteLength(page.comparison.diff),
  });
  const judgment = await dependencies.changeJudge.run(page);
  if (judgment.state === "failure") throw new Error(judgment.text);
  return judgment;
}

async function inspectJobCount(
  page: Omit<ChangedPage, "notificationTrigger" | "comparison"> & Readonly<{ comparison: SnapshotComparison }>,
  dependencies: PageWatchDependencies,
): Promise<JudgmentResult | null> {
  const currentJobCount = await dependencies.snapshots.jobCount(
    CanonicalSnapshotPathSchema.parse(page.comparison.current),
  );
  logger.debug("read the snapshot job count.", { jobCount: currentJobCount });
  if (page.comparison.state === "baseline" || currentJobCount !== 0) return null;
  const previousSnapshot = CanonicalSnapshotPathSchema.parse(page.comparison.previous);
  const previousJobCount = await dependencies.snapshots.jobCount(previousSnapshot);
  if (previousJobCount === 0) return null;
  logger.info("the job count dropped to zero. Inspecting the capture.", { previousJobCount, currentJobCount });
  const inspection = await dependencies.zeroJobInspector.run({
    url: page.url,
    snapshotDirectory: page.snapshotDirectory,
    currentSnapshot: page.currentSnapshot,
    previousSnapshot,
    previousJobCount,
    organizationName: page.organizationName,
  });
  await dependencies.snapshots.recordInspection(
    CanonicalSnapshotPathSchema.parse(page.comparison.current),
    previousJobCount,
    inspection,
  );
  if (inspection.state !== "matched") {
    const detail = inspection.state === "failure"
      ? inspection.text
      : "The drop to zero jobs could not be confirmed as a complete, valid page.";
    logger.warn("the zero-job capture remains unresolved.", { previousJobCount, error: detail });
    throw new Error(detail);
  }
  logger.info("the inspection confirmed that no jobs remain.", { previousJobCount, evidence: inspection.text });
  return { state: "matched", text: `No jobs remain. The previous accepted count was ${previousJobCount}.` };
}


async function watchConfiguredUrl(
  url: WatchedUrl,
  notificationTrigger: NotificationTrigger,
  urlState: UrlStateResult,
  currentSnapshot: HtmlSnapshotPath,
  dependencies: PageWatchDependencies,
): Promise<UrlWatchResult> {
  logger.debug("checking a configured page.", { snapshotDirectory: urlState.snapshotDirectory });
  const organization = await getOrganizationName(url, urlState, currentSnapshot, dependencies);
  const extractorAuditRan = await auditExtractorIfDue(
    url,
    notificationTrigger,
    urlState,
    currentSnapshot,
    dependencies,
  );

  const canonicalSnapshot = await dependencies.snapshots.extract(currentSnapshot);
  logger.debug("created canonical Markdown.", { snapshot: basename(canonicalSnapshot) });
  const comparison: SnapshotComparison = await dependencies.snapshots.compare(urlState.snapshotDirectory);
  logger.debug("compared the canonical Markdown.", { result: comparison.state });
  const zeroJobJudgment = await inspectJobCount({
    url,
    snapshotDirectory: urlState.snapshotDirectory,
    currentSnapshot,
    organizationName: organization.name,
    comparison,
  }, dependencies);
  const judgment = comparison.state === "changed"
    ? zeroJobJudgment ?? await judgeChangedPage({
      url,
      notificationTrigger,
      snapshotDirectory: urlState.snapshotDirectory,
      currentSnapshot,
      organizationName: organization.name,
      comparison,
    }, dependencies)
    : null;
  if (extractorAuditRan) {
    await dependencies.extractorAudits.recordSuccess(urlState.snapshotDirectory);
  }
  return {
    url,
    organizationName: organization.name,
    state: comparison.state,
    scriptAgentRan: organization.agentRan || extractorAuditRan,
    judgment,
    jobUpdate: await readJobUpdate(url, organization.name, comparison, dependencies),
  };
}
async function preparePageRetry(
  error: unknown,
  attempt: number,
  currentSnapshot: HtmlSnapshotPath | null,
  dependencies: PageWatchDependencies,
): Promise<void> {
  logger.warn("page-check attempt failed.", {
    attempt,
    attemptCount: APPLICATION_CONFIG.pageChecks.attemptCount,
    error: errorDetail(error),
  });
  if (currentSnapshot !== null) {
    await dependencies.snapshots.discardAttempt(currentSnapshot);
  }
  if (attempt >= APPLICATION_CONFIG.pageChecks.attemptCount) throw error;
  logger.warn("Waiting to try again", {
    attempt,
    attemptCount: APPLICATION_CONFIG.pageChecks.attemptCount,
    delay: `${APPLICATION_CONFIG.pageChecks.retryDelayMs / MILLISECONDS_PER_SECOND}s`,
  });
  await dependencies.retryClock.wait(APPLICATION_CONFIG.pageChecks.retryDelayMs);
}


async function watchTypedUrl(
  url: WatchedUrl,
  notificationTrigger: NotificationTrigger,
  dependencies: PageWatchDependencies,
  progress: PageCheckProgress,
): Promise<UrlWatchResult> {
  for (progress.attempts = 1; ; progress.attempts += 1) {
    let currentSnapshot: HtmlSnapshotPath | null = null;
    try {
      const state = await dependencies.pageState.classify(url);
      logger.debug("classified the page.", {
        state: state.state,
        snapshotDirectory: state.snapshotDirectory,
      });
      const renderSettleMs = progress.attempts === 1
        ? APPLICATION_CONFIG.snapshots.renderSettleMs
        : APPLICATION_CONFIG.snapshots.retryRenderSettleMs;
      currentSnapshot = await dependencies.snapshots.capture(url, renderSettleMs);
      logger.debug(
        state.state === "configured"
          ? "captured an HTML snapshot."
          : "captured an HTML snapshot for extractor setup.",
        { snapshot: basename(currentSnapshot) },
      );
      return await (
        state.state === "configured"
          ? watchConfiguredUrl(
            url,
            notificationTrigger,
            state,
            currentSnapshot,
            dependencies,
          )
          : setUpUrl(url, notificationTrigger, state, currentSnapshot, dependencies)
      );
    } catch (error: unknown) {
      await preparePageRetry(error, progress.attempts, currentSnapshot, dependencies);
    }
  }
}

export async function watchUrl(
  url: string,
  notificationTrigger: string,
  dependencies: PageWatchDependencies,
): Promise<UrlWatchResult> {
  return watchTypedUrl(
    WatchedUrlSchema.parse(url),
    NotificationTriggerSchema.parse(notificationTrigger),
    dependencies,
    { attempts: 0 },
  );
}

async function runUrlCheck(
  input: UrlCheckInput,
  dependencies: PageWatchDependencies,
): Promise<UrlCheckResult> {
  const startedAt = performance.now();
  const progress: PageCheckProgress = { attempts: 0 };
  logger.info("starting a page check.", {
    url: input.url,
    pageNumber: input.pageNumber,
    pageCount: input.pageCount,
  });
  let result: UrlWatchResult;
  try {
    result = await watchTypedUrl(input.url, input.notificationTrigger, dependencies, progress);
  } catch (error: unknown) {
    const detail = errorDetail(error);
    return recordFailedPageCheck(input, dependencies, detail, progress.attempts, startedAt);
  }
  try {
    await dependencies.pageState.recordResult(input.url, "success", null);
  } catch (error: unknown) {
    const detail = errorDetail(error);
    logger.error(PAGE_SUMMARY_MESSAGE, {
      outcome: "failure", phase: "record-success", organization: result.organizationName,
      attempts: progress.attempts, durationMs: Math.round(performance.now() - startedAt), error: detail,
    });
    return { state: "failure", error: detail, recordError: null };
  }
  logger.info(PAGE_SUMMARY_MESSAGE, {
    pageNumber: input.pageNumber,
    result: result.state,
    organization: result.organizationName,
    judgment: result.judgment?.state ?? "not-needed",
    extractorAgentRan: result.scriptAgentRan,
    attempts: progress.attempts,
    durationMs: Math.round(performance.now() - startedAt),
  });
  return { state: "success", result };
}

async function recordFailedPageCheck(
  input: UrlCheckInput,
  dependencies: PageWatchDependencies,
  detail: string,
  attempts: number,
  startedAt: number,
): Promise<UrlCheckResult> {
  try {
    await dependencies.pageState.recordResult(input.url, "failure", detail);
    logger.warn(PAGE_SUMMARY_MESSAGE, {
      attempts, durationMs: Math.round(performance.now() - startedAt),
      pageNumber: input.pageNumber, outcome: "unresolved", error: detail,
    });
    return { state: "unresolved", error: detail };
  } catch (error: unknown) {
    const recordDetail = errorDetail(error);
    logger.error(PAGE_SUMMARY_MESSAGE, {
      attempts, durationMs: Math.round(performance.now() - startedAt),
      pageNumber: input.pageNumber, outcome: "failure",
      error: detail, recordError: recordDetail,
    });
    return { state: "failure", error: detail, recordError: recordDetail };
  }
}


export async function watchUrls(
  input: WatchInput,
  dependencies: PageWatchDependencies,
): Promise<readonly UrlWatchResult[]> {
  const startedAt = performance.now();
  logger.info("starting page checks.", {
    concurrency: APPLICATION_CONFIG.pageChecks.concurrency,
    pageCount: input.urls.length,
  });
  let results: readonly UrlWatchResult[] = [];
  let unresolvedPageCount = 0;
  let failedPageCount = 0;
  let pageChecksCompleted = false;
  const failures: string[] = [];
  try {
    const outcome = await runConcurrentPageChecks(
      input,
      async (checkInput: UrlCheckInput): Promise<UrlCheckResult> => runUrlCheck(checkInput, dependencies),
    );
    results = outcome.results;
    unresolvedPageCount = outcome.unresolvedPageCount;
    failedPageCount = outcome.failedPageCount;
    pageChecksCompleted = true;
    failures.push(...outcome.failures);
  } catch (error: unknown) {
    const detail = errorDetail(error);
    logger.error("page-check orchestration failed.", { error: detail });
    failures.push(detail);
  }
  const matchedPageCount = results.reduce((count, result) => count + Number(result.judgment?.state === "matched"), 0);
  failures.push(...await deliverJobUpdates(results, dependencies));
  try {
    await dependencies.snapshots.collectExpired();
  } catch (error: unknown) {
    const detail = errorDetail(error);
    logger.error("snapshot garbage collection failed.", { error: detail });
    failures.push(`snapshot garbage collection: ${detail}`);
  }
  const summary: LogFields = {
    pageCount: input.urls.length,
    acceptedPageCount: results.length,
    unresolvedPageCount: pageChecksCompleted ? unresolvedPageCount : null,
    failedPageCount: pageChecksCompleted ? failedPageCount : null,
    matchedPageCount,
    errorCount: failures.length,
    durationMs: Math.round(performance.now() - startedAt),
  };
  const logSummary = failures.length > 0 ? logger.error : unresolvedPageCount > 0 ? logger.warn : logger.info;
  logSummary(POLL_SUMMARY_MESSAGE, summary);
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return results;
}
