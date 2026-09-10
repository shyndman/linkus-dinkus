import { rm } from "node:fs/promises";
import { basename } from "node:path";
import { errorDetail, logger } from "../logger.ts";
import type { HtmlSnapshotPath } from "../page-watch/domain.ts";

export async function discardSnapshotAttempt(snapshot: HtmlSnapshotPath): Promise<void> {
  const base = snapshot.slice(0, -".html".length);
  const sidecars = [
    `${base}.md`,
    `${base}.draft.md`,
    `${base}.stats.json`,
    `${base}.inspection.json`,
  ];
  try {
    await Promise.all([rm(snapshot, { force: true }), ...sidecars.map((path) => rm(path, { force: true }))]);
  } catch (error: unknown) {
    logger.error("could not discard a failed page-check attempt.", {
      snapshot: basename(snapshot),
      error: errorDetail(error),
    });
    throw error;
  }
  logger.debug("discarded the failed page-check attempt.", {
    snapshot: basename(snapshot),
  });
}
