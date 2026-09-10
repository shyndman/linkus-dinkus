import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { APPLICATION_CONFIG } from "../config.ts";
import { errorDetail, getSiteLogTag, logger } from "../logger.ts";
import { PROJECT_ROOT, fail, getUrlSnapshotDirectory, runTool } from "../runtime.ts";

const OUTER_HTML_EXPRESSION = "document.documentElement.outerHTML";
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
      logger.error("could not save the HTML snapshot object.", { path: objectPath, error: errorDetail(error) });
      throw error;
    }
  }

  const snapshotPath = join(snapshotDirectory, `snapshot-${utcTimestamp(capturedAt)}.html`);
  await symlink(join("objects", objectName), snapshotPath);
  logger.debug("saved the content-addressed HTML snapshot.", {
    snapshot: basename(snapshotPath),
    object: objectName,
    bytes: Buffer.byteLength(html),
  });
  return snapshotPath;
}


export async function capturePage(url: string, renderSettleMs: number): Promise<string> {
  const startedAt = performance.now();
  logger.info("capturing the rendered page.");

  const snapshotDirectory = await getUrlSnapshotDirectory(url);
  const browserSession = getSiteLogTag();
  if (browserSession === undefined) {
    logger.error("cannot capture a page without a site log tag.");
    throw new Error("Page capture requires a site log tag");
  }
  const sessionArguments = ["--session", browserSession] as const;
  await mkdir(snapshotDirectory, { recursive: true });
  logger.debug("snapshot directory is ready. The browser will settle before capture.", {
    settleMs: renderSettleMs,
  });
  try {
    await runTool("bin/camou", [...sessionArguments, "open", url]);
    await runTool("bin/camou", [
      ...sessionArguments,
      "wait",
      String(renderSettleMs),
    ]);
    logger.debug("rendered page settled. Reading the document HTML.");

    const html = await runTool("bin/camou", [...sessionArguments, "eval", OUTER_HTML_EXPRESSION]);
    if (!html.trimStart().startsWith("<html")) {
      logger.error("browser response did not start with an HTML document.", {
        bytes: Buffer.byteLength(html),
      });
      throw new Error(`Camoufox returned invalid HTML for ${url}`);
    }
    logger.debug("browser returned a valid HTML document.", { bytes: Buffer.byteLength(html) });

    const snapshotPath = await storeHtmlSnapshot(snapshotDirectory, html, new Date());
    logger.info("saved the rendered page.", {
      snapshot: basename(snapshotPath),
      bytes: Buffer.byteLength(html),
      durationMs: Math.round(performance.now() - startedAt),
    });
    return relative(PROJECT_ROOT, snapshotPath);
  } catch (error: unknown) {
    logger.error("page capture failed.", { url, error: errorDetail(error) });
    throw error;
  } finally {
    logger.debug("closing the browser session.");
    await runTool("bin/camou", [...sessionArguments, "close"]);
  }
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) throw new Error("Usage: bin/capture-page <url>");
  process.stdout.write(`${await capturePage(url, APPLICATION_CONFIG.snapshots.renderSettleMs)}\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch(fail);
}
