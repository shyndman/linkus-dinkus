import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.ts";
import { fail, getUrlCacheDirectory } from "../runtime.ts";
import { createTelegramNotifier } from "../integrations/telegram.ts";

type UrlResult = "success" | "failure";
type FailureState = Readonly<{ consecutiveFailures: number }>;
type RecordResult = Readonly<{
  url: string;
  result: UrlResult;
  consecutiveFailures: number;
  notified: boolean;
}>;

const FAILURE_THRESHOLD = 3;
const STATE_FILENAME = "failure-state.json";

function readFailureState(path: string): FailureState {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
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
    logger.info(`Read a failure streak of ${consecutiveFailures}.`);
    return { consecutiveFailures };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      logger.info("No failure state exists yet. The failure streak starts at zero.");
      return { consecutiveFailures: 0 };
    }
    throw error;
  }
}

function writeFailureState(path: string, state: FailureState): void {
  writeFileSync(path, `${JSON.stringify(state)}\n`, "utf8");
  logger.info(`Saved a failure streak of ${state.consecutiveFailures}.`);
}

async function main(): Promise<void> {
  const url = process.argv[2];
  const result = process.argv[3];
  if (!url || (result !== "success" && result !== "failure")) {
    throw new Error("Usage: bin/record-url-result <url> <success|failure>");
  }
  logger.info("Recording the result of one watched page.");

  const cacheDirectory = getUrlCacheDirectory(url);
  const statePath = join(cacheDirectory, STATE_FILENAME);
  const previous = readFailureState(statePath);
  const consecutiveFailures = result === "success" ? 0 : previous.consecutiveFailures + 1;
  logger.info(
    result === "success"
      ? `The page succeeded. Its failure streak changed from ${previous.consecutiveFailures} to zero.`
      : `The page failed. Its failure streak changed from ${previous.consecutiveFailures} to ${consecutiveFailures}.`,
  );
  let notified = false;

  if (consecutiveFailures === FAILURE_THRESHOLD) {
    logger.warn(`The failure streak reached ${FAILURE_THRESHOLD}. Sending one notification.`);
    const notify = createTelegramNotifier();
    await notify(`Page watch failed for ${url} three times in a row.`);
    notified = true;
  }
  if (result === "failure" && consecutiveFailures !== FAILURE_THRESHOLD) {
    logger.info(`The failure streak did not equal the notification threshold of ${FAILURE_THRESHOLD}.`);
  }

  mkdirSync(cacheDirectory, { recursive: true });
  writeFailureState(statePath, { consecutiveFailures });
  const output: RecordResult = { url, result, consecutiveFailures, notified };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch(fail);
