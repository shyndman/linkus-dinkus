import { Bot } from "./gramio-runtime.js";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { errorDetail, logger } from "../logger.ts";

const PROJECT_ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));
config({ path: PROJECT_ENV_PATH, quiet: true });

type TelegramEnvironmentName = "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID";
export type TelegramNotifier = (message: string) => Promise<void>;


function requireTelegramEnvironment(name: TelegramEnvironmentName): string {
  const value = process.env[name];
  if (value) {
    logger.info(`The ${name} Telegram setting is present.`);
    return value;
  }
  logger.error(`The ${name} Telegram setting is missing.`);
  throw new Error(`Missing required environment variable: ${name}`);
}

export function createTelegramNotifier(): TelegramNotifier {
  const bot = new Bot(requireTelegramEnvironment("TELEGRAM_BOT_TOKEN"));
  const chatId = requireTelegramEnvironment("TELEGRAM_CHAT_ID");
  logger.info("The Telegram notifier is ready.");
  return async (message: string): Promise<void> => {
    logger.info(`Sending a Telegram notification with ${message.length} characters.`);
    try {
      await bot.api.sendMessage({ chat_id: chatId, text: message });
      logger.info("Telegram accepted the notification.");
    } catch (error: unknown) {
      const detail = errorDetail(error);
      logger.error(`Telegram rejected the notification. ${detail}`);
      throw new Error(`Could not send the Telegram notification: ${detail}`);
    }
  };
}
