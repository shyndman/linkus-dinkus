import { createLogger, format, transports, type Logger } from "winston";

type LogValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogValue>>;
type LogMethod = {
  (message: string): void;
  (message: string, fields: LogFields): void;
};
export type ApplicationLogger = Readonly<{
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
}>;
type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};
const LOG_LEVEL_LABEL: Readonly<Record<LogLevel, string>> = {
  debug: "dbug",
  info: "info",
  warn: "warn",
  error: "err!",
  fatal: "fatl",
};
const LOG_LEVEL_COLOR: Readonly<Record<LogLevel, string>> = {
  debug: "\u001b[38;2;128;128;128m",
  info: "\u001b[38;2;86;156;214m",
  warn: "\u001b[38;2;220;180;80m",
  error: "\u001b[38;2;240;100;100m",
  fatal: "\u001b[38;2;255;70;120m",
};
const STDERR_LEVELS: readonly string[] = Object.keys(LOG_LEVEL_PRIORITY);
const MESSAGE_FIELDS: Readonly<Record<string, true>> = { level: true, message: true };
const ELAPSED_TIME_COLOR = "\u001b[38;2;140;140;140m";
const ELAPSED_TIME_DELIMITER_COLOR = "\u001b[38;2;80;80;80m";
const FIELD_NAME_COLOR = "\u001b[38;2;105;105;105m";
const STRING_VALUE_COLOR = "\u001b[38;2;137;196;214m";
const NUMBER_VALUE_COLOR = "\u001b[38;2;215;186;125m";
const BOOLEAN_VALUE_COLOR = "\u001b[38;2;197;134;192m";
const NULL_VALUE_COLOR = "\u001b[38;2;128;128;128m";
const RESET_COLOR = "\u001b[0m";
const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_MINUTE = MILLISECONDS_PER_SECOND * SECONDS_PER_MINUTE;

function elapsedTime(): string {
  const elapsedMilliseconds = Math.floor(performance.now());
  const minutes = String(Math.floor(elapsedMilliseconds / MILLISECONDS_PER_MINUTE)).padStart(2, "0");
  const seconds = String(
    Math.floor(elapsedMilliseconds / MILLISECONDS_PER_SECOND) % SECONDS_PER_MINUTE,
  ).padStart(2, "0");
  const milliseconds = String(elapsedMilliseconds % MILLISECONDS_PER_SECOND).padStart(3, "0");
  const plainTime = `${minutes}:${seconds}.${milliseconds}`;
  if (!process.stderr.isTTY || process.env.NO_COLOR !== undefined) return plainTime;
  return [
    ELAPSED_TIME_COLOR,
    minutes,
    ELAPSED_TIME_DELIMITER_COLOR,
    ":",
    ELAPSED_TIME_COLOR,
    seconds,
    ELAPSED_TIME_DELIMITER_COLOR,
    ".",
    ELAPSED_TIME_COLOR,
    milliseconds,
    RESET_COLOR,
  ].join("");
}

function formatLevel(level: LogLevel): string {
  const label = `[${LOG_LEVEL_LABEL[level]}]`;
  if (!process.stderr.isTTY || process.env.NO_COLOR !== undefined) return label;
  return `${LOG_LEVEL_COLOR[level]}${label}${RESET_COLOR}`;
}

function valueColor(value: unknown): string {
  if (typeof value === "string") return STRING_VALUE_COLOR;
  if (typeof value === "number") return NUMBER_VALUE_COLOR;
  if (typeof value === "boolean") return BOOLEAN_VALUE_COLOR;
  return NULL_VALUE_COLOR;
}

function formatField(name: string, value: unknown): string {
  if (!process.stderr.isTTY || process.env.NO_COLOR !== undefined) return `${name}: ${String(value)}`;
  return `${FIELD_NAME_COLOR}${name}${RESET_COLOR}: ${valueColor(value)}${String(value)}${RESET_COLOR}`;
}

function formatMessage(level: LogLevel, message: unknown, fields: Readonly<Record<string, unknown>>): string {
  const details = Object.entries(fields)
    .filter(([name]): boolean => MESSAGE_FIELDS[name] !== true)
    .map(([name, value]): string => formatField(name, value));
  return [elapsedTime(), formatLevel(level), String(message).replace(/\.+$/, ""), ...details].join(" ");
}

const winstonLogger: Logger = createLogger({
  levels: LOG_LEVEL_PRIORITY,
  level: "debug",
  format: format.printf((fields): string => formatMessage(fields.level as LogLevel, fields.message, fields)),
  transports: [
    new transports.Console({
      consoleWarnLevels: [],
      stderrLevels: [...STDERR_LEVELS],
    }),
  ],
  exitOnError: false,
});

function writeLog(level: LogLevel, message: string, fields: LogFields = {}): void {
  winstonLogger.log({ level, message, ...fields });
}

export const logger: ApplicationLogger = {
  debug: (message: string, fields?: LogFields): void => writeLog("debug", message, fields),
  info: (message: string, fields?: LogFields): void => writeLog("info", message, fields),
  warn: (message: string, fields?: LogFields): void => writeLog("warn", message, fields),
  error: (message: string, fields?: LogFields): void => writeLog("error", message, fields),
  fatal: (message: string, fields?: LogFields): void => writeLog("fatal", message, fields),
};

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
