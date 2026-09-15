import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { collectExpiredSnapshots } from "../src/snapshots/collect.ts";
import { HtmlSnapshotPathSchema } from "../src/page-watch/domain.ts";
import { discardSnapshotAttempt } from "../src/snapshots/discard-attempt.ts";
import { storeHtmlSnapshot } from "../src/snapshots/capture.ts";
import { readSnapshotJobCount, recordSnapshotInspection } from "../src/snapshots/extract.ts";

const CURRENT_TIME = new Date("2026-08-27T12:00:00Z");
const OLD_TIME = new Date("2026-08-20T11:59:59Z");
const RECENT_TIME = new Date("2026-08-20T12:00:01Z");

function makeSnapshotRoot(): Readonly<{ root: string; page: string }> {
  const root = mkdtempSync(join(tmpdir(), "page-watch-snapshots-"));
  const page = join(root, "example-com");
  return { root, page };
}

test("stores duplicate HTML once and links each timestamp to its object", async (): Promise<void> => {
  const { root, page } = makeSnapshotRoot();
  try {
    const first = await storeHtmlSnapshot(page, "<html>same</html>", new Date("2026-08-27T10:00:00Z"));
    const second = await storeHtmlSnapshot(page, "<html>same</html>", new Date("2026-08-27T11:00:00Z"));
    const objects = readdirSync(join(page, "objects"));

    assert.equal(objects.length, 1);
    assert.match(objects[0]!, /^[a-f0-9]{64}\.html$/);
    assert.equal(lstatSync(first).isSymbolicLink(), true);
    assert.equal(lstatSync(second).isSymbolicLink(), true);
    assert.equal(readlinkSync(first), join("objects", objects[0]!));
    assert.equal(readlinkSync(second), join("objects", objects[0]!));
    assert.equal(readFileSync(first, "utf8"), "<html>same</html>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discards files from a failed snapshot attempt", async (): Promise<void> => {
  const { root, page } = makeSnapshotRoot();
  try {
    const html = await storeHtmlSnapshot(page, "<html>failed</html>", CURRENT_TIME);
    const base = html.slice(0, -".html".length);
    const markdown = `${base}.md`;
    const draft = `${base}.draft.md`;
    writeFileSync(markdown, "failed\n", "utf8");
    writeFileSync(draft, "failed draft\n", "utf8");
    writeFileSync(`${base}.stats.json`, '{"jobCount":0}\n');
    await recordSnapshotInspection(markdown, 2, { state: "failure", text: "Incomplete capture" });

    await discardSnapshotAttempt(HtmlSnapshotPathSchema.parse(html));

    assert.equal(existsSync(html), false);
    assert.equal(existsSync(markdown), false);
    assert.equal(existsSync(draft), false);
    assert.equal(existsSync(`${base}.stats.json`), false);
    assert.equal(existsSync(`${base}.inspection.json`), false);
    assert.equal(readdirSync(join(page, "objects")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deletes seven-day snapshots and their unreferenced HTML objects", async (): Promise<void> => {
  const { root, page } = makeSnapshotRoot();
  try {
    const oldHtml = await storeHtmlSnapshot(page, "<html>old</html>", OLD_TIME);
    const recentHtml = await storeHtmlSnapshot(page, "<html>recent</html>", RECENT_TIME);
    const oldBase = oldHtml.slice(0, -".html".length);
    const recentBase = recentHtml.slice(0, -".html".length);
    writeFileSync(`${oldBase}.md`, "old\n", "utf8");
    writeFileSync(`${oldBase}.draft.md`, "old draft\n", "utf8");
    writeFileSync(`${recentBase}.md`, "recent\n", "utf8");
    writeFileSync(`${oldBase}.stats.json`, '{"jobCount":0}\n');
    await recordSnapshotInspection(`${oldBase}.md`, 2, { state: "matched", text: "Empty section" });

    const oldObject = basename(readlinkSync(oldHtml));
    const recentObject = basename(readlinkSync(recentHtml));
    const result = await collectExpiredSnapshots(root, CURRENT_TIME);

    assert.deepEqual(result, { deletedSnapshots: 5, deletedObjects: 1 });
    assert.deepEqual(
      readdirSync(page).filter((name: string): boolean => name.startsWith("snapshot-")),
      [basename(recentHtml), basename(`${recentBase}.md`)],
    );
    assert.deepEqual(readdirSync(join(page, "objects")), [recentObject]);
    assert.notEqual(oldObject, recentObject);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains the last accepted snapshot beyond the retention window", async () => {
  const { root, page } = makeSnapshotRoot();
  try {
    const html = await storeHtmlSnapshot(page, "<html>accepted</html>", OLD_TIME);
    const base = html.slice(0, -".html".length);
    writeFileSync(`${base}.md`, "Accepted jobs\n");
    writeFileSync(`${base}.stats.json`, '{"jobCount":2}\n');
    await recordSnapshotInspection(`${base}.md`, 3, { state: "matched", text: "Complete capture" });
    await collectExpiredSnapshots(root, CURRENT_TIME);
    assert.equal(readFileSync(html, "utf8"), "<html>accepted</html>");
    assert.equal(readFileSync(`${base}.md`, "utf8"), "Accepted jobs\n");
    assert.equal(await readSnapshotJobCount(`${base}.md`), 2);
    assert.equal(existsSync(`${base}.inspection.json`), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derives and saves a legacy zero count without replacing accepted Markdown", async () => {
  const { root, page } = makeSnapshotRoot();
  try {
    const html = await storeHtmlSnapshot(page, "<html>empty</html>", OLD_TIME);
    const markdown = html.replace(".html", ".md");
    const extractor = join(page, "extract");
    writeFileSync(markdown, "Previously accepted Markdown\n");
    writeFileSync(extractor, "#!/bin/sh\nprintf '%s\\n' '{\"markdown\":\"different output\",\"jobCount\":0,\"jobs\":[]}'\n", { mode: 0o755 });
    assert.equal(await readSnapshotJobCount(markdown), 0);
    rmSync(extractor);
    assert.equal(await readSnapshotJobCount(markdown), 0);
    assert.equal(readFileSync(markdown, "utf8"), "Previously accepted Markdown\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
