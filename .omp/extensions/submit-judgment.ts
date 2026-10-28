import { rename, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  JUDGMENT_RESULT_PATH_ENVIRONMENT_VARIABLE,
  JudgmentResultSchema,
} from "../../src/page-watch/judgment.ts";


export default function submitJudgmentExtension(pi: ExtensionAPI): void {
  const z = pi.zod;

  pi.registerTool({
    name: "submit-judgment",
    label: "Submit Judgment",
    description: "Submit one structured page-watch judgment.",
    parameters: z.object({
      state: z.enum(["matched", "not-matched", "failure"]).describe("The judgment state."),
      text: z.string().min(1).optional().describe(
        "The exact text to send for a matched or failure judgment. Omit it for not-matched.",
      ),
    }),
    approval: "write",
    loadMode: "essential",
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Judgment submission was canceled.");
      const judgment = JudgmentResultSchema.parse(params);
      const resultPath = process.env[JUDGMENT_RESULT_PATH_ENVIRONMENT_VARIABLE];
      if (resultPath === undefined) {
        console.error("the judgment result path is missing.");
        throw new Error(`Missing required environment variable: ${JUDGMENT_RESULT_PATH_ENVIRONMENT_VARIABLE}`);
      }

      const temporaryPath = `${resultPath}.${process.pid}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(judgment)}\n`, { encoding: "utf8", flag: "wx" });
        await rename(temporaryPath, resultPath);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("could not save the judgment result.", { error: detail });
        throw new Error(`Could not save the judgment result: ${detail}`);
      }

      return {
        content: [{ type: "text", text: "Judgment submitted." }],
        details: { submitted: true, state: judgment.state },
      };
    },
  });
}
