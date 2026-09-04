import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { logger } from "../logger.ts";
import { PROJECT_ROOT } from "../runtime.ts";

const HTML_CHANGE_COUNT_FILE = "html-change-count.txt";
const HTML_SNAPSHOT_PATTERN = /^snapshot-\d{8}T\d{6}Z\.html$/;

function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);
}

export async function htmlChanged(
  snapshotDirectory: string,
  currentSnapshot: string,
): Promise<boolean> {
  const directory = absolutePath(snapshotDirectory);
  const currentName = basename(currentSnapshot);
  const snapshots = (await readdir(directory))
    .filter((name: string): boolean => HTML_SNAPSHOT_PATTERN.test(name))
    .sort();
  logger.info("found HTML snapshots for comparison.", {
    snapshotCount: snapshots.length,
    currentSnapshot: currentName,
  });
  const currentIndex = snapshots.indexOf(currentName);
  if (currentIndex === -1) {
    logger.error("current HTML snapshot is missing.", {
      currentSnapshot: currentName,
      snapshotDirectory,
    });
    throw new Error(`Current HTML snapshot is absent from ${snapshotDirectory}: ${currentSnapshot}`);
  }
  if (currentIndex === 0) {
    logger.info("current HTML snapshot establishes the baseline.", { currentSnapshot: currentName });
    return false;
  }

  const previousName = snapshots[currentIndex - 1];
  if (previousName === undefined) return false;
  const [previous, current] = await Promise.all([
    readFile(join(directory, previousName)),
    readFile(join(directory, currentName)),
  ]);
  const changed = !previous.equals(current);
  logger.info(changed ? "rendered HTML changed." : "rendered HTML did not change.", {
    currentSnapshot: currentName,
    previousSnapshot: previousName,
    currentBytes: current.byteLength,
    previousBytes: previous.byteLength,
  });
  return changed;
}
async function readHtmlChangeCount(countPath: string): Promise<number> {
  try {
    const text = (await readFile(countPath, "utf8")).trim();
    if (!/^(0|[1-9]\d*)$/.test(text)) {
      logger.error("html change count is invalid.", { file: HTML_CHANGE_COUNT_FILE });
      throw new Error(`${countPath} does not contain a nonnegative integer`);
    }
    const count = Number(text);
    logger.info("read the saved HTML change count.", { changeCount: count });
    return count;
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    logger.info("no HTML change count exists yet. The count starts at zero.");
    return 0;
  }
}


export async function incrementHtmlChangeCount(snapshotDirectory: string): Promise<number> {
  const directory = absolutePath(snapshotDirectory);
  const countPath = join(directory, HTML_CHANGE_COUNT_FILE);
  const previous = await readHtmlChangeCount(countPath);
  const next = previous + 1;
  await mkdir(directory, { recursive: true });
  await writeFile(countPath, `${next}\n`, "utf8");
  logger.info("saved the HTML change count.", { changeCount: next });
  return next;
}

export async function rollbackHtmlChangeCount(snapshotDirectory: string): Promise<void> {
  const directory = absolutePath(snapshotDirectory);
  const countPath = join(directory, HTML_CHANGE_COUNT_FILE);
  const current = await readHtmlChangeCount(countPath);
  if (current === 0) {
    logger.error("cannot roll back an HTML change count of zero.", {
      file: HTML_CHANGE_COUNT_FILE,
    });
    throw new Error(`${countPath} cannot roll back below zero`);
  }
  const previous = current - 1;
  await writeFile(countPath, `${previous}\n`, "utf8");
  logger.info("rolled back the HTML change count.", { changeCount: previous });
}
