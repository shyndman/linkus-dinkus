import { Bot } from "./gramio-runtime.js";
import { errorDetail, logger } from "../logger.ts";

import "../runtime.ts";
const PAGE_CHANGE_SIGNATURE = "-Linkus Dinkus";
const PAGE_CHANGE_SIGNATURE_SEPARATOR = "\n\n";

type TelegramEnvironmentName =
  | "TELEGRAM_BOT_TOKEN"
  | "TELEGRAM_CHAT_ID"
  | "TELEGRAM_PAGE_CHANGE_CHAT_ID";
type TelegramRecipient = Readonly<{
  name: "admin" | "page-change";
  chatId: string;
}>;
type TelegramMessageEntity = Readonly<{
  type: "italic";
  offset: number;
  length: number;
}>;
type TelegramMessage = Readonly<{
  text: string;
  entities: readonly TelegramMessageEntity[];
}>;
type TelegramMessageFormatter = (message: string) => TelegramMessage;
type TelegramBotConstructor = new (token: string) => Readonly<{
  api: Readonly<{
    sendMessage(parameters: Readonly<{
      chat_id: string;
      text: string;
      entities: readonly TelegramMessageEntity[];
    }>): Promise<unknown>;
  }>;
}>;
export type TelegramNotifier = (message: string) => Promise<void>;


function requireTelegramEnvironment(name: TelegramEnvironmentName): string {
  const value = process.env[name];
  if (value) {
    logger.info("a required Telegram setting is present.", { setting: name });
    return value;
  }
  logger.error("a required Telegram setting is missing.", { setting: name });
  throw new Error(`Missing required environment variable: ${name}`);
}
function formatPlainMessage(message: string): TelegramMessage {
  return { text: message, entities: [] };
}

function formatPageChangeMessage(message: string): TelegramMessage {
  return {
    text: `${message}${PAGE_CHANGE_SIGNATURE_SEPARATOR}${PAGE_CHANGE_SIGNATURE}`,
    entities: [{
      type: "italic",
      offset: message.length + PAGE_CHANGE_SIGNATURE_SEPARATOR.length,
      length: PAGE_CHANGE_SIGNATURE.length,
    }],
  };
}


function createTelegramNotifier(
  recipients: readonly TelegramRecipient[],
  formatMessage: TelegramMessageFormatter,
  BotClass: TelegramBotConstructor,
): TelegramNotifier {
  const bot = new BotClass(requireTelegramEnvironment("TELEGRAM_BOT_TOKEN"));
  logger.info("telegram notifier is ready.", { recipients: recipients.length });
  return async (message: string): Promise<void> => {
    const formattedMessage = formatMessage(message);
    logger.info("sending a Telegram notification.", {
      characters: formattedMessage.text.length,
      recipients: recipients.length,
    });
    await Promise.all(recipients.map(async (recipient: TelegramRecipient): Promise<void> => {
      try {
        await bot.api.sendMessage({ chat_id: recipient.chatId, ...formattedMessage });
        logger.info("telegram accepted the notification.", { recipient: recipient.name });
      } catch (error: unknown) {
        const detail = errorDetail(error);
        logger.error("telegram rejected the notification.", {
          error: detail,
          recipient: recipient.name,
        });
        throw new Error(`Could not send the Telegram notification to ${recipient.name}: ${detail}`);
      }
    }));
  };
}

export function createAdminTelegramNotifier(
  BotClass: TelegramBotConstructor = Bot,
): TelegramNotifier {
  return createTelegramNotifier([{
    name: "admin",
    chatId: requireTelegramEnvironment("TELEGRAM_CHAT_ID"),
  }], formatPlainMessage, BotClass);
}

export function createPageChangeTelegramNotifier(
  BotClass: TelegramBotConstructor = Bot,
): TelegramNotifier {
  return createTelegramNotifier([
    {
      name: "admin",
      chatId: requireTelegramEnvironment("TELEGRAM_CHAT_ID"),
    },
    {
      name: "page-change",
      chatId: requireTelegramEnvironment("TELEGRAM_PAGE_CHANGE_CHAT_ID"),
    },
  ], formatPageChangeMessage, BotClass);
}
