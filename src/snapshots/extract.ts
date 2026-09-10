import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { errorDetail, logger } from "../logger.ts";
import { JudgmentResultSchema, type JudgmentResult } from "../page-watch/judgment.ts";
import { PROJECT_ROOT, fail, pathExists, runTool } from "../runtime.ts";

const EXTRACTOR_OUTPUT_SCHEMA = z.strictObject({
  markdown: z.string(),
  jobCount: z.number().int().nonnegative(),
});
const SNAPSHOT_STATISTICS_SCHEMA = EXTRACTOR_OUTPUT_SCHEMA.pick({ jobCount: true });

type ExtractorOutput = Readonly<z.infer<typeof EXTRACTOR_OUTPUT_SCHEMA>>;

const STATISTICS_SUFFIX = ".stats.json";
const INSPECTION_SUFFIX = ".inspection.json";
const MARKDOWN_SUFFIX = ".md";
const HTML_SUFFIX = ".html";

function parseExtractorOutput(stdout: string, extractorPath: string): ExtractorOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error: unknown) {
    logger.error("the extractor did not return JSON.", { extractorPath, error: errorDetail(error) });
    throw new Error(`${extractorPath} did not return a JSON extraction result: ${errorDetail(error)}`);
  }
  const result = EXTRACTOR_OUTPUT_SCHEMA.safeParse(parsed);
  if (!result.success) {
    logger.error("the extraction result is invalid.", { extractorPath, error: result.error.message });
    throw new Error(`${extractorPath} returned an invalid extraction result: ${result.error.message}`);
  }
  return result.data;
}

async function runExtractor(extractorPath: string, snapshotPath: string): Promise<ExtractorOutput> {
  const stdout = await runTool(extractorPath, [snapshotPath]);
  return parseExtractorOutput(stdout, extractorPath);
}

function siblingPath(snapshotPath: string, suffix: string): string {
  const extension = extname(snapshotPath);
  return snapshotPath.slice(0, -extension.length) + suffix;
}

async function readJobCountFromStatistics(path: string): Promise<number | null> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    logger.error("could not read snapshot statistics.", { path, error: errorDetail(error) });
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error: unknown) {
    logger.error("snapshot statistics contain invalid JSON.", { path, error: errorDetail(error) });
    throw new Error(`Invalid snapshot statistics in ${path}: ${errorDetail(error)}`, { cause: error });
  }
  const result = SNAPSHOT_STATISTICS_SCHEMA.safeParse(parsed);
  if (!result.success) {
    logger.error("the snapshot statistics are invalid.", { path, error: result.error.message });
    throw new Error(`invalid snapshot statistics sidecar: ${path}`);
  }
  return result.data.jobCount;
}

async function extractJobCountFromHtml(htmlPath: string): Promise<number> {
  if (!(await pathExists(htmlPath))) throw new Error(`Snapshot does not exist: ${htmlPath}`);
  const extractorPath = join(dirname(htmlPath), "extract");
  if (!(await pathExists(extractorPath))) throw new Error(`Extractor does not exist: ${extractorPath}`);
  const output = await runExtractor(extractorPath, htmlPath);
  logger.info("derived the job count from a legacy snapshot with the current extractor.", {
    snapshot: basename(htmlPath),
    jobCount: output.jobCount,
  });
  return output.jobCount;
}

export async function extractSnapshot(snapshotPath: string): Promise<string> {
  const startedAt = performance.now();
  if (!(await pathExists(snapshotPath))) throw new Error(`Snapshot does not exist: ${snapshotPath}`);
  if (extname(snapshotPath) !== ".html") throw new Error(`Snapshot must be an HTML file: ${snapshotPath}`);

  const extractorPath = join(dirname(snapshotPath), "extract");
  if (!(await pathExists(extractorPath))) throw new Error(`Extractor does not exist: ${extractorPath}`);
  logger.debug("running the saved extractor.", { extractorPath, snapshot: basename(snapshotPath) });

  const { markdown, jobCount } = await runExtractor(extractorPath, snapshotPath);
  logger.debug("extractor returned canonical Markdown.", {
    bytes: Buffer.byteLength(markdown),
    jobCount,
  });
  const outputPath = siblingPath(snapshotPath, MARKDOWN_SUFFIX);
  const statisticsPath = siblingPath(snapshotPath, STATISTICS_SUFFIX);
  await Promise.all([
    writeFile(outputPath, markdown, "utf8"),
    writeFile(statisticsPath, `${JSON.stringify({ jobCount })}\n`, "utf8"),
  ]);
  logger.info("saved the canonical Markdown and the job-count sidecar.", {
    snapshot: basename(outputPath),
    bytes: Buffer.byteLength(markdown),
    jobCount,
    durationMs: Math.round(performance.now() - startedAt),
  });
  return relative(PROJECT_ROOT, outputPath);
}

// Historical snapshots do not have counts. Derive each count once without changing the saved Markdown.
export async function readSnapshotJobCount(canonicalPath: string): Promise<number> {
  if (extname(canonicalPath) !== MARKDOWN_SUFFIX) {
    throw new Error(`Snapshot must be a Markdown file: ${canonicalPath}`);
  }
  const statisticsPath = siblingPath(canonicalPath, STATISTICS_SUFFIX);
  const storedCount = await readJobCountFromStatistics(statisticsPath);
  if (storedCount !== null) return storedCount;
  const jobCount = await extractJobCountFromHtml(siblingPath(canonicalPath, HTML_SUFFIX));
  await writeFile(statisticsPath, `${JSON.stringify({ jobCount })}\n`, "utf8");
  return jobCount;
}

/** Persists a zero-job inspection judgment beside the canonical snapshot. */
export async function recordSnapshotInspection(
  canonicalPath: string,
  previousJobCount: number,
  judgment: JudgmentResult,
): Promise<void> {
  const validated = JudgmentResultSchema.parse(judgment);
  const inspectionPath = siblingPath(canonicalPath, INSPECTION_SUFFIX);
  await writeFile(
    inspectionPath,
    `${JSON.stringify({ previousJobCount, judgment: validated }, null, 2)}\n`,
    "utf8",
  );
  logger.debug("recorded the zero-job inspection result.", {
    snapshot: basename(canonicalPath),
    state: validated.state,
    previousJobCount,
  });
}

async function main(): Promise<void> {
  const snapshotPath = process.argv[2];
  if (!snapshotPath) throw new Error("Usage: bin/extract-snapshot <snapshot.html>");
  process.stdout.write(`${await extractSnapshot(snapshotPath)}\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch(fail);
}
