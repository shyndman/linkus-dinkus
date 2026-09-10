import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../logger.ts";
import { PROJECT_ROOT, fail, runTool } from "../runtime.ts";

export type BaselineComparison = Readonly<{ state: "baseline"; current: string }>;
export type ChangedComparison = Readonly<{
  state: "changed";
  previous: string;
  current: string;
  diff: string;
}>;
export type UnchangedComparison = Readonly<{
  state: "unchanged";
  previous: string;
  current: string;
  diff: "";
}>;
export type SnapshotComparison = BaselineComparison | ChangedComparison | UnchangedComparison;

const CANONICAL_SNAPSHOT_PATTERN = /^snapshot-\d{8}T\d{6}Z\.md$/;
async function createUnifiedDiff(
  previousPath: string,
  currentPath: string,
  previousName: string,
  currentName: string,
): Promise<string> {
  return runTool("/usr/bin/diff", [
    "--unified=3",
    "--label",
    previousName,
    "--label",
    currentName,
    previousPath,
    currentPath,
  ], [0, 1]);
}


export async function compareSnapshots(snapshotDirectory: string): Promise<SnapshotComparison> {
  logger.debug("looking for canonical Markdown snapshots.");
  const snapshots = (await readdir(snapshotDirectory))
    .filter((name: string): boolean => CANONICAL_SNAPSHOT_PATTERN.test(name))
    .sort();
  logger.debug("found canonical Markdown snapshots.", { snapshotCount: snapshots.length });
  if (snapshots.length === 0) throw new Error(`No canonical snapshots in ${snapshotDirectory}`);

  const currentPath = join(snapshotDirectory, snapshots.at(-1)!);
  const currentName = relative(PROJECT_ROOT, currentPath);
  logger.debug("selected the current canonical snapshot.", { snapshot: basename(currentPath) });
  if (snapshots.length === 1) {
    logger.info("this is the first canonical snapshot, so it establishes the baseline.");
    return { state: "baseline", current: currentName };
  }

  const previousPath = join(snapshotDirectory, snapshots.at(-2)!);
  const [previousContent, currentContent] = await Promise.all([
    readFile(previousPath, "utf8"),
    readFile(currentPath, "utf8"),
  ]);
  const previousName = relative(PROJECT_ROOT, previousPath);
  logger.debug("comparing canonical snapshots.", {
    previousSnapshot: basename(previousPath),
    currentSnapshot: basename(currentPath),
  });
  if (previousContent === currentContent) {
    logger.debug("canonical Markdown did not change.", {
      bytes: Buffer.byteLength(currentContent),
    });
    return {
      state: "unchanged",
      previous: previousName,
      current: currentName,
      diff: "",
    };
  }

  logger.debug("canonical Markdown changed.", {
    previousBytes: Buffer.byteLength(previousContent),
    currentBytes: Buffer.byteLength(currentContent),
  });
  const diff = await createUnifiedDiff(previousPath, currentPath, previousName, currentName);
  logger.debug("created the unified difference.", { bytes: Buffer.byteLength(diff) });
  return {
    state: "changed",
    previous: previousName,
    current: currentName,
    diff,
  };
}

async function main(): Promise<void> {
  const snapshotDirectory = process.argv[2];
  if (!snapshotDirectory) throw new Error("Usage: bin/compare-snapshots <snapshot-directory>");
  process.stdout.write(`${JSON.stringify(await compareSnapshots(snapshotDirectory))}\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch(fail);
}
