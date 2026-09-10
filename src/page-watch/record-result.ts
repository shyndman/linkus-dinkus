import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { errorDetail, logger } from "../logger.ts";
import { fail, getUrlSnapshotDirectory } from "../runtime.ts";
import { createAdminTelegramNotifier, type TelegramNotifier } from "../integrations/telegram.ts";

export type UrlResult = "success" | "failure";
type FailureState = Readonly<{ consecutiveFailures: number; alertSent: boolean; lastFailureReason: string | null }>;
export type RecordResult = Readonly<{
  url: string;
  result: UrlResult;
  consecutiveFailures: number;
  notified: boolean;
}>;

const STATE_FILENAME = "failure-state.json";

async function readFailureState(path: string): Promise<FailureState> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      typeof value !== "object"
      || value === null
      || !("consecutiveFailures" in value)
      || !Number.isInteger(value.consecutiveFailures)
      || (value.consecutiveFailures as number) < 0
    ) {
      throw new Error(`Invalid failure state in ${path}`);
    }
    const state = value as Record<string, unknown>;
    const consecutiveFailures = state.consecutiveFailures as number;
    const alertSent = state.alertSent === true;
    const lastFailureReason = typeof state.lastFailureReason === "string" ? state.lastFailureReason : null;
    logger.debug("read the failure streak.", { consecutiveFailures, alertSent });
    return { consecutiveFailures, alertSent, lastFailureReason };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      logger.debug("no failure state exists yet. The failure streak starts at zero.");
      return { consecutiveFailures: 0, alertSent: false, lastFailureReason: null };
    }
    logger.error("could not read the failure state.", { path, error: errorDetail(error) });
    throw error;
  }
}

async function writeFailureState(path: string, state: FailureState): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(state)}\n`, "utf8");
  } catch (error: unknown) {
    logger.error("could not save the failure state.", { path, error: errorDetail(error) });
    throw error;
  }
}

export async function recordUrlResult(
  url: string,
  result: UrlResult,
  detail: string | null = null,
  notify: TelegramNotifier | null = null,
  resolveSnapshotDirectory: (url: string) => Promise<string> = getUrlSnapshotDirectory,
): Promise<RecordResult> {
  logger.debug("recording the result of one watched page.");
  const snapshotDirectory = await resolveSnapshotDirectory(url);
  const statePath = join(snapshotDirectory, STATE_FILENAME);
  const previous = await readFailureState(statePath);
  const consecutiveFailures = result === "success" ? 0 : previous.consecutiveFailures + 1;
  logger.debug(
    result === "success" ? "page succeeded." : "page failed.",
    {
      previousConsecutiveFailures: previous.consecutiveFailures,
      consecutiveFailures,
    },
  );
  let notified = false;
  let alertSent = previous.alertSent;
  const lastFailureReason = result === "failure" ? detail : null;

  try {
    if (result === "failure") {
      if (alertSent) {
        logger.debug("an alert for the unresolved failure incident was already sent.", { url });
      } else {
        notified = await sendIncidentAlert(notify, url, detail);
        alertSent = notified;
      }
    } else if (alertSent) {
      notified = await sendRecoveryAlert(notify, url);
      if (notified) alertSent = false;
    }
  } finally {
    await mkdir(snapshotDirectory, { recursive: true });
    await writeFailureState(statePath, { consecutiveFailures, alertSent, lastFailureReason });
    if (result === "failure") {
      logger.warn("saved the unresolved page incident.", { url, consecutiveFailures, alertSent });
    } else if (previous.consecutiveFailures > 0) {
      logger.info("the page recovered.", { url, previousConsecutiveFailures: previous.consecutiveFailures });
    }
  }
  return { url, result, consecutiveFailures, notified };
}

async function sendIncidentAlert(
  notify: TelegramNotifier | null,
  url: string,
  detail: string | null,
): Promise<boolean> {
  const reason = detail === null || detail.trim().length === 0
    ? "no failure detail was reported"
    : detail;
  try {
    const send = notify ?? createAdminTelegramNotifier();
    await send(`Page watch needs attention for ${url}: ${reason}`);
    logger.info("sent the page incident alert.", { url });
    return true;
  } catch (error: unknown) {
    logger.error("could not send the page watch failure alert. It will be retried on the next failure.", {
      url,
      error: errorDetail(error),
    });
    throw error;
  }
}

async function sendRecoveryAlert(notify: TelegramNotifier | null, url: string): Promise<boolean> {
  try {
    const send = notify ?? createAdminTelegramNotifier();
    await send(`Page watch recovery for ${url}: page checks work again.`);
    logger.info("sent the page recovery alert.", { url });
    return true;
  } catch (error: unknown) {
    logger.error("could not send the page watch recovery alert. It will be retried on the next success.", {
      url,
      error: errorDetail(error),
    });
    throw error;
  }
}

async function main(): Promise<void> {
  const url = process.argv[2];
  const result = process.argv[3];
  if (!url || (result !== "success" && result !== "failure")) {
    throw new Error("Usage: bin/record-url-result <url> <success|failure>");
  }
  process.stdout.write(`${JSON.stringify(await recordUrlResult(url, result))}\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch(fail);
}
