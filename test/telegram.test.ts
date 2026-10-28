import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdminTelegramNotifier,
  createJobTelegramNotifier,
  createPageChangeTelegramNotifier,
} from "../src/integrations/telegram.ts";
import type { Bot } from "../src/integrations/gramio-runtime.js";

type SentMessage = Readonly<{
  token: string;
  chatId: string;
  text: string;
  entities: readonly Readonly<{
    type: "bold" | "text_link" | "italic";
    offset: number;
    length: number;
    url?: string;
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
          type: "bold" | "text_link" | "italic";
          offset: number;
          length: number;
          url?: string;
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

    await createAdminTelegramNotifier(FakeBot)("failure at https://example.com/a");
    assert.deepEqual(sentMessages.slice(0, 1), [{
      token: "test-token",
      chatId: "admin-chat",
      text: "failure at link",
      entities: [{
        type: "text_link",
        offset: 11,
        length: 4,
        url: "https://example.com/a",
      }],
    }]);

    process.env.TELEGRAM_PAGE_CHANGE_CHAT_ID = "page-change-chat";
    await createPageChangeTelegramNotifier(FakeBot)("new page https://example.com/b");
    assert.deepEqual(sentMessages.slice(1), [
      {
        token: "test-token",
        chatId: "admin-chat",
        text: "new page link\n\n-Linkus Dinkus",
        entities: [
          {
            type: "text_link",
            offset: 9,
            length: 4,
            url: "https://example.com/b",
          },
          { type: "italic", offset: 15, length: 14 },
        ],
      },
      {
        token: "test-token",
        chatId: "page-change-chat",
        text: "new page link\n\n-Linkus Dinkus",
        entities: [
          {
            type: "text_link",
            offset: 9,
            length: 4,
            url: "https://example.com/b",
          },
          { type: "italic", offset: 15, length: 14 },
        ],
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

test("bolds the organization and links only the label beside the job title", async () => {
  const previousEnvironment = Object.fromEntries(ENVIRONMENT_NAMES.map(name => [name, process.env[name]]));
  type Message = Parameters<Bot["api"]["sendMessage"]>[0];
  const messages: Message[] = [];
  class CapturingBot {
    readonly api = {
      sendMessage: async (message: Message): Promise<void> => { messages.push(message); },
    };
  }
  try {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "admin-chat";
    process.env.TELEGRAM_PAGE_CHANGE_CHAT_ID = "admin-chat";
    const job = {
      organizationName: "Example \u{10400} Organization",
      title: "Restoration Lead",
      link: "https://example.com/careers/restoration-lead",
      pageUrl: "https://example.com/careers",
    };
    await createJobTelegramNotifier({ register: async () => "test-token" }, CapturingBot)(job);
    const message = messages[0];
    assert.ok(message);
    assert.equal(message.text, `${job.organizationName}\n${job.title} (link)\n\n-Linkus Dinkus`);
    const bold = message.entities.find(entity => entity.type === "bold");
    const link = message.entities.find(entity => entity.type === "text_link");
    assert.ok(bold);
    assert.ok(link);
    assert.equal(message.text.slice(bold.offset, bold.offset + bold.length), job.organizationName);
    assert.equal(message.text.slice(link.offset, link.offset + link.length), "link");
    assert.equal(message.text[link.offset - 1], "(");
    assert.equal(message.text[link.offset + link.length], ")");
    assert.equal(link.url, job.link);
  } finally {
    for (const name of ENVIRONMENT_NAMES) {
      const previous = previousEnvironment[name];
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
});

test("preserves systemd paths instead of sending invalid email links to the admin", async (): Promise<void> => {
  const previousEnvironment = Object.fromEntries(ENVIRONMENT_NAMES.map(name => [name, process.env[name]]));
  type Message = Parameters<Bot["api"]["sendMessage"]>[0];
  const messages: Message[] = [];
  class CapturingBot {
    readonly api = {
      sendMessage: async (message: Message): Promise<void> => { messages.push(message); },
    };
  }
  const diagnostic = "CGroup: /user.slice/user-1000.slice/user@1000.service/app.slice/linkus-dinkus.service";
  try {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "admin-chat";
    await createAdminTelegramNotifier(CapturingBot)(diagnostic);
    assert.equal(messages[0]?.text, diagnostic);
    assert.deepEqual(messages[0]?.entities, []);
  } finally {
    for (const name of ENVIRONMENT_NAMES) {
      const previous = previousEnvironment[name];
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
});
