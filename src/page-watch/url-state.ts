import { accessSync, constants, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { logger } from "../logger.ts";
import { PROJECT_ROOT, fail, getUrlCacheDirectory } from "../runtime.ts";

type UrlState = "new" | "configured" | "incomplete";
type UrlStateResult = Readonly<{
  state: UrlState;
  cacheDirectory: string;
}>;

function main(): void {
  const url = process.argv[2];
  if (!url) throw new Error("Usage: bin/url-state <url>");

  const cacheDirectory = getUrlCacheDirectory(url);
  const extractorPath = join(cacheDirectory, "extract");
  logger.info("Checking whether this page has a usable saved extractor.");
  let state: UrlState;

  if (!existsSync(cacheDirectory)) {
    state = "new";
  } else if (!existsSync(extractorPath)) {
    state = "incomplete";
  } else {
    accessSync(extractorPath, constants.X_OK);
    state = "configured";
  }
  logger.info(`The page is ${state}. Its files are in ${relative(PROJECT_ROOT, cacheDirectory)}.`);

  const result: UrlStateResult = {
    state,
    cacheDirectory: relative(PROJECT_ROOT, cacheDirectory),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  main();
} catch (error: unknown) {
  fail(error);
}
