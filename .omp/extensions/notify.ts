import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createTelegramNotifier } from "../../src/integrations/telegram.ts";


export default function notifyExtension(pi: ExtensionAPI): void {
  const z = pi.zod;
  const sendTelegramNotification = createTelegramNotifier();

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
      await sendTelegramNotification(params.message);

      return {
        content: [{ type: "text", text: params.message }],
        details: { notified: true, telegram_sent: true },
      };
    },
  });
}
