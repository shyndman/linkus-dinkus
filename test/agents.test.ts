import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChangeJudgePrompt,
  buildExtractorAgentPrompt,
} from "../src/integrations/agents.ts";
import {
  HtmlSnapshotPathSchema,
  NotificationTriggerSchema,
  OrganizationNameSchema,
  SnapshotDirectorySchema,
  WatchedUrlSchema,
} from "../src/page-watch/domain.ts";
import type { JudgeAgentTask, ScriptAgentTask } from "../src/page-watch/ports.ts";

const url = WatchedUrlSchema.parse("https://example.com/jobs");
const snapshotDirectory = SnapshotDirectorySchema.parse("snapshots/https-example-com-jobs");
const currentSnapshot = HtmlSnapshotPathSchema.parse(
  "snapshots/https-example-com-jobs/snapshot-20260904T120000Z.html",
);
const notificationTrigger = NotificationTriggerSchema.parse("Notify when a job is added.");

const setupTask: ScriptAgentTask = {
  url,
  snapshotDirectory,
  currentSnapshot,
  notificationTrigger,
  organizationNamePath: "snapshots/https-example-com-jobs/organization-name.txt",
  reason: "setup",
};

const auditTask: ScriptAgentTask = {
  url,
  snapshotDirectory,
  currentSnapshot,
  notificationTrigger,
  reason: "fifth-html-change",
};

const organizationNameTask: ScriptAgentTask = {
  url,
  snapshotDirectory,
  currentSnapshot,
  organizationNamePath: "snapshots/https-example-com-jobs/organization-name.txt",
  reason: "organization-name",
};

const judgeTask: JudgeAgentTask = {
  url,
  snapshotDirectory,
  currentSnapshot,
  notificationTrigger,
  organizationName: OrganizationNameSchema.parse("Example"),
  comparison: {
    state: "changed",
    previous: "snapshots/https-example-com-jobs/snapshot-20260903T120000Z.md",
    current: "snapshots/https-example-com-jobs/snapshot-20260904T120000Z.md",
    diff: "+Senior Engineer\n",
  },
};

test("setup prompt contains the complete extractor workflow", (): void => {
  const prompt = buildExtractorAgentPrompt(setupTask);

  assert.doesNotMatch(prompt, /AGENTS\.md/);
  assert.match(prompt, /Complete this setup workflow:/);
  assert.match(prompt, /bin\/defuddle-snapshot <currentSnapshot>/);
  assert.match(prompt, /zero jobs lack explicit page evidence/);
  assert.match(prompt, /The command contract is `extract <snapshot\.html>`/);
  assert.ok(prompt.endsWith(`Task: ${JSON.stringify(setupTask)}`));
});

test("audit prompt contains only the applicable extractor workflow", (): void => {
  const prompt = buildExtractorAgentPrompt(auditTask);

  assert.match(prompt, /Complete this audit workflow:/);
  assert.match(prompt, /If the extractor is correct, do not change it\./);
  assert.doesNotMatch(prompt, /Complete this setup workflow:/);
  assert.ok(prompt.endsWith(`Task: ${JSON.stringify(auditTask)}`));
});

test("organization-name prompt excludes the extractor contract", (): void => {
  const prompt = buildExtractorAgentPrompt(organizationNameTask);

  assert.match(prompt, /Complete this organization-name workflow:/);
  assert.match(prompt, /Write only that organization name and a newline/);
  assert.doesNotMatch(prompt, /The command contract is/);
  assert.ok(prompt.endsWith(`Task: ${JSON.stringify(organizationNameTask)}`));
});

test("change-judge prompt contains its complete role contract", (): void => {
  const prompt = buildChangeJudgePrompt(judgeTask);

  assert.doesNotMatch(prompt, /AGENTS\.md/);
  assert.match(prompt, /Evaluate only the supplied Markdown difference/);
  assert.match(prompt, /nearby anchors, embedded data, and event metadata/);
  assert.match(prompt, /Call `submit-judgment` exactly once\./);
  assert.match(prompt, /Do not repeat the organization name/);
  assert.ok(prompt.endsWith(`Task: ${JSON.stringify(judgeTask)}`));
});
