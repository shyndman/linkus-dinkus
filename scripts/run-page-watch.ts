import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { PROJECT_ROOT, fail, runTool } from "./lib.ts";
import { watchUrls } from "./watch-urls.ts";

const SPREADSHEET_ID = "1885pAekZfP__9yGRXhCJU5_N8jAzoXUi6IyHaPf149E";
const MCP_CONFIG_PATH = resolve(PROJECT_ROOT, ".omp", "mcp.json");
const POLL_FREQUENCY_INPUT_PATH = resolve(PROJECT_ROOT, "cache", "poll-frequency-input.txt");
const CRON_MODEL = "openrouter/z-ai/glm-5.3-flash";
const CRON_MODEL_MAX_TIME_SECONDS = "60";
const DATE_FORMAT = "+%b %-d, %-I:%M %p";

export type PageWatchConfiguration = Readonly<{
  notificationTrigger: string;
  pollFrequency: string;
  urls: readonly string[];
}>;


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
const CronResponseSchema = z.object({
  cronExpressions: z.array(z.string().min(1)).min(1),
});


type McpServerConfiguration = z.infer<typeof McpConfigurationSchema>["mcpServers"]["google-sheets"];

type ToolClient = Readonly<{
  callTool(request: Readonly<{ name: string; arguments: Readonly<Record<string, string>> }>): Promise<unknown>;
}>;

type PollFrequencyDependencies = Readonly<{
  readCachedText: () => string | null;
  getCronExpressions: (pollFrequency: string) => readonly string[];
  installCronExpressions: (expressions: readonly string[]) => void;
  writeCachedText: (pollFrequency: string) => void;
}>;

function readMcpServerConfiguration(): McpServerConfiguration {
  const parsed: unknown = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf8"));
  const result = McpConfigurationSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${MCP_CONFIG_PATH} does not contain a valid google-sheets server`);
  }
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
  const result: unknown = await client.callTool({ name, arguments: arguments_ });
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

function readUrlCells(text: string): readonly string[] {
  const cells = parseCells(text, "urls");
  const values = cells.flat();
  if (!values.every((value: unknown): value is string => typeof value === "string")) {
    throw new Error("urls must contain only text cells");
  }
  return values;
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
  const sheetArguments = (rangeName: string): Readonly<Record<string, string>> => ({
    spreadsheet_id: SPREADSHEET_ID,
    range_notation: rangeName,
  });
  const [notificationTriggerText, pollFrequencyText, urlsText] = await Promise.all([
    callSheetTool(client, "read_cells", sheetArguments("notificationTrigger")),
    callSheetTool(client, "read_cells", sheetArguments("pollFrequency")),
    callSheetTool(client, "read_cells", sheetArguments("urls")),
  ]);

  const dateTime = getHostDateTime();
  await callSheetTool(client, "write_cells", {
    spreadsheet_id: SPREADSHEET_ID,
    range_notation: "lastCheckDateTime",
    values: JSON.stringify([[dateTime]]),
  });

  return {
    notificationTrigger: readSingleTextCell(notificationTriggerText, "notificationTrigger"),
    pollFrequency: readSingleTextCell(pollFrequencyText, "pollFrequency"),
    urls: readUrlCells(urlsText),
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
  const result: SpawnSyncReturns<string> = spawnSync("omp", arguments_, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  if (result.error) throw new Error(`omp failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    throw new Error(`omp failed: ${detail}`);
  }
  return result.stdout;
}

export function parseCronResponse(output: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error: unknown) {
    throw new Error(`The cron LLM returned invalid JSON: ${output}`, { cause: error });
  }
  const response = CronResponseSchema.safeParse(parsed);
  if (!response.success) {
    throw new Error(`The cron LLM returned an invalid response: ${output}`);
  }
  return response.data.cronExpressions;
}

function getCronExpressions(pollFrequency: string): readonly string[] {
  const prompt = [
    "Convert this schedule to one or more five-field cron expressions.",
    "Return only a JSON object with one key named cronExpressions.",
    "cronExpressions must be a JSON array with one cron expression per string.",
    "Do not use Markdown or add an explanation.",
    "Schedule:",
    pollFrequency,
  ].join("\n");
  const output = runOmp([
    "--model", CRON_MODEL,
    "--thinking=off",
    `--max-time=${CRON_MODEL_MAX_TIME_SECONDS}`,
    "--print",
    "--mode=text",
    "--no-tools",
    "--no-session",
    prompt,
  ]).trim();
  return parseCronResponse(output);
}

function installCronExpressions(expressions: readonly string[]): void {
  try {
    runTool("bin/sync-cron-schedule", expressions);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not install cron expressions ${JSON.stringify(expressions)}: ${detail}`, { cause: error });
  }
}

function writeCachedPollFrequency(pollFrequency: string): void {
  mkdirSync(dirname(POLL_FREQUENCY_INPUT_PATH), { recursive: true });
  writeFileSync(POLL_FREQUENCY_INPUT_PATH, pollFrequency, "utf8");
}

export function syncPollFrequency(pollFrequency: string, dependencies: PollFrequencyDependencies = {
  readCachedText: readCachedPollFrequency,
  getCronExpressions,
  installCronExpressions,
  writeCachedText: writeCachedPollFrequency,
}): boolean {
  if (dependencies.readCachedText() === pollFrequency) return false;
  const expressions = dependencies.getCronExpressions(pollFrequency);
  dependencies.installCronExpressions(expressions);
  dependencies.writeCachedText(pollFrequency);
  return true;
}


async function main(): Promise<void> {
  const mcpServer = readMcpServerConfiguration();
  const client = new Client({ name: "shoestring-page-watch", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: mcpServer.command, args: [...mcpServer.args] });
  try {
    await client.connect(transport);
    const configuration = await readConfigurationAndWriteTimestamp(client);
    syncPollFrequency(configuration.pollFrequency);
    await client.close();
    watchUrls({
      notificationTrigger: configuration.notificationTrigger,
      urls: configuration.urls,
    });
  } catch (error: unknown) {
    await client.close().catch((closeError: unknown): void => {
      console.error(`Could not close the Google Sheets connection: ${String(closeError)}`);
    });
    throw error;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch(fail);
}
