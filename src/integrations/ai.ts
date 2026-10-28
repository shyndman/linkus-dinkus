import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { logger } from "../logger.ts";

import "../runtime.ts";

export type LlmProviderConfig = Readonly<{
  baseURL: string;
  apiKey: string;
  modelId: string;
  modelProvider: string;
}>;

function requireSetting(name: "LLM_PROVIDER_URL" | "LLM_PROVIDER_API_TOKEN" | "LLM_PROVIDER_MODEL_PROVIDER" | "LLM_PROVIDER_MODEL_ID"): string {
  const value = process.env[name];
  if (!value) {
    logger.error("a required LLM provider setting is missing.", { setting: name });
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function readLlmProviderConfig(): LlmProviderConfig {
  const modelProvider = requireSetting("LLM_PROVIDER_MODEL_PROVIDER");
  const modelId = requireSetting("LLM_PROVIDER_MODEL_ID");
  const prefix = `${modelProvider}/`;

  return {
    baseURL: requireSetting("LLM_PROVIDER_URL"),
    apiKey: requireSetting("LLM_PROVIDER_API_TOKEN"),
    modelId: modelId.startsWith(prefix) ? modelId : `${prefix}${modelId}`,
    modelProvider,
  };
}

export function createLanguageModel(): LanguageModel {
  const { baseURL, apiKey, modelId, modelProvider } = readLlmProviderConfig();
  const provider = createOpenAICompatible({
    baseURL: new URL("/v1", baseURL).href,
    apiKey,
    name: modelProvider,
    includeUsage: true,
    supportsMultiPartToolContent: true,
    supportsStructuredOutputs: false,
  });

  logger.debug("the AI SDK model is ready.", { model: modelId });
  return provider.chatModel(modelId);
}
