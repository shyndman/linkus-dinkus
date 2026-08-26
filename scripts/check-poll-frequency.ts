import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT, fail } from "./lib.ts";

type CronExpressions = readonly string[];
type PollState =
  | Readonly<{ state: "initialized"; current: CronExpressions }>
  | Readonly<{ state: "unchanged"; current: CronExpressions }>
  | Readonly<{ state: "changed"; previous: CronExpressions; desired: CronExpressions }>;

const CACHE_PATH = resolve(PROJECT_ROOT, "cache", "poll-frequency.txt");


function readCachedExpressions(): CronExpressions | null {
  try {
    const content = readFileSync(CACHE_PATH, "utf8").trimEnd();
    return content.split(/\r?\n/);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function main(): void {
  const desired: CronExpressions = process.argv.slice(2);
  const previous = readCachedExpressions();
  let result: PollState;

  if (previous === null) {
    writeFileSync(CACHE_PATH, `${desired.join("\n")}\n`, "utf8");
    result = { state: "initialized", current: desired };
  } else {
    const unchanged = previous.length === desired.length
      && previous.every((expression: string, index: number): boolean => {
        return expression === desired[index];
      });
    result = unchanged
      ? { state: "unchanged", current: desired }
      : { state: "changed", previous, desired };
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  main();
} catch (error: unknown) {
  fail(error);
}
