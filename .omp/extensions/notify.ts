import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const NOTIFICATION_AUDIO_PATH = fileURLToPath(new URL("../notification.mp3", import.meta.url));
const FFPLAY_ARGUMENTS = [
  "ffplay",
  "-nodisp",
  "-autoexit",
  "-loglevel",
  "error",
  NOTIFICATION_AUDIO_PATH,
] as const;

export default function notifyExtension(pi: ExtensionAPI): void {
  const z = pi.zod;

  pi.registerTool({
    name: "notify",
    label: "Notify",
    description: "Notify the user about a page-watch finding and play the project notification sound.",
    parameters: z.object({
      message: z.string().min(1).describe("Freeform description of what the page watch found."),
    }),
    approval: "exec",
    loadMode: "essential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Notification cancelled." }],
          details: { notified: false },
        };
      }

      ctx.ui.notify(params.message, "info");
      const player = Bun.spawn(FFPLAY_ARGUMENTS, {
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderrPromise = new Response(player.stderr).text();
      player.unref();
      void Promise.all([player.exited, stderrPromise])
        .then(([exitCode, stderr]): void => {
          if (exitCode === 0) return;
          const detail = stderr.trim() || `exit status ${exitCode}`;
          console.error(`notify: ffplay failed: ${detail}`);
        })
        .catch((error: unknown): void => {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`notify: could not monitor ffplay: ${detail}`);
        });

      return {
        content: [{ type: "text", text: params.message }],
        details: { notified: true },
      };
    },
  });
}
