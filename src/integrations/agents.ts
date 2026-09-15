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
import type { JudgeAgentTask, ScriptAgentTask, ZeroJobInspectionTask } from "../page-watch/ports.ts";

const STYLED_OMP_RUNNER_PATH = resolve(PROJECT_ROOT, "src", "integrations", "run-omp-with-styled-output.ts");

type ExtractorReason = ScriptAgentTask["reason"];

const EXTRACTOR_RUN_MESSAGES = {
  setup: {
    start: "starting extractor setup.",
    finish: "extractor setup finished.",
  },
  "scheduled-audit": {
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
6. Determine the actual job count from the completely rendered page.
7. Treat a zero count as valid without any explicit empty statement.
8. Treat an observed bot block, a missing job list, or an unloaded job-list structure as an extraction failure.
9. Create \`snapshots/<url-slug>/extract\` and its typed source file.
10. Run \`bin/extract-snapshot <currentSnapshot>\`.
11. Compare the canonical Markdown with every extraction expectation.
12. Make sure stdout is JSON \`{ markdown, jobCount, jobs }\`. The jobCount must equal jobs.length and the actual extracted count.
13. Save the organization name at task.organizationNamePath.
14. Finish only when the canonical Markdown contains all required data and the reported jobCount is correct.`,
  "scheduled-audit": `Complete this audit workflow:
1. Inspect the supplied HTML and the saved extractor.
2. Run the saved extractor against the supplied HTML.
3. Compare the output with the data in the HTML.
4. Treat a zero extracted count as valid without any explicit empty statement.
5. Treat an observed bot block, a missing job list, or an unloaded job-list structure as an extraction failure.
6. Make sure stdout is JSON \`{ markdown, jobCount, jobs }\` with every extracted job and its actual count.
7. If the extractor is wrong, fix it and test it again.
8. If the extractor is correct, do not change it.`,
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
The extractor must write JSON \`{ markdown, jobCount, jobs }\` to standard output.
The jobs field must contain every extracted job as \`{ title, link }\`.
Each title must be a nonempty job title, not a section heading.
Each link must be an absolute HTTP or HTTPS direct job URL, or null when no direct URL is available.
Resolve relative job URLs against the watched page URL. Inspect anchors, attributes, and embedded data for direct links.
Do not substitute the jobs-page URL for a missing direct link. The application supplies that fallback.
The jobCount must equal jobs.length. Empty pages must return jobs: [].
Treat a listing without an identifiable title as an extraction failure.
The extractor must put the canonical Markdown in the markdown field.
The extractor must write failure details to standard error.
The extractor must return a nonzero status after a failure.
The extractor must return identical output for identical input.
The extractor must exclude timestamps and run-specific values from the Markdown.
The extractor must preserve data required by the notification trigger.
When jobs exist, the extractor must write every required job to the Markdown.
The jobCount field must be the nonnegative deterministic actual extracted count.
A zero job count is valid without any explicit empty statement.
Treat observed bot blocks and missing, unloaded, or changed job-list structures as failures.
Use Cheerio for HTML inspection and repair.
Use \`bin/defuddle\` when its Markdown output is useful.
The executable \`extract\` file must use \`node --import tsx\` to run TypeScript. Package-manager status output must not enter stdout.
HTML snapshots are immutable evidence.
Each timestamped HTML path links to its content-addressed object.
Draft Markdown is inspection output. Markdown without \`.draft\` is canonical comparison data.
The collector keeps the newest accepted snapshot, even after seven days, to preserve the baseline during unresolved incidents.
Other snapshots expire after seven days.
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
3. If the difference matches, submit a \`matched\` judgment with a short description of the change.
4. If a system problem prevents a valid judgment, submit a \`failure\` judgment with the problem.
The application identifies added jobs from structured extractor output and sends each job separately.
Do not recover job links or decide whether to remove bookmarks. Procedural code manages saved jobs.
Call \`submit-judgment\` exactly once.
The workflow sends one incident alert for a failed judgment and retains the previous accepted snapshot.
For changes without added jobs, the workflow places matched text under the saved organization-name heading.
Do not repeat the organization name in the matched text.
Do not change the canonical Markdown.`;

const ZERO_JOB_INSPECTION_INSTRUCTIONS = `You are the zero-job inspector. Do only this role.
Run all commands from the project root.
The task supplies the URL, snapshot directory, current HTML, previous canonical Markdown, previous job count, and organization name.
The current capture reports zero jobs after a previous nonzero count.
Do not edit the extractor or a snapshot. Do not send notifications.
1. Judge only the supplied captured HTML snapshot.
2. Read the previous canonical Markdown to see what the page offered before.
3. Determine whether the captured page is complete and legitimately offers zero jobs.
4. A valid page may have a normal empty jobs section without any explicit empty statement.
5. Never approve a zero count just because the page contains no job links or the fetch succeeded.
6. Treat an observed bot block, a login wall, a missing jobs section, or an unloaded structure as an invalid capture.
7. Inspect the live page with the browser only to explain the page's structure or resolve ambiguity.
8. A complete live page never validates an incomplete or blocked captured snapshot.
9. Submit a \`matched\` judgment only when the captured page is complete and legitimately offers zero jobs. Include the observed evidence.
10. For a blocked, incomplete, or invalid capture, submit a \`failure\` judgment with the reason and observed evidence.
The workflow logs the failure text and saves it with the incident.
11. Submit a \`not-matched\` judgment when you cannot determine whether the empty capture is legitimate.
Call \`submit-judgment\` exactly once.
Do not change the canonical Markdown.`;

async function runOmpAgent(
  thinking: "high" | "xhigh",
  maxTime: string,
  prompt: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  const startedAt = performance.now();
  logger.debug("starting an agent.", {
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
      "--config",
      "./omp.yml",
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
    child.once("close", (status: number | null, signal: NodeJS.Signals | null): void => {
      if (startFailed) return;
      if (status !== 0) {
        logger.error("agent failed.", {
          durationMs: Math.round(performance.now() - startedAt),
          status,
          signal,
        });
        rejectAgent(new Error(signal === null ? `omp failed with exit status ${status}` : `omp stopped with signal ${signal}`));
        return;
      }
      resolveAgent();
    });
  });
  logger.debug("agent finished.", {
    durationMs: Math.round(performance.now() - startedAt),
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
  const startedAt = performance.now();
  const messages = EXTRACTOR_RUN_MESSAGES[task.reason];
  logger.info(messages.start, { snapshot: basename(task.currentSnapshot) });
  await runOmpAgent(
    "xhigh",
    APPLICATION_CONFIG.agents.extractorMaxTimeSeconds,
    buildExtractorAgentPrompt(task),
  );
  logger.info(messages.finish, { durationMs: Math.round(performance.now() - startedAt) });
}

export function buildChangeJudgePrompt(task: JudgeAgentTask): string {
  return `${CHANGE_JUDGE_INSTRUCTIONS}
Task: ${JSON.stringify(task)}`;
}

export async function runChangeJudge(task: JudgeAgentTask): Promise<JudgmentResult> {
  logger.info("starting the change judge.", { snapshot: basename(task.currentSnapshot) });
  return runJudgmentAgent(
    "could not read the change judgment.",
    "Could not read the change judgment",
    buildChangeJudgePrompt(task),
  );
}

export function buildZeroJobInspectionPrompt(task: ZeroJobInspectionTask): string {
  return `${ZERO_JOB_INSPECTION_INSTRUCTIONS}
Task: ${JSON.stringify(task)}`;
}

export async function runZeroJobInspection(task: ZeroJobInspectionTask): Promise<JudgmentResult> {
  logger.info("starting the zero-job inspector.", { snapshot: basename(task.currentSnapshot) });
  return runJudgmentAgent(
    "could not read the zero-job inspection judgment.",
    "Could not read the zero-job inspection judgment",
    buildZeroJobInspectionPrompt(task),
  );
}

async function runJudgmentAgent(
  readErrorLog: string,
  readErrorMessage: string,
  prompt: string,
): Promise<JudgmentResult> {
  const startedAt = performance.now();
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
      logger.info("the judgment is ready.", {
        judgment: judgment.state,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return judgment;
    } catch (error: unknown) {
      const detail = errorDetail(error);
      logger.error(readErrorLog, { path: resultPath, error: detail });
      throw new Error(`${readErrorMessage}: ${detail}`);
    }
  } finally {
    await rm(resultDirectory, { recursive: true, force: true });
  }
}
