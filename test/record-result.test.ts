import assert from "node:assert/strict";
import type { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  recordUrlResult,
  type RecordResult,
  type UrlResult,
} from "../src/page-watch/record-result.ts";
import {
  retrieveCurrentJournalContext,
  type JournalFailureContext,
} from "../src/systemd/journal.ts";

const TEST_URL_PREFIX = "https://record-result.test/incident-";
const STATE_FILENAME = "failure-state.json";
const JOURNAL_CONTEXT: JournalFailureContext = {
  unit: "linkus-dinkus.service",
  invocationId: "current-run",
  serviceResult: null,
  exitCode: null,
  exitStatus: null,
  log: "latest current-run journal entry",
  retrievalError: null,
};

type Notifier = (message: string) => Promise<void>;
type StateSnapshot = Readonly<{
  consecutiveFailures: number;
  alertSent: boolean;
  lastFailureReason: string | null;
}>;
type Harness = Readonly<{
  url: string;
  record: (
    result: UrlResult,
    detail: string | null,
    notify: Notifier | null,
  ) => Promise<RecordResult>;
  readState: () => Promise<StateSnapshot>;
}>;

function collectingNotifier(sent: string[], failure: Error | null = null): Notifier {
  return async (message: string): Promise<void> => {
    if (failure !== null) throw failure;
    sent.push(message);
  };
}

function firstMessage(sent: readonly string[]): string {
  const message = sent.at(0);
  assert.ok(message);
  return message;
}

async function withSnapshotDirectory(run: (harness: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "record-result-test-"));
  try {
    const url = `${TEST_URL_PREFIX}${randomUUID()}`;
    const directory = join(root, "snapshots", "example");
    const record = (
      result: UrlResult,
      detail: string | null,
      notify: Notifier | null,
    ): Promise<RecordResult> =>
      recordUrlResult(
        url,
        result,
        detail,
        notify,
        async (): Promise<string> => directory,
        (): JournalFailureContext => JOURNAL_CONTEXT,
      );
    const readState = async (): Promise<StateSnapshot> =>
      JSON.parse(await readFile(join(directory, STATE_FILENAME), "utf8"));
    await run({ url, record, readState });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("alerts after six failed checks, suppresses repeats, and resets silently", async (): Promise<void> => {
  await withSnapshotDirectory(async ({ url, record, readState }): Promise<void> => {
    const sent: string[] = [];
    const notify = collectingNotifier(sent);

    for (let failures = 1; failures < 6; failures += 1) {
      const result = await record("failure", `HTTP 50${failures}`, notify);
      assert.equal(result.consecutiveFailures, failures);
      assert.equal(result.notified, false);
    }
    assert.deepEqual(sent, []);

    const threshold = await record("failure", "HTTP 500 from origin", notify);
    assert.equal(threshold.consecutiveFailures, 6);
    assert.equal(threshold.notified, true);
    assert.equal(sent.length, 1);
    const thresholdMessage = firstMessage(sent);
    assert.ok(thresholdMessage.includes(url));
    assert.match(thresholdMessage, /6 consecutive page checks failed/);
    assert.match(thresholdMessage, /latest current-run journal entry/);

    await record("failure", "HTTP 503 from origin", notify);
    assert.equal(sent.length, 1);
    await record("success", null, notify);
    assert.equal(sent.length, 1);
    assert.deepEqual(await readState(), {
      consecutiveFailures: 0,
      alertSent: false,
      lastFailureReason: null,
    });

    for (let failures = 1; failures <= 6; failures += 1) {
      await record("failure", "second incident", notify);
    }
    assert.equal(sent.length, 2);
  });
});

test("persists an unsent threshold alert and retries it on the next failed check", async (): Promise<void> => {
  await withSnapshotDirectory(async ({ url, record, readState }): Promise<void> => {
    const sent: string[] = [];
    const notify = collectingNotifier(sent);
    for (let failures = 1; failures < 6; failures += 1) {
      await record("failure", "HTTP 500", notify);
    }

    await assert.rejects(record("failure", "telegram outage", collectingNotifier(sent, new Error("telegram down"))), /telegram down/);
    assert.deepEqual(await readState(), {
      consecutiveFailures: 6,
      alertSent: false,
      lastFailureReason: "telegram outage",
    });

    await record("failure", "retry failure", notify);
    assert.equal(sent.length, 1);
    const retryMessage = firstMessage(sent);
    assert.ok(retryMessage.includes(url));
    assert.match(retryMessage, /retry failure/);
    assert.equal((await readState()).alertSent, true);
  });
});

test("does not require Telegram configuration before the threshold", async (): Promise<void> => {
  await withSnapshotDirectory(async ({ record, readState }): Promise<void> => {
    const environmentNames = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const;
    const previous = environmentNames.map((name): string | undefined => process.env[name]);
    try {
      for (const name of environmentNames) delete process.env[name];
      await record("success", null, null);
      await record("failure", "HTTP 500", null);
      assert.deepEqual(await readState(), {
        consecutiveFailures: 1,
        alertSent: false,
        lastFailureReason: "HTTP 500",
      });
    } finally {
      environmentNames.forEach((name, index): void => {
        const value = previous[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });
});

test("uses the current service invocation rather than OnFailure metadata for the journal", (): void => {
  const invocations: string[] = [];
  const journalctl = ((_: string, arguments_: readonly string[]) => {
    invocations.push(arguments_.join("\n"));
    return { error: undefined, status: 0, stderr: "", stdout: "current run journal" };
  }) as unknown as typeof spawnSync;

  const context = retrieveCurrentJournalContext({
    INVOCATION_ID: "current-invocation",
    MONITOR_INVOCATION_ID: "completed-invocation",
  }, journalctl);

  assert.equal(context.invocationId, "current-invocation");
  assert.match(invocations[0]!, /_SYSTEMD_INVOCATION_ID=current-invocation/);
  assert.doesNotMatch(invocations[0]!, /completed-invocation/);
});
