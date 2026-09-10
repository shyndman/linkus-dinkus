import { logger } from "../logger.ts";
import { fail } from "../runtime.ts";
import { createAdminTelegramNotifier } from "../integrations/telegram.ts";

import { buildFailureNotificationText, retrieveJournalFailureContext, splitFailureNotification } from "../systemd/journal.ts";

try {
  logger.warn("Linkus Dinkus failed. Sending its service-failure notification.");
  const context = retrieveJournalFailureContext();
  const notify = createAdminTelegramNotifier();
  for (const message of splitFailureNotification(buildFailureNotificationText(context))) {
    await notify(message);
  }
  logger.info("service-failure notification was sent.");
} catch (error: unknown) {
  fail(error);
}
