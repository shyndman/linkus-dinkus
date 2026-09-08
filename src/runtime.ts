import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import slugify, { type Options as SlugifyOptions } from "@sindresorhus/slugify";
import { config } from "dotenv";
import { errorDetail, logger } from "./logger.ts";

const MAX_TOOL_OUTPUT_BYTES = 50 * 1024 * 1024;
const URL_SLUG_OPTIONS = {
  customReplacements: [["&", " "]],
  decamelize: false,
} as const satisfies SlugifyOptions;

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ENV_PATH = resolve(PROJECT_ROOT, ".env");
config({ path: PROJECT_ENV_PATH, quiet: true });

export async function runTool(
  relativePath: string,
  arguments_: readonly string[],
  acceptedStatuses: readonly number[] = [0],
): Promise<string> {
  const startedAt = performance.now();
  const command = resolve(PROJECT_ROOT, relativePath);
  return new Promise<string>((resolveOutput, rejectOutput): void => {
    const child = spawn(command, arguments_, {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;

    function captureOutput(chunks: Buffer[], chunk: Buffer): void {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_TOOL_OUTPUT_BYTES) {
        child.kill();
        rejectOutput(new Error(`${relativePath} produced more than ${MAX_TOOL_OUTPUT_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    }

    child.stdout.on("data", (chunk: Buffer): void => captureOutput(stdoutChunks, chunk));
    child.stderr.on("data", (chunk: Buffer): void => captureOutput(stderrChunks, chunk));
    child.once("error", (error: Error): void => {
      logger.error("a subprocess could not start.", { command: relativePath, error: error.message });
      rejectOutput(new Error(`${relativePath} failed to start: ${error.message}`));
    });
    child.once("close", (status: number | null): void => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (stderr.length > 0) process.stderr.write(stderr);
      if (status === null || !acceptedStatuses.includes(status)) {
        const detail = stderr.trim() || stdout.trim() || `exit status ${status}`;
        logger.error("a subprocess failed.", {
          command: relativePath,
          durationMilliseconds: Math.round(performance.now() - startedAt),
          status,
        });
        rejectOutput(new Error(`${relativePath} failed: ${detail}`));
        return;
      }
      resolveOutput(stdout);
    });
  });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    logger.error("could not examine a path.", { path });
    throw error;
  }
}

export async function getUrlSnapshotDirectory(url: string): Promise<string> {
  const slug = slugify(url, URL_SLUG_OPTIONS);
  if (slug.length === 0) {
    throw new Error(`could not create a snapshot directory slug for ${url}`);
  }
  const snapshotDirectory = resolve(PROJECT_ROOT, "snapshots", slug);
  logger.info("mapped the watched page to its snapshot directory.", {
    snapshotDirectory: relative(PROJECT_ROOT, snapshotDirectory),
  });
  return snapshotDirectory;
}

export function fail(error: unknown): never {
  logger.fatal("application stopped.", { error: errorDetail(error) });
  process.exit(1);
}
