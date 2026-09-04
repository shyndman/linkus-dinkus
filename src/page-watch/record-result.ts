import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APPLICATION_CONFIG } from "../config.ts";
import { logger } from "../logger.ts";
import { fail, getUrlSnapshotDirectory } from "../runtime.ts";
import { createTelegramNotifier } from "../integrations/telegram.ts";

export type UrlResult = "success" | "failure";
type FailureState = Readonly<{ consecutiveFailures: number }>;
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
    const consecutiveFailures = value.consecutiveFailures as number;
    logger.info("read the failure streak.", { consecutiveFailures });
    return { consecutiveFailures };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      logger.info("no failure state exists yet. The failure streak starts at zero.");
      return { consecutiveFailures: 0 };
    }
    logger.error("could not read the failure state.", { path });
    throw error;
  }
}

async function writeFailureState(path: string, state: FailureState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state)}\n`, "utf8");
}

export async function recordUrlResult(url: string, result: UrlResult): Promise<RecordResult> {
  logger.info("recording the result of one watched page.");
  const snapshotDirectory = await getUrlSnapshotDirectory(url);
  const statePath = join(snapshotDirectory, STATE_FILENAME);
  const previous = await readFailureState(statePath);
  const consecutiveFailures = result === "success" ? 0 : previous.consecutiveFailures + 1;
  logger.info(
    result === "success" ? "page succeeded." : "page failed.",
    {
      previousConsecutiveFailures: previous.consecutiveFailures,
      consecutiveFailures,
    },
  );
  let notified = false;

  if (consecutiveFailures === APPLICATION_CONFIG.pageChecks.failureNotificationThreshold) {
    logger.warn("failure streak reached the notification threshold.", {
      consecutiveFailures,
      notificationThreshold: APPLICATION_CONFIG.pageChecks.failureNotificationThreshold,
    });
    const notify = createTelegramNotifier();
    await notify(`Page watch failed for ${url} three times in a row.`);
    notified = true;
  }
  if (
    result === "failure"
    && consecutiveFailures !== APPLICATION_CONFIG.pageChecks.failureNotificationThreshold
  ) {
    logger.info("failure streak does not trigger a notification.", {
      consecutiveFailures,
      notificationThreshold: APPLICATION_CONFIG.pageChecks.failureNotificationThreshold,
    });
  }

  await mkdir(snapshotDirectory, { recursive: true });
  await writeFailureState(statePath, { consecutiveFailures });
  return { url, result, consecutiveFailures, notified };
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
