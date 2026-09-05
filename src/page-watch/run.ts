import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { APPLICATION_CONFIG } from "../config.ts";
import { errorDetail, logger } from "../logger.ts";
import { PROJECT_ROOT } from "../runtime.ts";
import { syncSystemdSchedule } from "../systemd/sync-schedule.ts";
import { createDefaultPageWatchDependencies } from "./default-dependencies.ts";
import {
  NotificationTriggerSchema,
  WatchedUrlSchema,
  type WatchedUrl,
} from "./domain.ts";
import type { ConfigurationSource, PageWatchConfiguration } from "./ports.ts";
import { watchUrls } from "./watch-urls.ts";

const MCP_CONFIG_PATH = resolve(PROJECT_ROOT, ".omp", "mcp.json");
const POLL_FREQUENCY_INPUT_PATH = resolve(PROJECT_ROOT, "snapshots", "poll-frequency-input.txt");
const SYSTEMD_TIME_REFERENCE_PATH = resolve(PROJECT_ROOT, "resources", "systemd.time.md");
const DATE_FORMAT = "+%b %-d, %-I:%M %p";



const McpConfigurationSchema = z.object({
  mcpServers: z.object({
    "google-sheets": z.object({
      command: z.string(),
      args: z.array(z.string()),
    }),
  }),
});
const ToolTextResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.looseObject({
    type: z.string(),
    text: z.string().optional(),
  })),
});
const CellMatrixSchema = z.array(z.array(z.unknown()));
const SystemdCalendarResponseSchema = z.object({
  calendarExpressions: z.array(z.string().min(1)).min(1),
});
type CalendarValidationResult =
  | Readonly<{ state: "valid" }>
  | Readonly<{ state: "invalid"; detail: string }>;



type McpServerConfiguration = z.infer<typeof McpConfigurationSchema>["mcpServers"]["google-sheets"];

type ToolClient = Readonly<{
  callTool(request: Readonly<{ name: string; arguments: Readonly<Record<string, string>> }>): Promise<unknown>;
}>;

type PollFrequencyDependencies = Readonly<{
  readCachedText: () => string | null;
  getCalendarExpressions: (pollFrequency: string, validationError: string | null) => readonly string[];
  validateCalendarExpressions: (expressions: readonly string[]) => CalendarValidationResult;
  installCalendarExpressions: (expressions: readonly string[]) => void;
  writeCachedText: (pollFrequency: string) => void;
}>;

