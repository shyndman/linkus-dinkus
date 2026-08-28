import { stat } from "node:fs/promises";
import { basename, extname, relative } from "node:path";
import { logger } from "../logger.ts";
import { PROJECT_ROOT, fail, pathExists, runTool } from "../runtime.ts";

async function main(): Promise<void> {
  const snapshotPath = process.argv[2];
  if (!snapshotPath) throw new Error("Usage: bin/defuddle-snapshot <snapshot.html>");
  if (!(await pathExists(snapshotPath))) throw new Error(`Snapshot does not exist: ${snapshotPath}`);
  if (extname(snapshotPath) !== ".html") throw new Error(`Snapshot must be an HTML file: ${snapshotPath}`);
  logger.info("creating draft Markdown.", { snapshot: basename(snapshotPath) });

  const outputPath = snapshotPath.slice(0, -".html".length) + ".draft.md";
  await runTool("bin/defuddle", ["parse", "--markdown", "--output", outputPath, snapshotPath]);
  logger.info("saved the draft Markdown.", {
    snapshot: basename(outputPath),
    bytes: (await stat(outputPath)).size,
  });
  process.stdout.write(`${relative(PROJECT_ROOT, outputPath)}\n`);
}

main().catch(fail);
