import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Bot } from "gramio";

const PROJECT_ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));
config({ path: PROJECT_ENV_PATH, quiet: true });

type TelegramEnvironmentName = "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID";

function requireTelegramEnvironment(name: TelegramEnvironmentName): string {
  const value = process.env[name];
  if (value) return value;
  console.error(`notify: missing ${name}`);
  throw new Error(`Missing required environment variable: ${name}`);
}

async function sendTelegramNotification(bot: Bot, chatId: string, message: string): Promise<void> {
  try {
    await bot.api.sendMessage({
      chat_id: chatId,
      text: message,
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`notify: Telegram send failed: ${detail}`);
    throw new Error(`Could not send the Telegram notification: ${detail}`);
  }
}

export default function notifyExtension(pi: ExtensionAPI): void {
  const z = pi.zod;
  const bot = new Bot(requireTelegramEnvironment("TELEGRAM_BOT_TOKEN"));
  const chatId = requireTelegramEnvironment("TELEGRAM_CHAT_ID");

  pi.registerTool({
    name: "notify",
    label: "Notify",
    description: "Send a Telegram page-watch notification.",
    parameters: z.object({
      message: z.string().min(1).describe("Freeform description of what the page watch found."),
    }),
    approval: "write",
    loadMode: "essential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Notification cancelled." }],
          details: { notified: false },
        };
      }

      ctx.ui.notify(params.message, "info");
      await sendTelegramNotification(bot, chatId, params.message);

      return {
        content: [{ type: "text", text: params.message }],
        details: { notified: true, telegram_sent: true },
      };
    },
  });
}
