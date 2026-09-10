import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import test from "node:test";

type ExtractorCase = Readonly<{
  name: string;
  path: string;
  withJobsHtml: string;
  validEmptyHtml: string;
  missingStructureHtml: string;
  expectedJobTitle: string;
}>;

const EXTRACTOR_CASES: readonly ExtractorCase[] = [
  {
    name: "Workable",
    path: "snapshots/https-apply-workable-com-veritree/extract.ts",
    withJobsHtml:
      '<html><body><ul data-ui="list"><li data-ui="job"><a href="/veritree/j/1/"></a>'
      + '<div><h3 data-ui="job-title"><span>Restoration Lead</span></h3></div></li></ul></body></html>',
    validEmptyHtml: '<html><body><ul data-ui="list"></ul></body></html>',
    missingStructureHtml: "<html><body><main>careers</main></body></html>",
    expectedJobTitle: "Restoration Lead",
  },
  {
    name: "BambooHR",
    path: "snapshots/https-bcinvasives-ca-about-careers/extract.ts",
    withJobsHtml:
      '<html><body><div class="BambooHR-ATS-board"><ul><li>'
      + '<a href="https://bcinvasives.ca/jobs/field-technician">Field Technician</a>'
      + "</li></ul></div></body></html>",
    validEmptyHtml: '<html><body><div class="BambooHR-ATS-board"></div></body></html>',
    missingStructureHtml: "<html><body><main>careers</main></body></html>",
    expectedJobTitle: "Field Technician",
  },
  {
    name: "ADP",
    path:
      "snapshots/https-workforcenow-adp-com-mascsr-default-mdf-recruitment-recruitment-html-cid-b0f3dbb9-c0c3-450e-b942-8ef0c3d60ac5-ccid-19000101-000001-lang-en-ca/extract.ts",
    withJobsHtml:
      '<html><body><h1 id="tileCurrentOpenings">Current Openings (1 of 1)</h1>'
      + '<div id="job_item_view_main_div_123_1"><sdf-link id="lblTitle_123">Payroll Specialist</sdf-link>'
      + '<div class="current-opening-locations">Vancouver, BC</div></div></body></html>',
    validEmptyHtml: '<html><body><h1 id="tileCurrentOpenings">Current Openings (0 of 0)</h1></body></html>',
    missingStructureHtml: "<html><body><main>Recruitment</main></body></html>",
    expectedJobTitle: "Payroll Specialist",
  },
  {
    name: "CPAWS",
    path: "snapshots/https-cpawsbc-org-about-us-career-opportunities/extract.ts",
    withJobsHtml:
      '<html><body><div class="acf-innerblocks-container"><p>Current Career Opportunities</p>'
      + '<a href="https://cpawsbc.org/jobs/marine-coordinator">Marine Coordinator</a></div></body></html>',
    validEmptyHtml:
      '<html><body><div class="acf-innerblocks-container"><p>Current Career Opportunities</p></div></body></html>',
    missingStructureHtml: "<html><body><main>about us</main></body></html>",
    expectedJobTitle: "Marine Coordinator",
  },
];

function runExtractor(extractorPath: string, html: string): SpawnSyncReturns<string> {
  const directory = mkdtempSync(join(tmpdir(), "page-watch-extractor-test-"));
  const snapshotPath = join(directory, "snapshot.html");
  try {
    writeFileSync(snapshotPath, html, "utf8");
    return spawnSync(process.execPath, ["--import", "tsx", extractorPath, snapshotPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function parseExtraction(stdout: string, detail: string): { markdown: string; jobCount: number } {
  const parsed: unknown = JSON.parse(stdout);
  assert.deepEqual(
    Object.keys(parsed as object).sort(),
    ["jobCount", "markdown"],
    `${detail}: unexpected extraction result keys`,
  );
  const result = parsed as { markdown: string; jobCount: number };
  assert.equal(typeof result.markdown, "string", `${detail}: markdown must be a string`);
  assert.equal(
    typeof result.jobCount,
    "number",
    `${detail}: jobCount must be a number`,
  );
  assert.ok(Number.isInteger(result.jobCount) && result.jobCount >= 0, `${detail}: jobCount must be a nonnegative integer`);
  return result;
}

for (const extractorCase of EXTRACTOR_CASES) {
  const skip = !existsSync(extractorCase.path);
  test(`${extractorCase.name} extractor counts extracted job rows`, { skip }, (): void => {
    const result = runExtractor(extractorCase.path, extractorCase.withJobsHtml);

    assert.equal(result.status, 0, result.stderr);
    const extraction = parseExtraction(result.stdout, extractorCase.name);
    assert.equal(extraction.jobCount, 1);
    assert.match(extraction.markdown, new RegExp(extractorCase.expectedJobTitle));
  });

  test(`${extractorCase.name} extractor accepts a valid empty capture without site wording`, { skip }, (): void => {
    const result = runExtractor(extractorCase.path, extractorCase.validEmptyHtml);

    assert.equal(result.status, 0, result.stderr);
    const extraction = parseExtraction(result.stdout, extractorCase.name);
    assert.equal(extraction.jobCount, 0);
  });

  test(`${extractorCase.name} extractor rejects a snapshot with the job structure missing`, { skip }, (): void => {
    const result = runExtractor(extractorCase.path, extractorCase.missingStructureHtml);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  });
}
