import assert from "node:assert/strict";
import test from "node:test";
import { buildFailureNotificationText, splitFailureNotification, type JournalFailureContext } from "../src/systemd/journal.ts";

const failure: JournalFailureContext = {
  unit: "linkus-dinkus.service",
  invocationId: "failed-run",
  serviceResult: "exit-code",
  exitCode: "exited",
  exitStatus: "1",
  log: "application stopped error: [\n  {\n    \"message\": \"Invalid URL\"\n  }\n]",
  retrievalError: null,
};

test("includes the multiline application error rather than only its opening line", () => {
  const message = buildFailureNotificationText(failure);
  assert.ok(message.includes(failure.log));
  assert.match(message, /exit-code/);
  assert.match(message, /Exit status: 1/);
});

test("retains timeout metadata when journal access fails", () => {
  const message = buildFailureNotificationText({
    ...failure, serviceResult: "timeout", exitCode: "killed", exitStatus: "TERM",
    log: "", retrievalError: "Permission denied",
  });
  assert.match(message, /timeout/);
  assert.match(message, /TERM/);
  assert.match(message, /Permission denied/);
  assert.match(message, /failed-run/);
});

test("splits long details without dropping text or splitting surrogate pairs", () => {
  const text = `${"a".repeat(3999)}\u{1f642}${failure.log}\n${"b".repeat(5000)}`;
  const messages = splitFailureNotification(text);
  assert.equal(messages.join(""), text);
  for (const message of messages) {
    assert.ok(message.length <= 4000);
    assert.equal(Buffer.from(message).toString("utf8"), message);
  }
});
