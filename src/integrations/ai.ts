import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { APPLICATION_CONFIG } from "../config.ts";
import { logger } from "../logger.ts";

import "../runtime.ts";

const OPENROUTER_MODEL_ID = APPLICATION_CONFIG.agents.model.slice("openrouter/".length);

export function createLanguageModel(): LanguageModel {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    logger.error("a required OpenRouter setting is missing.", { setting: "OPENROUTER_API_KEY" });
    throw new Error("Missing required environment variable: OPENROUTER_API_KEY");
  }

  const provider = createOpenRouter({ apiKey });
  logger.debug("the AI SDK model is ready.", { model: APPLICATION_CONFIG.agents.model });
  return provider.chat(OPENROUTER_MODEL_ID);
}
