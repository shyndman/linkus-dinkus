import { rm } from "node:fs/promises";
import { basename } from "node:path";
import { logger } from "../logger.ts";
import type { HtmlSnapshotPath } from "../page-watch/domain.ts";

export async function discardSnapshotAttempt(snapshot: HtmlSnapshotPath): Promise<void> {
  const markdownSnapshot = snapshot.slice(0, -".html".length) + ".md";
  const draftSnapshot = snapshot.slice(0, -".html".length) + ".draft.md";
  try {
    await Promise.all([
      rm(snapshot, { force: true }),
      rm(markdownSnapshot, { force: true }),
      rm(draftSnapshot, { force: true }),
    ]);
  } catch (error: unknown) {
    logger.error("could not discard a failed page-check attempt.", {
      snapshot: basename(snapshot),
    });
    throw error;
  }
  logger.info("discarded the failed page-check attempt.", {
    snapshot: basename(snapshot),
  });
}
