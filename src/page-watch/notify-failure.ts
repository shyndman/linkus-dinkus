import { logger } from "../logger.ts";
import { fail } from "../runtime.ts";
import { createAdminTelegramNotifier } from "../integrations/telegram.ts";

const FAILURE_MESSAGE = "Page watch failed. Check the shoestring-page-watch.service journal for details.";

try {
  logger.warn("page-watch service failed. Sending its service-failure notification.");
  await createAdminTelegramNotifier()(FAILURE_MESSAGE);
  logger.info("service-failure notification was sent.");
} catch (error: unknown) {
  fail(error);
}
