import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { logger } from "../logger.ts";
import { PROJECT_ROOT, fail, getUrlCacheDirectory, runTool } from "../runtime.ts";

const OUTER_HTML_EXPRESSION = "document.documentElement.outerHTML";
const RENDER_SETTLE_MILLISECONDS = 2_000;

function utcTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function main(): void {
  const url = process.argv[2];
  if (!url) throw new Error("Usage: bin/capture-page <url>");
  logger.info("Preparing a rendered page snapshot.");

  const cacheDirectory = getUrlCacheDirectory(url);
  mkdirSync(cacheDirectory, { recursive: true });
  logger.info(`The cache directory is ready. The browser will settle for ${RENDER_SETTLE_MILLISECONDS} milliseconds.`);
  runTool("bin/camou", ["open", url]);
  runTool("bin/camou", ["wait", String(RENDER_SETTLE_MILLISECONDS)]);
  logger.info("The rendered page settled. Reading the document HTML.");

  const html = runTool("bin/camou", ["eval", OUTER_HTML_EXPRESSION]);
  if (!html.trimStart().startsWith("<html")) {
    logger.error(`The browser returned ${Buffer.byteLength(html)} bytes that did not start with an HTML document.`);
    throw new Error(`Camoufox returned invalid HTML for ${url}`);
  }
  logger.info(`The browser returned a valid HTML document with ${Buffer.byteLength(html)} bytes.`);

  const snapshotPath = join(cacheDirectory, `snapshot-${utcTimestamp(new Date())}.html`);
  writeFileSync(snapshotPath, html, "utf8");
  logger.info(`Saved ${basename(snapshotPath)} with ${Buffer.byteLength(html)} bytes.`);
  process.stdout.write(`${relative(PROJECT_ROOT, snapshotPath)}\n`);
}

try {
  main();
} catch (error: unknown) {
  fail(error);
}
