import { access, constants } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../logger.ts";
import { SnapshotDirectorySchema, type SnapshotDirectory } from "./domain.ts";
import { PROJECT_ROOT, fail, getUrlSnapshotDirectory, pathExists } from "../runtime.ts";

export type UrlState = "new" | "configured" | "incomplete";
export type UrlStateResult = Readonly<{
  state: UrlState;
  snapshotDirectory: SnapshotDirectory;
}>;

export async function getUrlState(url: string): Promise<UrlStateResult> {
  const snapshotDirectory = await getUrlSnapshotDirectory(url);
  const extractorPath = join(snapshotDirectory, "extract");
  logger.info("checking whether this page has a usable saved extractor.");
  let state: UrlState;

  if (!(await pathExists(snapshotDirectory))) {
    state = "new";
  } else if (!(await pathExists(extractorPath))) {
    state = "incomplete";
  } else {
    await access(extractorPath, constants.X_OK);
    state = "configured";
  }
  const relativeSnapshotDirectory = relative(PROJECT_ROOT, snapshotDirectory);
  logger.info("read the page configuration state.", {
    state,
    snapshotDirectory: relativeSnapshotDirectory,
  });
  return {
    state,
    snapshotDirectory: SnapshotDirectorySchema.parse(relativeSnapshotDirectory),
  };
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) throw new Error("Usage: bin/url-state <url>");
  process.stdout.write(`${JSON.stringify(await getUrlState(url))}\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch(fail);
}
