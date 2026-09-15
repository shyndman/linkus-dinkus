export type BookmarkCallback = Readonly<{
  chatId: number | undefined;
  data: string;
  answer: (parameters: Readonly<{ text: string; show_alert: boolean }>) => Promise<true>;
}>;

export class Bot {
  constructor(token: string);
  on(event: "callback_query", handler: (context: BookmarkCallback) => Promise<void>): this;
  onStart(handler: () => void): this;
  onError(handler: (context: Readonly<{ error: unknown }>) => void): this;
  start(options: Readonly<{ allowedUpdates: readonly ["callback_query"]; dropPendingUpdates: false }>): Promise<unknown>;
  stop(): Promise<void>;

  readonly api: Readonly<{
    sendMessage(parameters: Readonly<{
      chat_id: string;
      text: string;
      entities: readonly Readonly<{
        type: "bold" | "italic" | "text_link";
        offset: number;
        length: number;
        url?: string;
      }>[];
      reply_markup?: Readonly<{
        inline_keyboard: readonly (readonly Readonly<{ text: string; callback_data: string }>[])[];
      }>;
    }>): Promise<unknown>;
  }>;
}
