import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { APPLICATION_CONFIG } from "../config.ts";
import { errorDetail, logger } from "../logger.ts";
import { PROJECT_ROOT } from "../runtime.ts";
import {
  JUDGMENT_RESULT_PATH_ENVIRONMENT_VARIABLE,
  readJudgmentResult,
  type JudgmentResult,
} from "../page-watch/judgment.ts";
import type { JudgeAgentTask, ScriptAgentTask } from "../page-watch/ports.ts";

const STYLED_OMP_RUNNER_PATH = resolve(PROJECT_ROOT, "src", "integrations", "run-omp-with-styled-output.ts");
const ORGANIZATION_CAPITALIZATION_INSTRUCTION =
  "Use standard capitalization unless the source intentionally styles the company name differently.";

async function runOmpAgent(
  thinking: "high" | "xhigh",
  maxTime: string,
  prompt: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  const startedAt = performance.now();
  logger.info("starting an agent.", {
    model: APPLICATION_CONFIG.agents.model,
    timeLimitSeconds: Number(maxTime),
  });
  await new Promise<void>((resolveAgent, rejectAgent): void => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      STYLED_OMP_RUNNER_PATH,
      "--model", APPLICATION_CONFIG.agents.model,
      `--thinking=${thinking}`,
      `--max-time=${maxTime}`,
      "--print",
      "--mode=text",
      "--no-session",
      prompt,
    ], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "inherit", "inherit"],
    });
    let startFailed = false;
    child.once("error", (error: Error): void => {
      startFailed = true;
      logger.error("agent could not start.", { error: error.message });
      rejectAgent(new Error(`omp failed to start: ${error.message}`));
    });
    child.once("close", (status: number | null): void => {
      if (startFailed) return;
      if (status !== 0) {
        logger.error("agent failed.", {
          durationMilliseconds: Math.round(performance.now() - startedAt),
          status,
        });
        rejectAgent(new Error(`omp failed with exit status ${status}`));
        return;
      }
      resolveAgent();
    });
  });
  logger.info("agent finished.", {
    durationMilliseconds: Math.round(performance.now() - startedAt),
  });
}

export async function runExtractorAgent(task: ScriptAgentTask): Promise<void> {
  let action: string;
  let startMessage: string;
  let finishMessage: string;
  switch (task.reason) {
    case "setup":
      action = `Create and test the extractor. Save the organization name at organizationNamePath. ${ORGANIZATION_CAPITALIZATION_INSTRUCTION}`;
      startMessage = "starting extractor setup.";
      finishMessage = "extractor setup finished.";
      break;
    case "fifth-html-change":
      action = "Examine the saved extractor against the current HTML. Fix and test it only if it is wrong.";
      startMessage = "starting the scheduled extractor audit.";
      finishMessage = "extractor audit finished.";
      break;
    case "organization-name":
      action = `Inspect the current HTML and save the organization name at organizationNamePath. ${ORGANIZATION_CAPITALIZATION_INSTRUCTION} Do not edit the extractor or snapshots.`;
      startMessage = "starting organization-name capture.";
      finishMessage = "organization-name capture finished.";
      break;
  }
  logger.info(startMessage, { snapshot: basename(task.currentSnapshot) });
  const prompt = [
    "Act only as the extractor agent described in AGENTS.md.",
    action,
    "Do not evaluate notification conditions and do not send notifications.",
    `Task: ${JSON.stringify(task)}`,
  ].join("\n");
  await runOmpAgent("xhigh", APPLICATION_CONFIG.agents.extractorMaxTimeSeconds, prompt);
  logger.info(finishMessage);
}

export async function runChangeJudge(task: JudgeAgentTask): Promise<JudgmentResult> {
  logger.info("starting the change judge.", { snapshot: basename(task.currentSnapshot) });
  const prompt = [
    "Act only as the change judge described in AGENTS.md.",
    "Evaluate the supplied Markdown difference against notificationTrigger.",
    "Submit exactly one result with the submit-judgment tool.",
    `Task: ${JSON.stringify(task)}`,
  ].join("\n");
  const resultDirectory = await mkdtemp(join(tmpdir(), "page-watch-judgment-"));
  const resultPath = join(resultDirectory, "result.json");
  try {
    await runOmpAgent(
      "high",
      APPLICATION_CONFIG.agents.judgeMaxTimeSeconds,
      prompt,
      { [JUDGMENT_RESULT_PATH_ENVIRONMENT_VARIABLE]: resultPath },
    );
    try {
      const judgment = await readJudgmentResult(resultPath);
      logger.info("change judge finished.", { judgment: judgment.state });
      return judgment;
    } catch (error: unknown) {
      const detail = errorDetail(error);
      logger.error("could not read the change judgment.", { error: detail });
      throw new Error(`Could not read the change judgment: ${detail}`);
    }
  } finally {
    await rm(resultDirectory, { recursive: true, force: true });
  }
}
