import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../logger.ts";
import { fail } from "../runtime.ts";

const TIMER_UNIT_NAME = "shoestring-page-watch.timer";
const SERVICE_UNIT_NAME = "shoestring-page-watch.service";
const TIMER_UNIT_PATH = resolve(homedir(), ".config", "systemd", "user", TIMER_UNIT_NAME);

export type SyncResult = Readonly<{
  calendarExpressions: readonly string[];
  timerUnitPath: string;
}>;

function runSystemctl(arguments_: readonly string[]): void {
  const result: SpawnSyncReturns<string> = spawnSync("systemctl", ["--user", ...arguments_], {
    encoding: "utf8",
  });
  if (result.error) throw new Error(`systemctl failed to start: ${result.error.message}`);
  if (result.status === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
  logger.error("a systemctl command failed.", {
    command: arguments_.join(" "),
    status: result.status,
    error: detail,
  });
  throw new Error(`systemctl ${arguments_.join(" ")} failed: ${detail}`);
}
function validateCalendarExpression(expression: string): void {
  const result: SpawnSyncReturns<string> = spawnSync("systemd-analyze", ["calendar", expression], {
    encoding: "utf8",
  });
  if (result.error) throw new Error(`systemd-analyze failed to start: ${result.error.message}`);
  if (result.status === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
  logger.error("a calendar expression failed systemd validation.", { error: detail });
  throw new Error(`Invalid systemd calendar expression ${JSON.stringify(expression)}: ${detail}`);
}


function buildTimerUnit(calendarExpressions: readonly string[]): string {
  const schedules = calendarExpressions.map((expression: string): string => `OnCalendar=${expression}`);
  return [
    "[Unit]",
    "Description=Check watched pages on schedule",
    "",
    "[Timer]",
    ...schedules,
    "Persistent=true",
    `Unit=${SERVICE_UNIT_NAME}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

export function syncSystemdSchedule(calendarExpressions: readonly string[]): SyncResult {
  if (calendarExpressions.length === 0) throw new Error("At least one systemd calendar expression is required");
  logger.info("received calendar expressions for the timer.", {
    expressionCount: calendarExpressions.length,
  });
  for (const [index, expression] of calendarExpressions.entries()) {
    logger.info("validating a calendar expression.", {
      expressionNumber: index + 1,
      expressionCount: calendarExpressions.length,
    });
    validateCalendarExpression(expression);
    logger.info("calendar expression is valid.", { expressionNumber: index + 1 });
  }

  mkdirSync(dirname(TIMER_UNIT_PATH), { recursive: true });
  writeFileSync(TIMER_UNIT_PATH, buildTimerUnit(calendarExpressions), "utf8");
  logger.info("wrote the timer unit.", { path: TIMER_UNIT_PATH });
  logger.info("reloading the systemd user manager.");
  runSystemctl(["daemon-reload"]);
  logger.info("enabling the page-watch timer.");
  runSystemctl(["enable", TIMER_UNIT_NAME]);
  logger.info("restarting the page-watch timer.");
  runSystemctl(["restart", TIMER_UNIT_NAME]);
  logger.info("page-watch timer is enabled and running with its new schedule.");
  return { calendarExpressions, timerUnitPath: TIMER_UNIT_PATH };
}

function main(): void {
  const calendarExpressions: readonly string[] = process.argv.slice(2);
  process.stdout.write(`${JSON.stringify(syncSystemdSchedule(calendarExpressions))}\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    main();
  } catch (error: unknown) {
    fail(error);
  }
}
