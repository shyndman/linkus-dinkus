import { Bot } from "./gramio-runtime.js";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const PROJECT_ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
config({ path: PROJECT_ENV_PATH, quiet: true });

type TelegramEnvironmentName = "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID";
export type TelegramNotifier = (message: string) => Promise<void>;


function requireTelegramEnvironment(name: TelegramEnvironmentName): string {
  const value = process.env[name];
  if (value) return value;
  console.error(`telegram: missing ${name}`);
  throw new Error(`Missing required environment variable: ${name}`);
}

export function createTelegramNotifier(): TelegramNotifier {
  const bot = new Bot(requireTelegramEnvironment("TELEGRAM_BOT_TOKEN"));
  const chatId = requireTelegramEnvironment("TELEGRAM_CHAT_ID");
  return async (message: string): Promise<void> => {
    try {
      await bot.api.sendMessage({ chat_id: chatId, text: message });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`telegram: send failed: ${detail}`);
      throw new Error(`Could not send the Telegram notification: ${detail}`);
    }
  };
}
