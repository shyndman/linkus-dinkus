import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import test from "node:test";

const EMPTY_RESULT_MARKDOWN = "# Job Openings\n\nWe currently have no open positions.\n";
const EMPTY_STATE_FAILURE = /no job listings or explicit empty-state marker found/;

type ExtractorCase = Readonly<{
  name: string;
  path: string;
  explicitEmptyHtml: string;
  ambiguousEmptyHtml: string;
}>;

const EXTRACTOR_CASES: readonly ExtractorCase[] = [
  {
    name: "Workable",
    path: "snapshots/https-apply-workable-com-veritree/extract.ts",
    explicitEmptyHtml: "<html><body><p>Sorry, no job openings at the moment.</p></body></html>",
    ambiguousEmptyHtml: "<html><body><ul data-ui=\"list\"></ul></body></html>",
  },
  {
    name: "BambooHR",
    path: "snapshots/https-bcinvasives-ca-about-careers/extract.ts",
    explicitEmptyHtml: "<html><body><div class=\"BambooHR-ATS-board\"><div class=\"BambooHR-ATS-blankState\"><strong>We currently have no open positions.</strong></div></div></body></html>",
    ambiguousEmptyHtml: "<html><body><div class=\"BambooHR-ATS-board\"></div></body></html>",
  },
  {
    name: "ADP",
    path: "snapshots/https-workforcenow-adp-com-mascsr-default-mdf-recruitment-recruitment-html-cid-b0f3dbb9-c0c3-450e-b942-8ef0c3d60ac5-ccid-19000101-000001-lang-en-ca/extract.ts",
    explicitEmptyHtml: "<html><body><h1 id=\"tileCurrentOpenings\">Current Openings (0 of 0)</h1></body></html>",
    ambiguousEmptyHtml: "<html><body><main>Recruitment</main></body></html>",
  },
];

function runExtractor(extractorPath: string, html: string): SpawnSyncReturns<string> {
  const directory = mkdtempSync(join(tmpdir(), "page-watch-extractor-test-"));
  const snapshotPath = join(directory, "snapshot.html");
  try {
    writeFileSync(snapshotPath, html, "utf8");
    return spawnSync("pnpm", ["exec", "tsx", extractorPath, snapshotPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const extractorCase of EXTRACTOR_CASES) {
  const skip = !existsSync(extractorCase.path);
  test(`${extractorCase.name} extractor accepts explicit empty-state evidence`, { skip }, (): void => {
    const result = runExtractor(extractorCase.path, extractorCase.explicitEmptyHtml);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, EMPTY_RESULT_MARKDOWN);
    assert.equal(result.stderr, "");
  });

  test(`${extractorCase.name} extractor rejects an ambiguous empty result`, { skip }, (): void => {
    const result = runExtractor(extractorCase.path, extractorCase.ambiguousEmptyHtml);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, EMPTY_STATE_FAILURE);
    assert.equal(result.stdout, "");
  });
}
