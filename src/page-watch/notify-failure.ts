import { logger } from "../logger.ts";
import { fail } from "../runtime.ts";
import { createTelegramNotifier } from "../integrations/telegram.ts";

const FAILURE_MESSAGE = "Page watch failed. Check the shoestring-page-watch.service journal for details.";

try {
  logger.warn("The page-watch service failed. Sending its service-failure notification.");
  await createTelegramNotifier()(FAILURE_MESSAGE);
  logger.info("The service-failure notification was sent.");
} catch (error: unknown) {
  fail(error);
}
