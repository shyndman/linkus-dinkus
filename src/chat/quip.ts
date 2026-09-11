import { readFile } from "node:fs/promises";
import { generateText } from "ai";
import { createLanguageModel } from "../integrations/ai.ts";
import { fail } from "../runtime.ts";

const SYSTEM_PROMPT_URL = new URL("../resources/quip-system-prompt.md", import.meta.url);
const USAGE = 'Usage: bin/quip "your message"';

try {
  const messages = process.argv.slice(2);
  if (messages.length !== 1 || messages[0].trim().length === 0) {
    throw new Error(USAGE);
  }

  const system = await readFile(SYSTEM_PROMPT_URL, "utf8");
  const result = await generateText({
    model: createLanguageModel(),
    system,
    prompt: messages[0],
  });
  process.stdout.write(`${result.text}\n`);
} catch (error: unknown) {
  fail(error);
}
