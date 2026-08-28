import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../logger.ts";
import { PROJECT_ROOT, fail, getUrlSnapshotDirectory, runTool } from "../runtime.ts";

const OUTER_HTML_EXPRESSION = "document.documentElement.outerHTML";
const RENDER_SETTLE_MILLISECONDS = 10_000;
const CONTENT_HASH_ALGORITHM = "sha256";

function utcTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
export async function storeHtmlSnapshot(
  snapshotDirectory: string,
  html: string,
  capturedAt: Date,
): Promise<string> {
  const objectDirectory = join(snapshotDirectory, "objects");
  await mkdir(objectDirectory, { recursive: true });

  const contentHash = createHash(CONTENT_HASH_ALGORITHM).update(html, "utf8").digest("hex");
  const objectName = `${contentHash}.html`;
  const objectPath = join(objectDirectory, objectName);
  try {
    await writeFile(objectPath, html, { encoding: "utf8", flag: "wx" });
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      logger.error("could not save the HTML snapshot object.", { object: objectName });
      throw error;
    }
  }

  const snapshotPath = join(snapshotDirectory, `snapshot-${utcTimestamp(capturedAt)}.html`);
  await symlink(join("objects", objectName), snapshotPath);
  logger.info("saved the content-addressed HTML snapshot.", {
    snapshot: basename(snapshotPath),
    object: objectName,
    bytes: Buffer.byteLength(html),
  });
  return snapshotPath;
}


export async function capturePage(url: string): Promise<string> {
  logger.info("preparing a rendered page snapshot.");

  const snapshotDirectory = await getUrlSnapshotDirectory(url);
  await mkdir(snapshotDirectory, { recursive: true });
  logger.info("snapshot directory is ready. The browser will settle before capture.", {
    settleMilliseconds: RENDER_SETTLE_MILLISECONDS,
  });
  await runTool("bin/camou", ["open", url]);
  await runTool("bin/camou", ["wait", String(RENDER_SETTLE_MILLISECONDS)]);
  logger.info("rendered page settled. Reading the document HTML.");

  const html = await runTool("bin/camou", ["eval", OUTER_HTML_EXPRESSION]);
  if (!html.trimStart().startsWith("<html")) {
    logger.error("browser response did not start with an HTML document.", {
      bytes: Buffer.byteLength(html),
    });
    throw new Error(`Camoufox returned invalid HTML for ${url}`);
  }
  logger.info("browser returned a valid HTML document.", { bytes: Buffer.byteLength(html) });

  const snapshotPath = await storeHtmlSnapshot(snapshotDirectory, html, new Date());
  return relative(PROJECT_ROOT, snapshotPath);
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) throw new Error("Usage: bin/capture-page <url>");
  process.stdout.write(`${await capturePage(url)}\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch(fail);
}
