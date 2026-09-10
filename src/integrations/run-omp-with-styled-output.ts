import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { logger, SITE_LOG_TAG_ENVIRONMENT_VARIABLE } from "../logger.ts";
import { fail, PROJECT_ROOT } from "../runtime.ts";

const OUTPUT_INDENT = "  ";
const OUTPUT_COLOR = "\u001b[38;2;180;180;180m";
const RESET_COLOR = "\u001b[0m";
const LOG_PREFIX_PATTERN = /^\d{2,}:\d{2}\.\d{3} \[(?:dbug|info|warn|err!|crit)\] /;

async function writeOutputLine(line: string): Promise<void> {
  const message = line.replace(LOG_PREFIX_PATTERN, "");
  const site = process.env[SITE_LOG_TAG_ENVIRONMENT_VARIABLE];
  const sitePrefix = site === undefined ? "" : `site: ${site} `;
  const output = `${OUTPUT_COLOR}${OUTPUT_INDENT}${sitePrefix}${message}${RESET_COLOR}\n`;
  if (!process.stderr.write(output)) await once(process.stderr, "drain");
}

async function forwardOutput(input: Readable): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) await writeOutputLine(line);
}

async function main(): Promise<void> {
  const ompArguments: readonly string[] = process.argv.slice(2);
  if (ompArguments.length === 0) throw new Error("The styled OMP runner requires OMP arguments.");

  const child = spawn("omp", ompArguments, {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const close = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  const [, , [status, signal]] = await Promise.all([
    forwardOutput(child.stdout),
    forwardOutput(child.stderr),
    close,
  ]);
  if (status !== 0) {
    logger.error("OMP process failed.", { status, signal });
    process.exitCode = status ?? 1;
  }
}

main().catch(fail);