function readMcpServerConfiguration(): McpServerConfiguration {
  logger.info("reading the Google Sheets server configuration from .omp/mcp.json.");
  const parsed: unknown = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf8"));
  const result = McpConfigurationSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${MCP_CONFIG_PATH} does not contain a valid google-sheets server`);
  }
  logger.info("Google Sheets server configuration is valid.");
  return result.data.mcpServers["google-sheets"];
}

function getToolText(result: unknown, toolName: string): string {
  const parsed = ToolTextResultSchema.safeParse(result);
  if (!parsed.success) throw new Error(`${toolName} returned an invalid result`);
  if (parsed.data.isError === true) {
    throw new Error(`${toolName} failed: ${JSON.stringify(parsed.data.content)}`);
  }
  if (parsed.data.content.length !== 1) {
    throw new Error(`${toolName} returned ${parsed.data.content.length} content items`);
  }
  const item = parsed.data.content[0];
  if (item?.type !== "text" || item.text === undefined) {
    throw new Error(`${toolName} did not return text`);
  }
  return item.text;
}

async function callSheetTool(client: ToolClient, name: string, arguments_: Readonly<Record<string, string>>): Promise<string> {
  logger.info("calling a Google Sheets tool.", { tool: name });
  const result: unknown = await client.callTool({ name, arguments: arguments_ });
  logger.info("Google Sheets tool returned.", { tool: name });
  return getToolText(result, name);
}

function parseCells(text: string, rangeName: string): readonly (readonly unknown[])[] {
  const parsed: unknown = JSON.parse(text);
  const result = CellMatrixSchema.safeParse(parsed);
  if (!result.success) throw new Error(`${rangeName} did not return a cell matrix`);
  return result.data;
}

function readSingleTextCell(text: string, rangeName: string): string {
  const cells = parseCells(text, rangeName);
  if (cells.length !== 1 || cells[0]?.length !== 1 || typeof cells[0][0] !== "string") {
    throw new Error(`${rangeName} must contain one text cell`);
  }
  return cells[0][0];
}

function readUrlCells(text: string): readonly WatchedUrl[] {
  const cells = parseCells(text, APPLICATION_CONFIG.googleSheets.urlsRange);
  return cells.flat().map((value: unknown): WatchedUrl => WatchedUrlSchema.parse(value));
}

function getHostDateTime(): string {
  const result: SpawnSyncReturns<string> = spawnSync("date", [DATE_FORMAT], { encoding: "utf8" });
  if (result.error) throw new Error(`date failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit status ${result.status}`;
    throw new Error(`date failed: ${detail}`);
  }
  return result.stdout.trimEnd();
}

export async function readConfigurationAndWriteTimestamp(client: ToolClient): Promise<PageWatchConfiguration> {
  logger.info("reading the notification rule, poll schedule, and watched-page list from Google Sheets.");
  const sheetArguments = (rangeName: string): Readonly<Record<string, string>> => ({
    spreadsheet_id: APPLICATION_CONFIG.googleSheets.spreadsheetId,
    range_notation: rangeName,
  });
  const [notificationTriggerText, pollFrequencyText, urlsText] = await Promise.all([
    callSheetTool(
      client,
      "read_cells",
      sheetArguments(APPLICATION_CONFIG.googleSheets.notificationTriggerRange),
    ),
    callSheetTool(
      client,
      "read_cells",
      sheetArguments(APPLICATION_CONFIG.googleSheets.pollFrequencyRange),
    ),
    callSheetTool(client, "read_cells", sheetArguments(APPLICATION_CONFIG.googleSheets.urlsRange)),
  ]);
  logger.info("Google Sheets returned all three configuration ranges.");

  const dateTime = getHostDateTime();
  await callSheetTool(client, "write_cells", {
    spreadsheet_id: APPLICATION_CONFIG.googleSheets.spreadsheetId,
    range_notation: APPLICATION_CONFIG.googleSheets.lastCheckDateTimeRange,
    values: JSON.stringify([[dateTime]]),
  });
  logger.info("updated the last-check cell.", { dateTime });

  const urls = readUrlCells(urlsText);
  logger.info("loaded the watched pages from Google Sheets.", { pageCount: urls.length });
  return {
    notificationTrigger: NotificationTriggerSchema.parse(
      readSingleTextCell(
        notificationTriggerText,
        APPLICATION_CONFIG.googleSheets.notificationTriggerRange,
      ),
    ),
    pollFrequency: readSingleTextCell(
      pollFrequencyText,
      APPLICATION_CONFIG.googleSheets.pollFrequencyRange,
    ),
    urls,
  };
}

function readCachedPollFrequency(): string | null {
  try {
    return readFileSync(POLL_FREQUENCY_INPUT_PATH, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function runOmp(arguments_: readonly string[]): string {
  logger.info("started the schedule model.");
  const result: SpawnSyncReturns<string> = spawnSync("omp", arguments_, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  if (result.error) {
    logger.error("schedule model could not start.", { error: result.error.message });
    throw new Error(`omp failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    logger.error("schedule model failed.", { status: result.status, error: detail });
    throw new Error(`omp failed: ${detail}`);
  }
  return result.stdout;
}
function readSystemdTimeDocumentation(): string {
  logger.info("reading the bundled systemd calendar reference for the schedule model.");
  const documentation = readFileSync(SYSTEMD_TIME_REFERENCE_PATH, "utf8").trim();
  if (documentation.length === 0) {
    throw new Error(`The systemd calendar reference is empty: ${SYSTEMD_TIME_REFERENCE_PATH}`);
  }
  logger.info("read the systemd calendar reference.", {
    bytes: Buffer.byteLength(documentation),
  });
  return documentation;
}


export function parseSystemdCalendarResponse(output: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error: unknown) {
    throw new Error(`The schedule model returned invalid JSON: ${output}`, { cause: error });
  }
  const response = SystemdCalendarResponseSchema.safeParse(parsed);
  if (!response.success) {
    throw new Error(`The schedule model returned an invalid response: ${output}`);
  }
  return response.data.calendarExpressions;
}

export function buildSystemdCalendarPrompt(
  pollFrequency: string,
  validationError: string | null,
  documentation: string,
): string {
  const promptParts = [
    "Convert this schedule to one or more systemd OnCalendar expressions.",
    "Return only a JSON object with one key named calendarExpressions.",
    "calendarExpressions must be a JSON array with one expression per string.",
    "Use systemd calendar syntax, not cron syntax.",
    "Interpret approximate schedule terms yourself.",
    "Do not use Markdown or add an explanation.",
    "The complete systemd.time documentation follows.",
    documentation,
    "End of systemd.time documentation.",
  ];
  if (validationError !== null) {
    promptParts.push(
      "Your previous expression failed systemd-analyze validation.",
      `Validation error: ${validationError}`,
      "Correct the expression without asking for a more exact schedule.",
    );
  }
  promptParts.push("Schedule:", pollFrequency);
  return promptParts.join("\n");
}

