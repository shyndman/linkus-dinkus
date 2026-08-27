import { existsSync, statSync } from "node:fs";
import { basename, extname, relative } from "node:path";
import { logger } from "../logger.ts";
import { PROJECT_ROOT, fail, runTool } from "../runtime.ts";

function main(): void {
  const snapshotPath = process.argv[2];
  if (!snapshotPath) throw new Error("Usage: bin/defuddle-snapshot <snapshot.html>");
  if (!existsSync(snapshotPath)) throw new Error(`Snapshot does not exist: ${snapshotPath}`);
  if (extname(snapshotPath) !== ".html") throw new Error(`Snapshot must be an HTML file: ${snapshotPath}`);
  logger.info("Creating draft Markdown.", { snapshot: basename(snapshotPath) });

  const outputPath = snapshotPath.slice(0, -".html".length) + ".draft.md";
  runTool("bin/defuddle", ["parse", "--markdown", "--output", outputPath, snapshotPath]);
  logger.info("Saved the draft Markdown.", {
    snapshot: basename(outputPath),
    bytes: statSync(outputPath).size,
  });
  process.stdout.write(`${relative(PROJECT_ROOT, outputPath)}\n`);
}

try {
  main();
} catch (error: unknown) {
  fail(error);
}
