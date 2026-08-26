import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_TOOL_OUTPUT_BYTES = 50 * 1024 * 1024;

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function runTool(
  relativePath: string,
  arguments_: readonly string[],
  input?: string,
  acceptedStatuses: readonly number[] = [0],
): string {
  const options: SpawnSyncOptionsWithStringEncoding = {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    input,
    maxBuffer: MAX_TOOL_OUTPUT_BYTES,
  };
  const result = spawnSync(resolve(PROJECT_ROOT, relativePath), arguments_, options);
  if (result.error) {
    throw new Error(`${relativePath} failed to start: ${result.error.message}`);
  }
  if (result.status === null || !acceptedStatuses.includes(result.status)) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    throw new Error(`${relativePath} failed: ${detail}`);
  }
  return result.stdout;
}

export function getUrlCacheDirectory(url: string): string {
  const slug = runTool("bin/slugify", [url]).trim();
  if (slug.length === 0) {
    throw new Error(`bin/slugify returned an empty slug for ${url}`);
  }
  return resolve(PROJECT_ROOT, "cache", slug);
}

export function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