function getCalendarExpressions(pollFrequency: string, validationError: string | null): readonly string[] {
  logger.info(
    validationError === null
      ? "requesting an initial systemd calendar schedule."
      : "requesting a corrected systemd calendar schedule after validation failed.",
  );
  const prompt = buildSystemdCalendarPrompt(
    pollFrequency,
    validationError,
    readSystemdTimeDocumentation(),
  );
  const output = runOmp([
    "--model", APPLICATION_CONFIG.agents.model,
    "--thinking=off",
    `--max-time=${APPLICATION_CONFIG.agents.scheduleMaxTimeSeconds}`,
    "--print",
    "--mode=text",
    "--no-tools",
    "--no-session",
    prompt,
  ]).trim();
  const expressions = parseSystemdCalendarResponse(output);
  logger.info("schedule model returned calendar expressions.", { expressionCount: expressions.length });
  return expressions;
}

function validateCalendarExpressions(expressions: readonly string[]): CalendarValidationResult {
  logger.info("validating calendar expressions with systemd.", { expressionCount: expressions.length });
  for (const [index, expression] of expressions.entries()) {
    logger.info("validating a calendar expression.", {
      expressionNumber: index + 1,
      expressionCount: expressions.length,
    });
    const result: SpawnSyncReturns<string> = spawnSync("systemd-analyze", ["calendar", expression], {
      encoding: "utf8",
    });
    if (result.error) throw new Error(`systemd-analyze failed to start: ${result.error.message}`);
    if (result.status === 0) continue;
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    logger.warn("a calendar expression failed validation.", {
      expressionNumber: index + 1,
      error: detail,
    });
    return { state: "invalid", detail: `${JSON.stringify(expression)}: ${detail}` };
  }
  logger.info("every calendar expression passed systemd validation.");
  return { state: "valid" };
}

function installCalendarExpressions(expressions: readonly string[]): void {
  logger.info("installing calendar expressions.", { expressionCount: expressions.length });
  try {
    syncSystemdSchedule(expressions);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not install systemd calendar expressions ${JSON.stringify(expressions)}: ${detail}`, { cause: error });
  }
  logger.info("installed the new systemd calendar schedule.");
}

function writeCachedPollFrequency(pollFrequency: string): void {
  mkdirSync(dirname(POLL_FREQUENCY_INPUT_PATH), { recursive: true });
  writeFileSync(POLL_FREQUENCY_INPUT_PATH, pollFrequency, "utf8");
}

export function syncPollFrequency(pollFrequency: string, dependencies: PollFrequencyDependencies = {
  readCachedText: readCachedPollFrequency,
  getCalendarExpressions,
  validateCalendarExpressions,
  installCalendarExpressions,
  writeCachedText: writeCachedPollFrequency,
}): boolean {
  logger.info("checking whether the poll schedule changed.");
  if (dependencies.readCachedText() === pollFrequency) {
    logger.info("poll schedule did not change. The installed timer remains unchanged.");
    return false;
  }
  logger.info("poll schedule changed. A new timer schedule is required.");

  let expressions = dependencies.getCalendarExpressions(pollFrequency, null);
  const initialValidation = dependencies.validateCalendarExpressions(expressions);
  logger.info("initial schedule validation finished.", { result: initialValidation.state });
  if (initialValidation.state === "invalid") {
    expressions = dependencies.getCalendarExpressions(pollFrequency, initialValidation.detail);
    const correctedValidation = dependencies.validateCalendarExpressions(expressions);
    logger.info("corrected schedule validation finished.", { result: correctedValidation.state });
    if (correctedValidation.state === "invalid") {
      throw new Error(`The corrected systemd calendar expression is invalid: ${correctedValidation.detail}`);
    }
  }

  dependencies.installCalendarExpressions(expressions);
  dependencies.writeCachedText(pollFrequency);
  logger.info("saved the poll schedule after the timer update succeeded.");
  return true;
}
function createGoogleSheetsConfigurationSource(client: ToolClient): ConfigurationSource {
  return {
    readAndRecordCheck: async (): Promise<PageWatchConfiguration> => (
      readConfigurationAndWriteTimestamp(client)
    ),
  };
}



export async function runPageWatch(): Promise<void> {
  logger.info("starting the page-watch application.");
  const mcpServer = readMcpServerConfiguration();
  const client = new Client({ name: "linkus-dinkus", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: mcpServer.command, args: [...mcpServer.args] });
  logger.info("connecting to Google Sheets.");
  try {
    await client.connect(transport);
    logger.info("connected to Google Sheets.");
    const configurationSource = createGoogleSheetsConfigurationSource(client);
    const configuration = await configurationSource.readAndRecordCheck();
    syncPollFrequency(configuration.pollFrequency);
    logger.info("closing the Google Sheets connection before page checks start.");
    await client.close();
    logger.info("closed the Google Sheets connection.");
    await watchUrls(
      {
        notificationTrigger: configuration.notificationTrigger,
        urls: configuration.urls,
      },
      createDefaultPageWatchDependencies(),
    );
    logger.info("finished all page checks.", { pageCount: configuration.urls.length });
  } catch (error: unknown) {
    await client.close().catch((closeError: unknown): void => {
      logger.error("could not close the Google Sheets connection after a failure.", {
        error: errorDetail(closeError),
      });
    });
    throw error;
  }
}
