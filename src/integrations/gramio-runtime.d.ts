export class Bot {
  constructor(token: string);

  readonly api: Readonly<{
    sendMessage(parameters: Readonly<{ chat_id: string; text: string }>): Promise<unknown>;
  }>;
}
