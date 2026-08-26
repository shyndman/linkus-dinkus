import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_ROOT, fail, runTool } from "./lib.ts";

type BaselineResult = Readonly<{ state: "baseline"; current: string }>;
type ComparisonResult = Readonly<{
  state: "unchanged" | "changed";
  previous: string;
  current: string;
  diff: string;
}>;

const CANONICAL_SNAPSHOT_PATTERN = /^snapshot-\d{8}T\d{6}Z\.md$/;

function main(): void {
  const cacheDirectory = process.argv[2];
  if (!cacheDirectory) throw new Error("Usage: bin/compare-snapshots <url-cache-directory>");

  const snapshots = readdirSync(cacheDirectory)
    .filter((name: string): boolean => CANONICAL_SNAPSHOT_PATTERN.test(name))
    .sort();
  if (snapshots.length === 0) throw new Error(`No canonical snapshots in ${cacheDirectory}`);

  const currentPath = join(cacheDirectory, snapshots.at(-1)!);
  if (snapshots.length === 1) {
    const result: BaselineResult = { state: "baseline", current: relative(PROJECT_ROOT, currentPath) };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const previousPath = join(cacheDirectory, snapshots.at(-2)!);
  const previousContent = readFileSync(previousPath, "utf8");
  const currentContent = readFileSync(currentPath, "utf8");
  const previousName = relative(PROJECT_ROOT, previousPath);
  const currentName = relative(PROJECT_ROOT, currentPath);
  const changed = previousContent !== currentContent;
  const diffArguments = [
    "--unified=3",
    "--label",
    previousName,
    "--label",
    currentName,
    previousPath,
    currentPath,
  ];
  const diff = changed
    ? runTool("/usr/bin/diff", diffArguments, undefined, [0, 1])
    : "";
  const result: ComparisonResult = {
    state: changed ? "changed" : "unchanged",
    previous: previousName,
    current: currentName,
    diff,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  main();
} catch (error: unknown) {
  fail(error);
}
