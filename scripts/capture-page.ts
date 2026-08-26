import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_ROOT, fail, getUrlCacheDirectory, runTool } from "./lib.ts";

const OUTER_HTML_EXPRESSION = "document.documentElement.outerHTML";
const RENDER_SETTLE_MILLISECONDS = 2_000;

function utcTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function main(): void {
  const url = process.argv[2];
  if (!url) throw new Error("Usage: bin/capture-page <url>");

  const cacheDirectory = getUrlCacheDirectory(url);
  mkdirSync(cacheDirectory, { recursive: true });
  runTool("bin/camou", ["open", url]);
  runTool("bin/camou", ["wait", String(RENDER_SETTLE_MILLISECONDS)]);

  const html = runTool("bin/camou", ["eval", OUTER_HTML_EXPRESSION]);
  if (!html.trimStart().startsWith("<html")) {
    throw new Error(`Camoufox returned invalid HTML for ${url}`);
  }

  const snapshotPath = join(cacheDirectory, `snapshot-${utcTimestamp(new Date())}.html`);
  writeFileSync(snapshotPath, html, "utf8");
  process.stdout.write(`${relative(PROJECT_ROOT, snapshotPath)}\n`);
}

try {
  main();
} catch (error: unknown) {
  fail(error);
}
