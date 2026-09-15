import type { SnapshotComparison } from "../snapshots/compare.ts";
import { errorDetail, logger } from "../logger.ts";
import { CanonicalSnapshotPathSchema } from "./domain.ts";
import { identifyJob, jobIdentityKey, type ExtractedJob, type JobIdentity } from "./jobs.ts";
import type { PageWatchDependencies } from "./ports.ts";
import type { UrlWatchResult } from "./watch-urls.ts";

export type JobUpdate = Readonly<{
  extractionId: string;
  jobs: readonly ExtractedJob[];
  addedJobs: readonly JobIdentity[];
}>;

export async function readJobUpdate(
  pageUrl: string,
  organizationName: string,
  comparison: SnapshotComparison,
  dependencies: PageWatchDependencies,
): Promise<JobUpdate> {
  const jobs = await dependencies.snapshots.jobs(CanonicalSnapshotPathSchema.parse(comparison.current));
  if (comparison.state !== "changed") return { extractionId: comparison.current, jobs, addedJobs: [] };
  const previous = await dependencies.snapshots.jobs(CanonicalSnapshotPathSchema.parse(comparison.previous));
  const known = new Set(previous.map((job) => jobIdentityKey(identifyJob(organizationName, pageUrl, job))));
  const addedJobs: JobIdentity[] = [];
  for (const extracted of jobs) {
    const job = identifyJob(organizationName, pageUrl, extracted);
    const key = jobIdentityKey(job);
    if (known.has(key)) continue;
    known.add(key);
    addedJobs.push(job);
  }
  return { extractionId: comparison.current, jobs, addedJobs };
}

async function sendPageUpdate(result: UrlWatchResult, dependencies: PageWatchDependencies): Promise<void> {
  await dependencies.bookmarks.observe({
    pageUrl: result.url,
    organizationName: result.organizationName,
    jobs: result.jobUpdate.jobs,
    extractionId: result.jobUpdate.extractionId,
  });
  if (result.judgment?.state !== "matched") return;
  if (result.jobUpdate.addedJobs.length === 0) {
    await dependencies.notifier.send(`${result.organizationName}\n${result.judgment.text}`);
    return;
  }
  for (const job of result.jobUpdate.addedJobs) await dependencies.jobNotifier.send(job);
}

export async function deliverJobUpdates(
  results: readonly UrlWatchResult[],
  dependencies: PageWatchDependencies,
): Promise<readonly string[]> {
  const failures: string[] = [];
  for (const result of results) {
    try {
      await sendPageUpdate(result, dependencies);
    } catch (error: unknown) {
      const detail = errorDetail(error);
      logger.error("could not process the accepted job update.", { url: result.url, error: detail });
      failures.push(`job update for ${result.url}: ${detail}`);
    }
  }
  try {
    for (const removal of await dependencies.bookmarks.pendingRemovals()) {
      const { job } = removal;
      await dependencies.notifier.send(
        `Bookmarked job removed after six consecutive extractions without it.\n${job.organizationName}\n${job.title}\n${job.link}`,
      );
      await dependencies.bookmarks.acknowledgeRemoval(removal.id);
    }
  } catch (error: unknown) {
    const detail = errorDetail(error);
    logger.error("could not deliver the bookmarked job removal.", { error: detail });
    failures.push(`bookmarked job removal: ${detail}`);
  }
  return failures;
}
