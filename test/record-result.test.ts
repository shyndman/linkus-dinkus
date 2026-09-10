import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  recordUrlResult,
  type RecordResult,
  type UrlResult,
} from "../src/page-watch/record-result.ts";

const TEST_URL_PREFIX = "https://record-result.test/incident-";
const STATE_FILENAME = "failure-state.json";

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
  writeState: (state: object) => Promise<void>;
}>;

function collectingNotifier(
  sent: string[],
  failure: Error | null = null,
): Notifier {
  return async (message: string): Promise<void> => {
    if (failure !== null) throw failure;
    sent.push(message);
  };
}

async function withSnapshotDirectory(
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "record-result-test-"));
  try {
    const url = `${TEST_URL_PREFIX}${randomUUID()}`;
    const directory = join(root, "snapshots", "example");
    const record = (
      result: UrlResult,
      detail: string | null,
      notify: Notifier | null,
    ): Promise<RecordResult> =>
      recordUrlResult(url, result, detail, notify, async (): Promise<string> => directory);
    const readState = async (): Promise<StateSnapshot> =>
      JSON.parse(await readFile(join(directory, STATE_FILENAME), "utf8"));
    const writeState = async (state: object): Promise<void> => {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, STATE_FILENAME), `${JSON.stringify(state)}\n`, "utf8");
    };
    await run({ url, record, readState, writeState });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("alerts on the first failure, suppresses repeats, recovers once", async (): Promise<void> => {
  await withSnapshotDirectory(async ({ url, record, readState }): Promise<void> => {
    const sent: string[] = [];
    const notify = collectingNotifier(sent);

    const first = await record("failure", "HTTP 500 from origin", notify);
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.includes(url));
    assert.ok(sent[0]!.includes("HTTP 500 from origin"));
    assert.equal(first.notified, true);
    assert.equal(first.consecutiveFailures, 1);
    assert.deepEqual(await readState(), {
      consecutiveFailures: 1,
      alertSent: true,
      lastFailureReason: "HTTP 500 from origin",
    });

    const repeat = await record("failure", "HTTP 503 from origin", notify);
    assert.equal(sent.length, 1);
    assert.equal(repeat.notified, false);
    assert.equal(repeat.consecutiveFailures, 2);
    assert.equal((await readState()).lastFailureReason, "HTTP 503 from origin");

    const recovery = await record("success", null, notify);
    assert.equal(sent.length, 2);
    assert.ok(sent[1]!.includes(url));
    assert.match(sent[1]!, /recovery/);
    assert.equal(recovery.notified, true);
    assert.equal(recovery.consecutiveFailures, 0);
    assert.deepEqual(await readState(), {
      consecutiveFailures: 0,
      alertSent: false,
      lastFailureReason: null,
    });

    const repeatedSuccess = await record("success", null, notify);
    assert.equal(sent.length, 2);
    assert.equal(repeatedSuccess.notified, false);
  });
});

test("alerts when the CLI omits the detail and includes a fallback reason", async (): Promise<void> => {
  await withSnapshotDirectory(async ({ url, record, readState }): Promise<void> => {
    const sent: string[] = [];
    await record("failure", null, collectingNotifier(sent));
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.includes(url));
    assert.match(sent[0]!, /no failure detail/);
    assert.equal((await readState()).lastFailureReason, null);
  });
});

test("treats a legacy state without an alert field as no prior alert", async (): Promise<void> => {
  await withSnapshotDirectory(async ({ url, record, readState, writeState }): Promise<void> => {
    const sent: string[] = [];

    await record("failure", "first incident", collectingNotifier(sent));
    await writeState({ consecutiveFailures: 3 });

    await record("failure", "legacy state", collectingNotifier(sent));
    assert.equal(sent.length, 2);
    assert.ok(sent[1]!.includes(url));
    assert.ok(sent[1]!.includes("legacy state"));
    assert.deepEqual(await readState(), {
      consecutiveFailures: 4,
      alertSent: true,
      lastFailureReason: "legacy state",
    });
  });
});

test("does not mark the alert delivered when sending fails and retries later", async (): Promise<void> => {
  await withSnapshotDirectory(async ({ url, record, readState }): Promise<void> => {
    const sent: string[] = [];
    const failing = collectingNotifier(sent, new Error("telegram down"));

    await assert.rejects(record("failure", "HTTP 500", failing), /telegram down/);
    assert.equal(sent.length, 0);
    assert.deepEqual(await readState(), {
      consecutiveFailures: 1,
      alertSent: false,
      lastFailureReason: "HTTP 500",
    });

    await record("failure", "HTTP 500 again", collectingNotifier(sent));
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.includes(url));
    assert.ok(sent[0]!.includes("HTTP 500 again"));
    assert.equal((await readState()).alertSent, true);

    await assert.rejects(record("success", null, failing), /telegram down/);
    assert.equal((await readState()).alertSent, true);

    await record("success", null, collectingNotifier(sent));
    assert.equal(sent.length, 2);
    assert.match(sent[1]!, /recovery/);
    assert.equal((await readState()).alertSent, false);
  });
});

test("does not alert again on successes when no incident was alerted", async (): Promise<void> => {
  await withSnapshotDirectory(async ({ record, readState }): Promise<void> => {
    const sent: string[] = [];
    await record("success", null, collectingNotifier(sent));
    assert.deepEqual(sent, []);
    assert.equal((await readState()).alertSent, false);
  });
});

test("recording succeeds without Telegram configuration when nothing is sent", async (): Promise<void> => {
  await withSnapshotDirectory(async ({ record, readState }): Promise<void> => {
    const environmentNames = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const;
    const previous = environmentNames.map((name): string | undefined => process.env[name]);
    try {
      for (const name of environmentNames) delete process.env[name];

      const success = await record("success", null, null);
      assert.equal(success.notified, false);

      await assert.rejects(record("failure", "HTTP 500", null), /Missing required environment variable: TELEGRAM_/);
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
