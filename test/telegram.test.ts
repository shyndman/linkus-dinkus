import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdminTelegramNotifier,
  createPageChangeTelegramNotifier,
} from "../src/integrations/telegram.ts";

type SentMessage = Readonly<{
  token: string;
  chatId: string;
  text: string;
  entities: readonly Readonly<{
    type: "italic";
    offset: number;
    length: number;
  }>[];
}>;

const ENVIRONMENT_NAMES = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_PAGE_CHANGE_CHAT_ID",
] as const;
type EnvironmentName = typeof ENVIRONMENT_NAMES[number];

test("routes page changes to both chats and failures only to the admin chat", async (): Promise<void> => {
  const previousEnvironment: Readonly<Record<EnvironmentName, string | undefined>> = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    TELEGRAM_PAGE_CHANGE_CHAT_ID: process.env.TELEGRAM_PAGE_CHANGE_CHAT_ID,
  };
  const sentMessages: SentMessage[] = [];

  class FakeBot {
    readonly api = {
      sendMessage: async (parameters: Readonly<{
        chat_id: string;
        text: string;
        entities: readonly Readonly<{
          type: "italic";
          offset: number;
          length: number;
        }>[];
      }>): Promise<void> => {
        sentMessages.push({
          token: this.token,
          chatId: parameters.chat_id,
          text: parameters.text,
          entities: parameters.entities,
        });
      },
    };

    constructor(private readonly token: string) {}
  }

  try {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "admin-chat";
    delete process.env.TELEGRAM_PAGE_CHANGE_CHAT_ID;

    await createAdminTelegramNotifier(FakeBot)("failure message");
    assert.deepEqual(sentMessages, [{
      token: "test-token",
      chatId: "admin-chat",
      text: "failure message",
      entities: [],
    }]);

    process.env.TELEGRAM_PAGE_CHANGE_CHAT_ID = "page-change-chat";
    await createPageChangeTelegramNotifier(FakeBot)("page change message");
    assert.deepEqual(sentMessages.slice(1), [
      {
        token: "test-token",
        chatId: "admin-chat",
        text: "page change message\n\n-Linkus Dinkus",
        entities: [{ type: "italic", offset: 21, length: 14 }],
      },
      {
        token: "test-token",
        chatId: "page-change-chat",
        text: "page change message\n\n-Linkus Dinkus",
        entities: [{ type: "italic", offset: 21, length: 14 }],
      },
    ]);
  } finally {
    for (const name of ENVIRONMENT_NAMES) {
      const value = previousEnvironment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
