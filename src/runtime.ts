import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorDetail, logger } from "./logger.ts";

const MAX_TOOL_OUTPUT_BYTES = 50 * 1024 * 1024;

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function runTool(
  relativePath: string,
  arguments_: readonly string[],
  input?: string,
  acceptedStatuses: readonly number[] = [0],
): string {
  const startedAt = performance.now();
  logger.info(`Started ${relativePath}.`);
  const options: SpawnSyncOptionsWithStringEncoding = {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    input,
    maxBuffer: MAX_TOOL_OUTPUT_BYTES,
  };
  const result = spawnSync(resolve(PROJECT_ROOT, relativePath), arguments_, options);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  if (result.error) {
    logger.error(`${relativePath} could not start. ${result.error.message}`);
    throw new Error(`${relativePath} failed to start: ${result.error.message}`);
  }
  if (result.status === null || !acceptedStatuses.includes(result.status)) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    logger.error(`${relativePath} failed after ${Math.round(performance.now() - startedAt)} milliseconds with status ${String(result.status)}.`);
    throw new Error(`${relativePath} failed: ${detail}`);
  }
  logger.info(
    `${relativePath} finished after ${Math.round(performance.now() - startedAt)} milliseconds and returned ${Buffer.byteLength(result.stdout)} bytes.`,
  );
  return result.stdout;
}

export function getUrlCacheDirectory(url: string): string {
  const slug = runTool("bin/slugify", [url]).trim();
  if (slug.length === 0) {
    throw new Error(`bin/slugify returned an empty slug for ${url}`);
  }
  const cacheDirectory = resolve(PROJECT_ROOT, "cache", slug);
  logger.info(`Mapped the watched page to ${relative(PROJECT_ROOT, cacheDirectory)}.`);
  return cacheDirectory;
}

export function fail(error: unknown): never {
  logger.error(`The application stopped because ${errorDetail(error)}`);
  process.exit(1);
}
