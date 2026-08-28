import { accessSync, constants, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../logger.ts";
import { PROJECT_ROOT, fail, getUrlSnapshotDirectory } from "../runtime.ts";

export type UrlState = "new" | "configured" | "incomplete";
export type UrlStateResult = Readonly<{
  state: UrlState;
  snapshotDirectory: string;
}>;

export function getUrlState(url: string): UrlStateResult {
  const snapshotDirectory = getUrlSnapshotDirectory(url);
  const extractorPath = join(snapshotDirectory, "extract");
  logger.info("checking whether this page has a usable saved extractor.");
  let state: UrlState;

  if (!existsSync(snapshotDirectory)) {
    state = "new";
  } else if (!existsSync(extractorPath)) {
    state = "incomplete";
  } else {
    accessSync(extractorPath, constants.X_OK);
    state = "configured";
  }
  const relativeSnapshotDirectory = relative(PROJECT_ROOT, snapshotDirectory);
  logger.info("read the page configuration state.", {
    state,
    snapshotDirectory: relativeSnapshotDirectory,
  });
  return { state, snapshotDirectory: relativeSnapshotDirectory };
}

function main(): void {
  const url = process.argv[2];
  if (!url) throw new Error("Usage: bin/url-state <url>");
  process.stdout.write(`${JSON.stringify(getUrlState(url))}\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    main();
  } catch (error: unknown) {
    fail(error);
  }
}
