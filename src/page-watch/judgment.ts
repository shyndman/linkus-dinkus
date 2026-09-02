import { readFile } from "node:fs/promises";
import { z } from "zod";

export const JUDGMENT_RESULT_PATH_ENVIRONMENT_VARIABLE = "PAGE_WATCH_JUDGMENT_RESULT_PATH";

const JudgmentTextSchema = z.string().refine(
  (text: string): boolean => text.trim().length > 0,
  "Judgment text must not be empty.",
);

export const JudgmentResultSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("matched"), text: JudgmentTextSchema }),
  z.strictObject({ state: z.literal("not-matched") }),
  z.strictObject({ state: z.literal("failure"), text: JudgmentTextSchema }),
]);

export type JudgmentResult = z.infer<typeof JudgmentResultSchema>;


export async function readJudgmentResult(path: string): Promise<JudgmentResult> {
  const content = await readFile(path, "utf8");
  return JudgmentResultSchema.parse(JSON.parse(content) as unknown);
}
