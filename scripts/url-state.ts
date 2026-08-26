import { accessSync, constants, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_ROOT, fail, getUrlCacheDirectory } from "./lib.ts";

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
  let state: UrlState;

  if (!existsSync(cacheDirectory)) {
    state = "new";
  } else if (!existsSync(extractorPath)) {
    state = "incomplete";
  } else {
    accessSync(extractorPath, constants.X_OK);
    state = "configured";
  }

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
