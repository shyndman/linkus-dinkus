import { existsSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { PROJECT_ROOT, fail, runTool } from "./lib.ts";

function main(): void {
  const snapshotPath = process.argv[2];
  if (!snapshotPath) throw new Error("Usage: bin/extract-snapshot <snapshot.html>");
  if (!existsSync(snapshotPath)) throw new Error(`Snapshot does not exist: ${snapshotPath}`);
  if (extname(snapshotPath) !== ".html") throw new Error(`Snapshot must be an HTML file: ${snapshotPath}`);

  const extractorPath = join(dirname(snapshotPath), "extract");
  if (!existsSync(extractorPath)) throw new Error(`Extractor does not exist: ${extractorPath}`);

  const markdown = runTool(extractorPath, [snapshotPath]);
  const outputPath = snapshotPath.slice(0, -".html".length) + ".md";
  writeFileSync(outputPath, markdown, "utf8");
  process.stdout.write(`${relative(PROJECT_ROOT, outputPath)}\n`);
}

try {
  main();
} catch (error: unknown) {
  fail(error);
}
