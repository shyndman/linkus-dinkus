export class Bot {
  constructor(token: string);

  readonly api: Readonly<{
    sendMessage(parameters: Readonly<{
      chat_id: string;
      text: string;
      entities: readonly Readonly<{
        type: "italic";
        offset: number;
        length: number;
      }>[];
    }>): Promise<unknown>;
  }>;
}
