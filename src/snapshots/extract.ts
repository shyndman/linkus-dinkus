import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../logger.ts";
import { PROJECT_ROOT, fail, runTool } from "../runtime.ts";

export function extractSnapshot(snapshotPath: string): string {
  if (!existsSync(snapshotPath)) throw new Error(`Snapshot does not exist: ${snapshotPath}`);
  if (extname(snapshotPath) !== ".html") throw new Error(`Snapshot must be an HTML file: ${snapshotPath}`);

  const extractorPath = join(dirname(snapshotPath), "extract");
  if (!existsSync(extractorPath)) throw new Error(`Extractor does not exist: ${extractorPath}`);
  logger.info("running the saved extractor.", { snapshot: basename(snapshotPath) });

  const markdown = runTool(extractorPath, [snapshotPath]);
  logger.info("extractor returned canonical Markdown.", { bytes: Buffer.byteLength(markdown) });
  const outputPath = snapshotPath.slice(0, -".html".length) + ".md";
  writeFileSync(outputPath, markdown, "utf8");
  logger.info("saved the canonical Markdown.", {
    snapshot: basename(outputPath),
    bytes: Buffer.byteLength(markdown),
  });
  return relative(PROJECT_ROOT, outputPath);
}

function main(): void {
  const snapshotPath = process.argv[2];
  if (!snapshotPath) throw new Error("Usage: bin/extract-snapshot <snapshot.html>");
  process.stdout.write(`${extractSnapshot(snapshotPath)}\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    main();
  } catch (error: unknown) {
    fail(error);
  }
}
