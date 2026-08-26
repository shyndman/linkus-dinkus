import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PROJECT_ROOT, fail } from "./lib.ts";

type CronExpressions = readonly string[];
type SyncState = "initialized" | "unchanged" | "changed";
type SyncResult = Readonly<{
  state: SyncState;
  previous: CronExpressions | null;
  current: CronExpressions;
  installed: boolean;
}>;

const CACHE_PATH = resolve(PROJECT_ROOT, "cache", "poll-frequency.txt");
const LAUNCHER_PATH = resolve(PROJECT_ROOT, "bin", "run-page-watch");
const START_MARKER = "# BEGIN shoestring-page-watch";
const END_MARKER = "# END shoestring-page-watch";

function readCachedExpressions(): CronExpressions | null {
  try {
    const content = readFileSync(CACHE_PATH, "utf8").trimEnd();
    return content.split(/\r?\n/);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function readCrontab(): string {
  const result = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (result.error) throw new Error(`Could not read the crontab: ${result.error.message}`);
  if (result.status === 0) return result.stdout;
  if (result.status === 1 && result.stderr.toLowerCase().includes("no crontab")) return "";
  const detail = result.stderr.trim() || `exit status ${result.status}`;
  throw new Error(`Could not read the crontab: ${detail}`);
}

function removeManagedBlock(crontab: string): string {
  const keptLines: string[] = [];
  let insideManagedBlock = false;
  for (const line of crontab.replace(/\r\n/g, "\n").split("\n")) {
    if (line === START_MARKER) {
      insideManagedBlock = true;
      continue;
    }
    if (line === END_MARKER) {
      insideManagedBlock = false;
      continue;
    }
    if (!insideManagedBlock) keptLines.push(line);
  }
  if (insideManagedBlock) throw new Error(`The crontab is missing ${END_MARKER}`);
  return keptLines.join("\n").trimEnd();
}

function buildCrontab(existing: string, expressions: CronExpressions): string {
  const managedLines = [
    START_MARKER,
    ...expressions.map((expression: string): string => `${expression} ${LAUNCHER_PATH}`),
    END_MARKER,
  ];
  const unmanaged = removeManagedBlock(existing);
  const separator = unmanaged.length > 0 ? "\n\n" : "";
  return `${unmanaged}${separator}${managedLines.join("\n")}\n`;
}

function installCrontab(crontab: string): void {
  const result = spawnSync("crontab", ["-"], {
    encoding: "utf8",
    input: crontab,
  });
  if (result.error) throw new Error(`Could not install the crontab: ${result.error.message}`);
  if (result.status === 0) return;
  const detail = result.stderr.trim() || `exit status ${result.status}`;
  throw new Error(`Could not install the crontab: ${detail}`);
}

function main(): void {
  const desired: CronExpressions = process.argv.slice(2);
  const previous = readCachedExpressions();
  const currentCrontab = readCrontab();
  const desiredCrontab = buildCrontab(currentCrontab, desired);

  const normalizedCurrent = currentCrontab.length > 0
    ? `${currentCrontab.replace(/\r\n/g, "\n").trimEnd()}\n`
    : "";
  const installed = normalizedCurrent !== desiredCrontab;
  if (installed) installCrontab(desiredCrontab);
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, `${desired.join("\n")}\n`, "utf8");

  const unchanged = previous !== null
    && previous.length === desired.length
    && previous.every((expression: string, index: number): boolean => expression === desired[index]);
  const state: SyncState = previous === null ? "initialized" : unchanged ? "unchanged" : "changed";
  const result: SyncResult = { state, previous, current: desired, installed };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  main();
} catch (error: unknown) {
  fail(error);
}
