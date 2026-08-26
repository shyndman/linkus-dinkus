import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, getUrlCacheDirectory } from "./lib.ts";
import { createTelegramNotifier } from "./telegram.ts";

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
    return { consecutiveFailures: value.consecutiveFailures as number };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { consecutiveFailures: 0 };
    }
    throw error;
  }
}

function writeFailureState(path: string, state: FailureState): void {
  writeFileSync(path, `${JSON.stringify(state)}\n`, "utf8");
}

async function main(): Promise<void> {
  const url = process.argv[2];
  const result = process.argv[3];
  if (!url || (result !== "success" && result !== "failure")) {
    throw new Error("Usage: bin/record-url-result <url> <success|failure>");
  }

  const cacheDirectory = getUrlCacheDirectory(url);
  const statePath = join(cacheDirectory, STATE_FILENAME);
  const previous = readFailureState(statePath);
  const consecutiveFailures = result === "success" ? 0 : previous.consecutiveFailures + 1;
  let notified = false;

  if (consecutiveFailures === FAILURE_THRESHOLD) {
    const notify = createTelegramNotifier();
    await notify(`Page watch failed for ${url} three times in a row.`);
    notified = true;
  }

  mkdirSync(cacheDirectory, { recursive: true });
  writeFailureState(statePath, { consecutiveFailures });
  const output: RecordResult = { url, result, consecutiveFailures, notified };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch(fail);
