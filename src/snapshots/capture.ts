import { createHash } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../logger.ts";
import { PROJECT_ROOT, fail, getUrlSnapshotDirectory, runTool } from "../runtime.ts";

const OUTER_HTML_EXPRESSION = "document.documentElement.outerHTML";
const RENDER_SETTLE_MILLISECONDS = 2_000;
const CONTENT_HASH_ALGORITHM = "sha256";

function utcTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
export function storeHtmlSnapshot(snapshotDirectory: string, html: string, capturedAt: Date): string {
  const objectDirectory = join(snapshotDirectory, "objects");
  mkdirSync(objectDirectory, { recursive: true });

  const contentHash = createHash(CONTENT_HASH_ALGORITHM).update(html, "utf8").digest("hex");
  const objectName = `${contentHash}.html`;
  const objectPath = join(objectDirectory, objectName);
  if (!existsSync(objectPath)) writeFileSync(objectPath, html, "utf8");

  const snapshotPath = join(snapshotDirectory, `snapshot-${utcTimestamp(capturedAt)}.html`);
  symlinkSync(join("objects", objectName), snapshotPath);
  logger.info("Saved the content-addressed HTML snapshot.", {
    snapshot: basename(snapshotPath),
    object: objectName,
    bytes: Buffer.byteLength(html),
  });
  return snapshotPath;
}


export function capturePage(url: string): string {
  logger.info("Preparing a rendered page snapshot.");

  const snapshotDirectory = getUrlSnapshotDirectory(url);
  mkdirSync(snapshotDirectory, { recursive: true });
  logger.info("The snapshot directory is ready. The browser will settle before capture.", {
    settleMilliseconds: RENDER_SETTLE_MILLISECONDS,
  });
  runTool("bin/camou", ["open", url]);
  runTool("bin/camou", ["wait", String(RENDER_SETTLE_MILLISECONDS)]);
  logger.info("The rendered page settled. Reading the document HTML.");

  const html = runTool("bin/camou", ["eval", OUTER_HTML_EXPRESSION]);
  if (!html.trimStart().startsWith("<html")) {
    logger.error("The browser response did not start with an HTML document.", {
      bytes: Buffer.byteLength(html),
    });
    throw new Error(`Camoufox returned invalid HTML for ${url}`);
  }
  logger.info("The browser returned a valid HTML document.", { bytes: Buffer.byteLength(html) });

  const snapshotPath = storeHtmlSnapshot(snapshotDirectory, html, new Date());
  return relative(PROJECT_ROOT, snapshotPath);
}

function main(): void {
  const url = process.argv[2];
  if (!url) throw new Error("Usage: bin/capture-page <url>");
  process.stdout.write(`${capturePage(url)}\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    main();
  } catch (error: unknown) {
    fail(error);
  }
}
