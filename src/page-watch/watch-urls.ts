import { basename } from "node:path";
import { APPLICATION_CONFIG } from "../config.ts";
import { errorDetail, logger } from "../logger.ts";
import type { ChangedComparison, SnapshotComparison } from "../snapshots/compare.ts";
import {
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
  htmlChanged: boolean;
  scriptAgentRan: boolean;
  judgment: JudgmentResult | null;
}>;

export type WatchInput = Readonly<{
  notificationTrigger: string;
  urls: readonly string[];
}>;

async function setUpUrl(
  url: WatchedUrl,
  notificationTrigger: NotificationTrigger,
  initialState: UrlStateResult,
  dependencies: PageWatchDependencies,
): Promise<UrlWatchResult> {
  logger.info("setting up a page.", {
    initialState: initialState.state,
    snapshotDirectory: initialState.snapshotDirectory,
  });
  const currentSnapshot = await dependencies.snapshots.capture(url);
  logger.info("captured an HTML snapshot for extractor setup.", {
    snapshot: basename(currentSnapshot),
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
  logger.info("extractor setup finished.", { state: configured.state });
  if (configured.state !== "configured") throw new Error(`The extractor agent did not configure ${url}`);
  const organizationName = await dependencies.organizations.read(configured.snapshotDirectory);
  if (organizationName === null) {
    logger.error("extractor setup did not save the organization name.");
    throw new Error(`The extractor agent did not save an organization name for ${url}`);
  }
  const canonicalSnapshot = await dependencies.snapshots.extract(currentSnapshot);
  logger.info("created canonical Markdown with the new extractor.", {
    snapshot: basename(canonicalSnapshot),
  });
  const comparison = await dependencies.snapshots.compare(configured.snapshotDirectory);
  logger.info("compared the setup snapshot.", { result: comparison.state });
  if (initialState.state === "new" && comparison.state !== "baseline") {
    throw new Error(`The first canonical snapshot for ${url} was not a baseline`);
  }
  return {
    url,
    organizationName,
    state: "set-up",
    htmlChanged: false,
    scriptAgentRan: true,
    judgment: null,
  };
}

async function auditExtractorAfterHtmlChange(
  didHtmlChange: boolean,
  url: WatchedUrl,
  notificationTrigger: NotificationTrigger,
  urlState: UrlStateResult,
  currentSnapshot: HtmlSnapshotPath,
  dependencies: PageWatchDependencies,
): Promise<boolean> {
  if (!didHtmlChange) return false;
  const count = await dependencies.snapshots.incrementHtmlChangeCount(urlState.snapshotDirectory);
  const auditDue = count % APPLICATION_CONFIG.pageChecks.extractorAuditInterval === 0;
  logger.info(
    auditDue
      ? "html change requires the scheduled extractor audit."
      : "html change does not require an extractor audit.",
    {
      changeCount: count,
      auditInterval: APPLICATION_CONFIG.pageChecks.extractorAuditInterval,
    },
  );
  if (!auditDue) return false;
  await dependencies.extractorAgent.run({
    reason: "fifth-html-change",
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
  if (judgment.state === "failure") {
    logger.info("sending the failed change judgment.");
    await dependencies.notifier.send(judgment.text);
    logger.info("sent the failed change judgment.");
  }
  return judgment;
}


async function watchConfiguredUrl(
  url: WatchedUrl,
  notificationTrigger: NotificationTrigger,
  urlState: UrlStateResult,
  dependencies: PageWatchDependencies,
): Promise<UrlWatchResult> {
  logger.info("checking a configured page.", { snapshotDirectory: urlState.snapshotDirectory });
  const currentSnapshot = await dependencies.snapshots.capture(url);
  logger.info("captured an HTML snapshot.", { snapshot: basename(currentSnapshot) });
  const organization = await getOrganizationName(url, urlState, currentSnapshot, dependencies);
  const didHtmlChange = await dependencies.snapshots.htmlChanged(
    urlState.snapshotDirectory,
    currentSnapshot,
  );
  const extractorAuditRan = await auditExtractorAfterHtmlChange(
    didHtmlChange,
    url,
    notificationTrigger,
    urlState,
    currentSnapshot,
    dependencies,
  );

  const canonicalSnapshot = await dependencies.snapshots.extract(currentSnapshot);
  logger.info("created canonical Markdown.", { snapshot: basename(canonicalSnapshot) });
  const comparison: SnapshotComparison = await dependencies.snapshots.compare(urlState.snapshotDirectory);
  logger.info("compared the canonical Markdown.", { result: comparison.state });
  if (comparison.state !== "changed") {
    logger.info("change judge is not needed.");
    return {
      url,
      organizationName: organization.name,
      state: comparison.state,
      htmlChanged: didHtmlChange,
      scriptAgentRan: organization.agentRan || extractorAuditRan,
      judgment: null,
    };
  }

  const judgment = await judgeChangedPage({
    url,
    notificationTrigger,
    snapshotDirectory: urlState.snapshotDirectory,
    currentSnapshot,
    organizationName: organization.name,
    comparison,
  }, dependencies);
  return {
    url,
    organizationName: organization.name,
    state: "changed",
    htmlChanged: didHtmlChange,
    scriptAgentRan: organization.agentRan || extractorAuditRan,
    judgment,
  };
}

async function watchTypedUrl(
  url: WatchedUrl,
  notificationTrigger: NotificationTrigger,
  dependencies: PageWatchDependencies,
): Promise<UrlWatchResult> {
  const state = await dependencies.pageState.classify(url);
  logger.info("classified the page.", {
    state: state.state,
    snapshotDirectory: state.snapshotDirectory,
  });
  return state.state === "configured"
    ? watchConfiguredUrl(url, notificationTrigger, state, dependencies)
    : setUpUrl(url, notificationTrigger, state, dependencies);
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
  );
}

async function runUrlCheck(
  input: UrlCheckInput,
  dependencies: PageWatchDependencies,
): Promise<UrlCheckResult> {
  logger.info("starting a page check.", {
    url: input.url,
    pageNumber: input.pageNumber,
    pageCount: input.pageCount,
  });
  try {
    const result = await watchTypedUrl(input.url, input.notificationTrigger, dependencies);
    await dependencies.pageState.recordResult(input.url, "success");
    logger.info("page check finished.", {
      pageNumber: input.pageNumber,
      result: result.state,
    });
    return { state: "success", result };
  } catch (error: unknown) {
    const detail = errorDetail(error);
    logger.error("page check failed.", { pageNumber: input.pageNumber, error: detail });
    try {
      await dependencies.pageState.recordResult(input.url, "failure");
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

function consolidatedJudgmentMessage(results: readonly UrlWatchResult[]): string | null {
  const sections = results.flatMap((result: UrlWatchResult): readonly string[] => {
    if (result.judgment?.state !== "matched") return [];
    return [`${result.organizationName}\n${result.judgment.text}`];
  });
  return sections.length === 0 ? null : sections.join("\n\n");
}

export async function watchUrls(
  input: WatchInput,
  dependencies: PageWatchDependencies,
): Promise<readonly UrlWatchResult[]> {
  logger.info("starting page checks.", {
    concurrency: APPLICATION_CONFIG.pageChecks.concurrency,
    pageCount: input.urls.length,
  });
  let results: readonly UrlWatchResult[] = [];
  const failures: string[] = [];
  try {
    const outcome = await runConcurrentPageChecks(
      input,
      async (checkInput: UrlCheckInput): Promise<UrlCheckResult> => runUrlCheck(checkInput, dependencies),
    );
    results = outcome.results;
    failures.push(...outcome.failures);
  } catch (error: unknown) {
    failures.push(errorDetail(error));
  }
  const judgmentMessage = consolidatedJudgmentMessage(results);
  if (judgmentMessage !== null) {
    try {
      logger.info("sending the consolidated change judgments.", { characters: judgmentMessage.length });
      await dependencies.notifier.send(judgmentMessage);
      logger.info("sent the consolidated change judgments.");
    } catch (error: unknown) {
      const detail = errorDetail(error);
      logger.error("could not send the consolidated change judgments.", { error: detail });
      failures.push(`consolidated change judgments: ${detail}`);
    }
  }
  try {
    await dependencies.snapshots.collectExpired();
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
