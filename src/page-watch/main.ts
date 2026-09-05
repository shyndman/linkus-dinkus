import { errorDetail, logger } from "../logger.ts";
import { runPageWatch } from "./run.ts";

try {
  await runPageWatch();
} catch (error: unknown) {
  logger.fatal("application stopped.", { error: errorDetail(error) });
  process.exitCode = 1;
}
