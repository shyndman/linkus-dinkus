import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { logger } from "../logger.ts";
import { fail } from "../runtime.ts";

const TIMER_UNIT_NAME = "shoestring-page-watch.timer";
const SERVICE_UNIT_NAME = "shoestring-page-watch.service";
const TIMER_UNIT_PATH = resolve(homedir(), ".config", "systemd", "user", TIMER_UNIT_NAME);

type SyncResult = Readonly<{
  calendarExpressions: readonly string[];
  timerUnitPath: string;
}>;

function runSystemctl(arguments_: readonly string[]): void {
  const startedAt = performance.now();
  logger.info(`Running systemctl ${arguments_.join(" ")}.`);
  const result: SpawnSyncReturns<string> = spawnSync("systemctl", ["--user", ...arguments_], {
    encoding: "utf8",
  });
  if (result.error) throw new Error(`systemctl failed to start: ${result.error.message}`);
  if (result.status === 0) {
    logger.info(`systemctl ${arguments_.join(" ")} finished after ${Math.round(performance.now() - startedAt)} milliseconds.`);
    return;
  }
  const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
  logger.error(`systemctl ${arguments_.join(" ")} failed with status ${String(result.status)}. ${detail}`);
  throw new Error(`systemctl ${arguments_.join(" ")} failed: ${detail}`);
}
function validateCalendarExpression(expression: string): void {
  const result: SpawnSyncReturns<string> = spawnSync("systemd-analyze", ["calendar", expression], {
    encoding: "utf8",
  });
  if (result.error) throw new Error(`systemd-analyze failed to start: ${result.error.message}`);
  if (result.status === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
  logger.error(`A calendar expression failed systemd validation. ${detail}`);
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

function main(): void {
  const calendarExpressions: readonly string[] = process.argv.slice(2);
  if (calendarExpressions.length === 0) throw new Error("At least one systemd calendar expression is required");
  logger.info(`Received ${calendarExpressions.length} calendar expressions for the timer.`);
  for (const [index, expression] of calendarExpressions.entries()) {
    logger.info(`Validating calendar expression ${index + 1} of ${calendarExpressions.length}.`);
    validateCalendarExpression(expression);
    logger.info(`Calendar expression ${index + 1} is valid.`);
  }


  mkdirSync(dirname(TIMER_UNIT_PATH), { recursive: true });
  writeFileSync(TIMER_UNIT_PATH, buildTimerUnit(calendarExpressions), "utf8");
  logger.info(`Wrote the timer unit to ${TIMER_UNIT_PATH}.`);
  runSystemctl(["daemon-reload"]);
  runSystemctl(["enable", TIMER_UNIT_NAME]);
  runSystemctl(["restart", TIMER_UNIT_NAME]);
  logger.info("The page-watch timer is enabled and running with its new schedule.");

  const result: SyncResult = { calendarExpressions, timerUnitPath: TIMER_UNIT_PATH };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  main();
} catch (error: unknown) {
  fail(error);
}
