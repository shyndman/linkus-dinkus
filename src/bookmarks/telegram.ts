import { pathToFileURL } from "node:url";
import { Bot, type BookmarkCallback } from "../integrations/gramio-runtime.js";
import { errorDetail, logger } from "../logger.ts";
import { fail } from "../runtime.ts";
import { createBookmarkStore, type BookmarkStore } from "./store.ts";

const CALLBACK_PATTERN = /^save:([a-f0-9]{40})$/;
const SAVE_MESSAGES = {
  saved: "Saved to the spreadsheet.",
  "already-saved": "This job is already in the spreadsheet.",
  unavailable: "This job is no longer available to bookmark.",
} as const;

export function createBookmarkCallbackHandler(
  store: BookmarkStore,
  allowedChatIds: readonly string[],
): (context: BookmarkCallback) => Promise<void> {
  return async (context): Promise<void> => {
    const match = CALLBACK_PATTERN.exec(context.data);
    if (context.chatId === undefined || !allowedChatIds.includes(String(context.chatId)) || match === null) {
      logger.warn("rejected a bookmark callback.", { chatId: context.chatId ?? null });
      await context.answer({ text: "This bookmark action is not available.", show_alert: true });
      return;
    }
    let text: string;
    let failed = false;
    try {
      text = SAVE_MESSAGES[await store.save(match[1]!)];
    } catch (error: unknown) {
      logger.error("could not save the Telegram bookmark.", { error: errorDetail(error) });
      text = "Could not save this job. Please try again.";
      failed = true;
    }
    await context.answer({ text, show_alert: failed });
  };
}

export async function runBookmarkBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.TELEGRAM_CHAT_ID;
  const pageChatId = process.env.TELEGRAM_PAGE_CHANGE_CHAT_ID;
  if (!token || !adminChatId || !pageChatId) throw new Error("The required Telegram settings are missing.");
  const store = createBookmarkStore();
  await store.initialize();
  const bot = new Bot(token)
    .on("callback_query", createBookmarkCallbackHandler(store, [adminChatId, pageChatId]))
    .onError(({ error }) => logger.error("the bookmark bot failed.", { error: errorDetail(error) }))
    .onStart(() => logger.info("the Telegram bookmark bot is ready."));
  const stop = (): void => { bot.stop().catch(fail); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await bot.start({ allowedUpdates: ["callback_query"], dropPendingUpdates: false });
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  runBookmarkBot().catch(fail);
}
