import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger, format, transports, type Logger } from "winston";
import { env } from "node:process";

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
const LOG_LEVEL_BRACKET_COLOR: Readonly<Record<LogLevel, string>> = {
  debug: "\u001b[38;2;77;77;77m",
  info: "\u001b[38;2;52;94;128m",
  warn: "\u001b[38;2;132;108;48m",
  error: "\u001b[38;2;144;60;60m",
  fatal: "\u001b[38;2;153;42;72m",
};
const STDERR_LEVELS: readonly string[] = Object.keys(LOG_LEVEL_PRIORITY);
const MESSAGE_FIELDS: Readonly<Record<string, true>> = { level: true, message: true, site: true };
const ELAPSED_TIME_COLOR = "\u001b[38;2;105;105;105m";
const ELAPSED_TIME_DELIMITER_COLOR = "\u001b[38;2;80;80;80m";
const SITE_DELIMITER_COLOR = "\u001b[38;2;50;110;70m";
const SITE_ID_COLOR = "\u001b[38;2;110;200;130m";
const FIELD_NAME_COLOR = "\u001b[38;2;140;140;140m";
const STRING_VALUE_COLOR = "\u001b[38;2;137;196;214m";
const NUMBER_VALUE_COLOR = "\u001b[38;2;215;186;125m";
const BOOLEAN_VALUE_COLOR = "\u001b[38;2;197;134;192m";
const NULL_VALUE_COLOR = "\u001b[38;2;128;128;128m";
const RESET_COLOR = "\u001b[0m";
const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_MINUTE = MILLISECONDS_PER_SECOND * SECONDS_PER_MINUTE;
const URL_TOKEN_PATTERN = /\bhttps?:\/\/[^\s]+/gu;
const URL_TRAILING_PUNCTUATION_PATTERN = /[),.;:\]}]+$/u;
const QUERY_ELLIPSIS = "…";
export const SITE_LOG_TAG_ENVIRONMENT_VARIABLE = "PAGE_WATCH_SITE_TAG";
const siteLogTagStorage = new AsyncLocalStorage<string>();

function elapsedTime(): string {
  const elapsedMilliseconds = Math.floor(performance.now());
  const minutes = String(Math.floor(elapsedMilliseconds / MILLISECONDS_PER_MINUTE)).padStart(2, "0");
  const seconds = String(
    Math.floor(elapsedMilliseconds / MILLISECONDS_PER_SECOND) % SECONDS_PER_MINUTE,
  ).padStart(2, "0");
  const milliseconds = String(elapsedMilliseconds % MILLISECONDS_PER_SECOND).padStart(3, "0");
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
  return [
    LOG_LEVEL_BRACKET_COLOR[level],
    "[",
    LOG_LEVEL_COLOR[level],
    LOG_LEVEL_LABEL[level],
    LOG_LEVEL_BRACKET_COLOR[level],
    "]",
    RESET_COLOR,
  ].join("");
}

function valueColor(value: unknown): string {
  if (typeof value === "string") return STRING_VALUE_COLOR;
  if (typeof value === "number") return NUMBER_VALUE_COLOR;
  if (typeof value === "boolean") return BOOLEAN_VALUE_COLOR;
  return NULL_VALUE_COLOR;
}

function elideUrlQueries(text: string): string {
  return text.replace(URL_TOKEN_PATTERN, (token: string): string => {
    const suffix = token.match(URL_TRAILING_PUNCTUATION_PATTERN)?.[0] ?? "";
    const url = token.slice(0, token.length - suffix.length);
    const queryStart = url.indexOf("?");
    if (queryStart === -1) return token;
    return `${url.slice(0, queryStart)}?${QUERY_ELLIPSIS}${suffix}`;
  });
}

function formatField(name: string, value: unknown): string {
  const text = typeof value === "string" ? elideUrlQueries(value) : String(value);
  return `${FIELD_NAME_COLOR}${name}${RESET_COLOR}: ${valueColor(value)}${text}${RESET_COLOR}`;
}
function formatSite(site: unknown): string {
  return `${SITE_DELIMITER_COLOR}(${SITE_ID_COLOR}${String(site)}${SITE_DELIMITER_COLOR})${RESET_COLOR}`;
}

function formatMessage(level: LogLevel, message: unknown, fields: Readonly<Record<string, unknown>>): string {
  const details = Object.entries(fields)
    .filter(([name]): boolean => MESSAGE_FIELDS[name] !== true)
    .map(([name, value]): string => formatField(name, value));
  const site = fields.site;
  const prefix =
    site === undefined ? [elapsedTime(), formatLevel(level)] : [elapsedTime(), formatLevel(level), formatSite(site)];
  const text = typeof message === "string" ? elideUrlQueries(message) : String(message);
  return [...prefix, text.replace(/\.+$/, ""), ...details].join(" ");
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
  const site = siteLogTagStorage.getStore() ?? env[SITE_LOG_TAG_ENVIRONMENT_VARIABLE];
  winstonLogger.log(site === undefined ? { level, message, ...fields } : { level, message, site, ...fields });
}

export const logger: ApplicationLogger = {
  debug: (message: string, fields?: LogFields): void => writeLog("debug", message, fields),
  info: (message: string, fields?: LogFields): void => writeLog("info", message, fields),
  warn: (message: string, fields?: LogFields): void => writeLog("warn", message, fields),
  error: (message: string, fields?: LogFields): void => writeLog("error", message, fields),
  fatal: (message: string, fields?: LogFields): void => writeLog("fatal", message, fields),
};

export function withSiteLogTag<T>(site: string, callback: () => Promise<T>): Promise<T> {
  return siteLogTagStorage.run(site, callback);
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
