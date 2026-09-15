import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { errorDetail, logger } from "../logger.ts";

const JOURNAL_RECORD_LIMIT = 100;
const JOURNAL_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const TELEGRAM_MESSAGE_CHARACTERS = 4000;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;

export type JournalFailureContext = Readonly<{
  unit: string;
  invocationId: string | null;
  serviceResult: string | null;
  exitCode: string | null;
  exitStatus: string | null;
  log: string;
  retrievalError: string | null;
}>;

type JournalMetadata = Readonly<{
  unit: string;
  invocationId: string | null;
  serviceResult: string | null;
  exitCode: string | null;
  exitStatus: string | null;
}>;

function retrieveJournalContext(
  metadata: JournalMetadata,
  invocationEnvironmentName: string,
  journalDescription: string,
  journalctl: typeof spawnSync = spawnSync,
): JournalFailureContext {
  try {
    if (metadata.invocationId === null) throw new Error(`systemd did not supply ${invocationEnvironmentName}`);
    const result = journalctl("journalctl", [
      "--user", "--quiet", "--no-pager", "--output=cat", `--lines=${JOURNAL_RECORD_LIMIT}`,
      `_SYSTEMD_INVOCATION_ID=${metadata.invocationId}`,
      "+", `USER_INVOCATION_ID=${metadata.invocationId}`,
    ], { encoding: "utf8", maxBuffer: JOURNAL_OUTPUT_LIMIT_BYTES });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || `journalctl exited with status ${result.status}`);
    const log = stripVTControlCharacters(result.stdout).trim();
    if (log.length === 0) throw new Error("the journal returned no records for this invocation");
    return { ...metadata, log, retrievalError: null };
  } catch (error: unknown) {
    const retrievalError = errorDetail(error);
    logger.error(`could not read the ${journalDescription}.`, { unit: metadata.unit, error: retrievalError });
    return { ...metadata, log: "", retrievalError };
  }
}

export function retrieveJournalFailureContext(): JournalFailureContext {
  return retrieveJournalContext({
    unit: process.env.MONITOR_UNIT ?? "Linkus Dinkus",
    invocationId: process.env.MONITOR_INVOCATION_ID ?? null,
    serviceResult: process.env.MONITOR_SERVICE_RESULT ?? null,
    exitCode: process.env.MONITOR_EXIT_CODE ?? null,
    exitStatus: process.env.MONITOR_EXIT_STATUS ?? null,
  }, "MONITOR_INVOCATION_ID", "failed invocation journal");
}

export function retrieveCurrentJournalContext(
  environment: NodeJS.ProcessEnv = process.env,
  journalctl: typeof spawnSync = spawnSync,
): JournalFailureContext {
  return retrieveJournalContext({
    unit: environment.MONITOR_UNIT ?? "Linkus Dinkus",
    invocationId: environment.INVOCATION_ID ?? null,
    serviceResult: null,
    exitCode: null,
    exitStatus: null,
  }, "INVOCATION_ID", "current invocation journal", journalctl);
}

function appendJournalDetails(
  lines: string[],
  context: JournalFailureContext,
  detailsDescription = "failure details",
): void {
  if (context.retrievalError !== null) lines.push(`\nCould not read the ${detailsDescription}: ${context.retrievalError}`);
  if (context.log.length > 0) lines.push(`\nJournal excerpt (up to ${JOURNAL_RECORD_LIMIT} records):\n${context.log}`);
}

export function buildFailureNotificationText(context: JournalFailureContext): string {
  const lines = [`${context.unit} failed.`];
  if (context.serviceResult !== null) lines.push(`Result: ${context.serviceResult}`);
  if (context.exitCode !== null) lines.push(`Exit code: ${context.exitCode}`);
  if (context.exitStatus !== null) lines.push(`Exit status: ${context.exitStatus}`);
  if (context.invocationId !== null) lines.push(`Invocation: ${context.invocationId}`);
  appendJournalDetails(lines, context);
  return lines.join("\n");
}

export function buildPageIncidentNotificationText(
  url: string,
  consecutiveFailures: number,
  detail: string | null,
  context: JournalFailureContext,
): string {
  const reason = detail === null || detail.trim().length === 0 ? "no failure detail was reported" : detail;
  const lines = [`Page watch needs attention for ${url}.`, `${consecutiveFailures} consecutive page checks failed.`, `Latest failure: ${reason}`];
  appendJournalDetails(lines, context, "current run journal");
  return lines.join("\n");
}

export function splitFailureNotification(text: string): readonly string[] {
  const messages: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + TELEGRAM_MESSAGE_CHARACTERS, text.length);
    if (end < text.length) {
      const lineBreak = text.lastIndexOf("\n", end - 1);
      if (lineBreak >= start) end = lineBreak + 1;
      else {
        const lastCharacter = text.charCodeAt(end - 1);
        if (lastCharacter >= HIGH_SURROGATE_START && lastCharacter <= HIGH_SURROGATE_END) end -= 1;
      }
    }
    messages.push(text.slice(start, end));
    start = end;
  }
  return messages;
}
