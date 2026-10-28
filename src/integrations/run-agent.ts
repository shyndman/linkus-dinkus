import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLlmProviderConfig } from "./ai.ts";
import { logger } from "../logger.ts";
import { fail, PROJECT_ROOT } from "../runtime.ts";

async function main(): Promise<void> {
  const { baseURL, modelId, modelProvider } = readLlmProviderConfig();
  const agentDirectory = await mkdtemp(join(tmpdir(), "linkus-llm-"));

  try {
    await writeFile(join(agentDirectory, "models.yml"), JSON.stringify({
      providers: {
        [modelProvider]: {
          transport: "pi-native",
          baseUrl: baseURL,
          apiKey: "LLM_PROVIDER_API_TOKEN",
        },
      },
    }), { mode: 0o600 });

    logger.debug("starting the agent with the configured LLM provider.", { model: modelId });
    const child = spawn(process.argv[2], [
      "--model", modelId,
      ...process.argv.slice(3),
    ], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
      stdio: "inherit",
    });
    const [status, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    if (status !== 0) {
      logger.error("configured agent process failed.", { status, signal });
      process.exitCode = status ?? 1;
      return;
    }

    logger.debug("configured agent process finished.");
  } finally {
    await rm(agentDirectory, { recursive: true, force: true });
  }
}

main().catch(fail);
