import { config, createLogger, format, transports, type Logger } from "winston";

const STDERR_LEVELS: readonly string[] = Object.keys(config.npm.levels);

export const logger: Logger = createLogger({
  level: "info",
  format: format.printf(({ message }): string => String(message)),
  transports: [
    new transports.Console({
      consoleWarnLevels: [],
      stderrLevels: [...STDERR_LEVELS],
    }),
  ],
  exitOnError: false,
});

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
