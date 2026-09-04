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

type ExtractorReason = ScriptAgentTask["reason"];

const EXTRACTOR_RUN_MESSAGES = {
  setup: {
    start: "starting extractor setup.",
    finish: "extractor setup finished.",
  },
  "fifth-html-change": {
    start: "starting the scheduled extractor audit.",
    finish: "extractor audit finished.",
  },
  "organization-name": {
    start: "starting organization-name capture.",
    finish: "organization-name capture finished.",
  },
} as const satisfies Readonly<Record<ExtractorReason, Readonly<{ start: string; finish: string }>>>;

const EXTRACTOR_COMMON_INSTRUCTIONS = `You are the extractor agent. Do only this role.
Run all commands from the project root.
Use pnpm for JavaScript dependencies.
The task supplies one URL, snapshot directory, current HTML snapshot, and reason.
Setup and audit tasks also supply a notification trigger.
Do not evaluate a change against the notification trigger.
Do not send notifications.`;

const EXTRACTOR_REASON_INSTRUCTIONS = {
  setup: `Complete this setup workflow:
1. Inspect the rendered page with \`bin/camou snapshot -i\`.
2. Record visible items, names, counts, direct links, and the job-list container as extraction expectations.
3. Run \`bin/defuddle-snapshot <currentSnapshot>\` to create draft Markdown.
4. Compare the draft with every extraction expectation.
5. Inspect the supplied HTML when the draft loses required content or relationships.
6. Identify the page's explicit evidence for zero open jobs.
7. Treat a missing job list without that evidence as an extraction failure.
8. Create \`snapshots/<url-slug>/extract\` and its typed source file.
9. Run \`bin/extract-snapshot <currentSnapshot>\`.
10. Compare the canonical Markdown with every extraction expectation.
11. Save the organization name at task.organizationNamePath.
12. Finish only when the canonical Markdown contains all required data.`,
  "fifth-html-change": `Complete this audit workflow:
1. Inspect the supplied HTML and the saved extractor.
2. Run the saved extractor against the supplied HTML.
3. Compare the output with the data in the HTML.
4. Make sure zero extracted jobs require explicit empty-state evidence from the page.
5. If the extractor is wrong, fix it and test it again.
6. If the extractor is correct, do not change it.`,
  "organization-name": `Complete this organization-name workflow:
1. Inspect the supplied HTML.
2. Identify the organization that owns the jobs page.
3. Use standard capitalization where appropriate.
4. Preserve intentional lowercase or uppercase company styling from the source.
5. Write only that organization name and a newline to task.organizationNamePath.
6. Do not edit the extractor or a snapshot.`,
} as const satisfies Readonly<Record<ExtractorReason, string>>;

const EXTRACTOR_CONTRACT_INSTRUCTIONS = `The fixed extractor path is \`snapshots/<url-slug>/extract\`.
The fixed organization-name path is \`snapshots/<url-slug>/organization-name.txt\`.
The command contract is \`extract <snapshot.html>\`.
The extractor must read one local HTML snapshot.
The extractor must make no network requests.
The extractor must write canonical Markdown to standard output.
The extractor must write failure details to standard error.
The extractor must return a nonzero status after a failure.
The extractor must return identical output for identical input.
The extractor must exclude timestamps and run-specific values from the Markdown.
The extractor must preserve data required by the notification trigger.
When jobs exist, the extractor must write every required job to the Markdown.
When the page explicitly states that no jobs exist, write a stable empty-result marker.
When zero jobs lack explicit page evidence, write failure details and return a nonzero status.
Treat a missing, unloaded, blocked, or changed job-list structure as a failure.
Use Cheerio for HTML inspection and repair.
Use \`bin/defuddle\` when its Markdown output is useful.
The executable \`extract\` file can call typed TypeScript through \`pnpm exec tsx\`.
HTML snapshots are immutable evidence.
Each timestamped HTML path links to its content-addressed object.
Draft Markdown is inspection output. Markdown without \`.draft\` is canonical comparison data.
The poll cycle deletes snapshot files after seven days.
The poll cycle then deletes each HTML object without a timestamped link.
\`bin/defuddle-snapshot <snapshot.html>\` creates draft Markdown.
\`bin/extract-snapshot <snapshot.html>\` runs the saved extractor and creates canonical Markdown.
\`bin/compare-snapshots <snapshot-directory>\` compares the two newest canonical Markdown files.`;

const CHANGE_JUDGE_INSTRUCTIONS = `You are the change judge. Do only this role.
Run all commands from the project root.
The task supplies one URL and snapshot directory.
The task supplies the current HTML snapshot and notification trigger.
The task supplies the saved organization name.
The task supplies previous and current canonical Markdown paths and their difference.
Do not edit the extractor or a snapshot.
1. Evaluate only the supplied Markdown difference against the notification trigger.
2. If the difference does not match, submit a \`not-matched\` judgment.
3. If the difference matches, identify each added job.
4. For each added job without a direct link, inspect the current HTML snapshot.
5. Examine its element, attributes, nearby anchors, embedded data, and event metadata for a URL.
6. Resolve a relative URL against the watched page URL.
7. Submit a \`matched\` judgment with the change text that the notification trigger requests.
8. Include each added job name and each recovered direct link.
9. If URL recovery fails, submit the judgment without a link.
10. If a system problem prevents a valid judgment, submit a \`failure\` judgment with the problem.
Call \`submit-judgment\` exactly once.
The workflow sends failure text without changes.
The workflow places matched text under the saved organization-name heading.
Do not repeat the organization name in the matched text.
Use URL recovery only for judgment text.
Do not change the canonical Markdown.`;

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

export function buildExtractorAgentPrompt(task: ScriptAgentTask): string {
  const contract = task.reason === "organization-name" ? "" : `
${EXTRACTOR_CONTRACT_INSTRUCTIONS}`;
  return `${EXTRACTOR_COMMON_INSTRUCTIONS}
${EXTRACTOR_REASON_INSTRUCTIONS[task.reason]}${contract}
Task: ${JSON.stringify(task)}`;
}

export async function runExtractorAgent(task: ScriptAgentTask): Promise<void> {
  const messages = EXTRACTOR_RUN_MESSAGES[task.reason];
  logger.info(messages.start, { snapshot: basename(task.currentSnapshot) });
  await runOmpAgent(
    "xhigh",
    APPLICATION_CONFIG.agents.extractorMaxTimeSeconds,
    buildExtractorAgentPrompt(task),
  );
  logger.info(messages.finish);
}

export function buildChangeJudgePrompt(task: JudgeAgentTask): string {
  return `${CHANGE_JUDGE_INSTRUCTIONS}
Task: ${JSON.stringify(task)}`;
}

export async function runChangeJudge(task: JudgeAgentTask): Promise<JudgmentResult> {
  logger.info("starting the change judge.", { snapshot: basename(task.currentSnapshot) });
  const prompt = buildChangeJudgePrompt(task);
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
