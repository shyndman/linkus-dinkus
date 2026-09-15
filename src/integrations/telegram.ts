import type { BookmarkStore } from "../bookmarks/store.ts";
import type { JobIdentity } from "../page-watch/jobs.ts";
import { LinkifyIt } from "linkify-it";

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
  type: "bold" | "italic" | "text_link";
  offset: number;
  length: number;
  url?: string;
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
      reply_markup?: Readonly<{ inline_keyboard: readonly (readonly Readonly<{ text: string; callback_data: string }>[])[] }>;
    }>): Promise<unknown>;
  }>;
}>;
export type TelegramNotifier = (message: string) => Promise<void>;


function requireTelegramEnvironment(name: TelegramEnvironmentName): string {
  const value = process.env[name];
  if (value) {
    return value;
  }
  logger.error("a required Telegram setting is missing.", { setting: name });
  throw new Error(`Missing required environment variable: ${name}`);
}
const linkify = new LinkifyIt();
const COMPACT_LINK_LABEL = "link";

function linkifyMessage(message: string): TelegramMessage {
  const matches = linkify.match(message) ?? [];
  let text = "";
  let cursor = 0;
  const entities: TelegramMessageEntity[] = [];
  for (const match of matches) {
    text += message.slice(cursor, match.index);
    entities.push({
      type: "text_link",
      offset: text.length,
      length: COMPACT_LINK_LABEL.length,
      url: match.url,
    });
    text += COMPACT_LINK_LABEL;
    cursor = match.lastIndex;
  }
  text += message.slice(cursor);
  return { text, entities };
}
function formatPlainMessage(message: string): TelegramMessage {
  return linkifyMessage(message);
}

function formatPageChangeMessage(message: string): TelegramMessage {
  const linked = linkifyMessage(message);
  return {
    text: `${linked.text}${PAGE_CHANGE_SIGNATURE_SEPARATOR}${PAGE_CHANGE_SIGNATURE}`,
    entities: [
      ...linked.entities,
      {
        type: "italic",
        offset: linked.text.length + PAGE_CHANGE_SIGNATURE_SEPARATOR.length,
        length: PAGE_CHANGE_SIGNATURE.length,
      },
    ],
  };
}


function createTelegramNotifier(
  recipients: readonly TelegramRecipient[],
  formatMessage: TelegramMessageFormatter,
  BotClass: TelegramBotConstructor,
): TelegramNotifier {
  const bot = new BotClass(requireTelegramEnvironment("TELEGRAM_BOT_TOKEN"));
  logger.debug("telegram notifier is ready.", { recipients: recipients.length });
  return async (message: string): Promise<void> => {
    const formattedMessage = formatMessage(message);
    logger.debug("sending a Telegram notification.", {
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

export function createJobTelegramNotifier(
  store: Pick<BookmarkStore, "register">,
  BotClass: TelegramBotConstructor = Bot,
): (job: JobIdentity) => Promise<void> {
  const bot = new BotClass(requireTelegramEnvironment("TELEGRAM_BOT_TOKEN"));
  const recipients = [...new Set([
    requireTelegramEnvironment("TELEGRAM_CHAT_ID"),
    requireTelegramEnvironment("TELEGRAM_PAGE_CHANGE_CHAT_ID"),
  ])];
  return async (job): Promise<void> => {
    const token = await store.register(job);
    const heading = `${job.organizationName}\n`;
    const titleLine = `${job.title} (${COMPACT_LINK_LABEL})`;
    const content = `${heading}${titleLine}`;
    const message: TelegramMessage = {
      text: `${content}${PAGE_CHANGE_SIGNATURE_SEPARATOR}${PAGE_CHANGE_SIGNATURE}`,
      entities: [
        { type: "bold", offset: 0, length: job.organizationName.length },
        {
          type: "text_link",
          offset: heading.length + job.title.length + " (".length,
          length: COMPACT_LINK_LABEL.length,
          url: job.link,
        },
        {
          type: "italic",
          offset: content.length + PAGE_CHANGE_SIGNATURE_SEPARATOR.length,
          length: PAGE_CHANGE_SIGNATURE.length,
        },
      ],
    };
    try {
      await Promise.all(recipients.map(async (chatId) => bot.api.sendMessage({
        chat_id: chatId,
        ...message,
        reply_markup: { inline_keyboard: [[{ text: "🔖 Bookmark", callback_data: `save:${token}` }]] },
      })));
      logger.info("sent the new job with a bookmark button.", { organization: job.organizationName, title: job.title });
    } catch (error: unknown) {
      logger.error("could not send the new job.", { title: job.title, error: errorDetail(error) });
      throw error;
    }
  };
}
