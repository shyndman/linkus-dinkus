import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { APPLICATION_CONFIG } from "../config.ts";
import { errorDetail, logger } from "../logger.ts";
import { PROJECT_ROOT } from "../runtime.ts";

const EXTRACTOR_AUDITED_AT_FILE = "extractor-audited-at.txt";
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

function auditPath(snapshotDirectory: string): string {
  const directory = isAbsolute(snapshotDirectory) ? snapshotDirectory : resolve(PROJECT_ROOT, snapshotDirectory);
  return join(directory, EXTRACTOR_AUDITED_AT_FILE);
}

// Pages without an audit timestamp require one audit before the interval starts.
export async function extractorAuditDue(snapshotDirectory: string, now: number = Date.now()): Promise<boolean> {
  const path = auditPath(snapshotDirectory);
  try {
    const auditedAt = z.iso.datetime().parse((await readFile(path, "utf8")).trim());
    const intervalMs = APPLICATION_CONFIG.pageChecks.extractorAuditIntervalDays * MILLISECONDS_PER_DAY;
    const due = now - Date.parse(auditedAt) >= intervalMs;
    logger.debug("read the extractor audit schedule.", { auditedAt, auditDue: due });
    return due;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      logger.debug("no successful extractor audit is recorded. An audit is due.");
      return true;
    }
    logger.error("could not read the extractor audit schedule.", { path, error: errorDetail(error) });
    throw error;
  }
}

// Record setup or an audit only after the page check accepts the extracted content.
export async function recordExtractorAudit(snapshotDirectory: string, completedAt: number = Date.now()): Promise<void> {
  const path = auditPath(snapshotDirectory);
  try {
    const auditedAt = new Date(completedAt).toISOString();
    await mkdir(isAbsolute(snapshotDirectory) ? snapshotDirectory : resolve(PROJECT_ROOT, snapshotDirectory), { recursive: true });
    await writeFile(path, `${auditedAt}\n`, "utf8");
    logger.debug("saved the successful extractor audit time.", { auditedAt });
  } catch (error: unknown) {
    logger.error("could not save the extractor audit time.", { path, error: errorDetail(error) });
    throw error;
  }
}
