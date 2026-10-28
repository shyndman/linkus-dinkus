import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import test from "node:test";
import { z } from "zod";
import { ExtractedJobSchema } from "../src/page-watch/jobs.ts";

type ExtractorCase = Readonly<{
  name: string;
  path: string;
  withJobsHtml: string;
  validEmptyHtml: string;
  missingStructureHtml: string;
  // Extra failure shape: the job block wrapper holds content the extractor
  // cannot read, which must not count as an empty job list.
  unrecognizedContentHtml?: string;
  expectedJobTitle: string;
  expectedLink: string | null;
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
    expectedLink: "https://apply.workable.com/veritree/j/1/",
  },
  {
    name: "BambooHR",
    path: "snapshots/https-bcinvasives-ca-about-careers/extract.ts",
    // Markup rendered by the BambooHR embed script (jobs/embed.js, version 1.0.0).
    withJobsHtml:
      '<html><body><div id="BambooHR" data-domain="bcinvasives.bamboohr.com">'
      + '<div class="BambooHR-ATS-board" data-version="1.0.0"><h2>Open Positions</h2>'
      + '<ul class="BambooHR-ATS-Department-List"><li class="BambooHR-ATS-Department-Item">'
      + '<div class="BambooHR-ATS-Department-Header">Field Team</div>'
      + '<ul class="BambooHR-ATS-Jobs-List"><li class="BambooHR-ATS-Jobs-Item">'
      + '<a href="https://bcinvasives.bamboohr.com/careers/123">Field Technician</a>'
      + '<span class="BambooHR-ATS-Location">Victoria, BC</span></li></ul></li></ul></div>'
      + '<div id="BambooHR-Footer">Powered by'
      + '<a href="http://www.bamboohr.com"><img alt="BambooHR - HR software"></a></div>'
      + "</div></body></html>",
    validEmptyHtml: '<html><body><div class="BambooHR-ATS-board"></div></body></html>',
    missingStructureHtml: "<html><body><main>careers</main></body></html>",
    expectedJobTitle: "Field Technician",
    expectedLink: "https://bcinvasives.bamboohr.com/careers/123",
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
    expectedLink: null,
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
    expectedLink: "https://cpawsbc.org/jobs/marine-coordinator",
  },
  {
    name: "BC Parks Foundation",
    path: "snapshots/https-bcparksfoundation-ca-careers/extract.ts",
    // The careers page renders one wrapper per content block: the intro copy
    // block, the full-width media block, and the job block.
    withJobsHtml:
      '<html><body><div class="main-module--root--a">'
      + '<div class="page-header-module--root--b"><h1>Careers</h1></div>'
      + '<div><div class="fc-copy-block-module--root--c"></div></div>'
      + '<div><div class="fc-full-width-media-module--root--d"></div></div>'
      + '<div><div class="fc-content-sections-module--root--e">'
      + '<div class="fc-content-sections-module--items--f">'
      + '<div class="item-content-section-module--root--g"><h3><span>Event Ambassador</span></h3>'
      + '<a href="https://bcparksfoundation.bamboohr.com/careers/147">View job posting</a>'
      + "</div></div></div></div>"
      + '<div class="cta-module--root--h"></div></div></body></html>',
    // The site keeps the empty job wrapper and renders no job section when it
    // holds no open positions.
    validEmptyHtml:
      '<html><body><div class="main-module--root--a">'
      + '<div class="page-header-module--root--b"><h1>Careers</h1></div>'
      + '<div><div class="fc-copy-block-module--root--c"></div></div>'
      + '<div><div class="fc-full-width-media-module--root--d"></div></div>'
      + "<div></div>"
      + '<div class="cta-module--root--h"></div></div></body></html>',
    // The job block wrapper is gone from the page layout.
    missingStructureHtml:
      '<html><body><div class="main-module--root--a">'
      + '<div class="page-header-module--root--b"><h1>Careers</h1></div>'
      + '<div><div class="fc-copy-block-module--root--c"></div></div>'
      + '<div><div class="fc-full-width-media-module--root--d"></div></div>'
      + '<div class="cta-module--root--h"></div></div></body></html>',
    // The job block wrapper holds a job list the extractor does not recognize.
    unrecognizedContentHtml:
      '<html><body><div class="main-module--root--a">'
      + '<div class="page-header-module--root--b"><h1>Careers</h1></div>'
      + '<div><div class="fc-copy-block-module--root--c"></div></div>'
      + '<div><div class="fc-full-width-media-module--root--d"></div></div>'
      + '<div><div class="fc-job-list-module--root--e"></div></div>'
      + '<div class="cta-module--root--h"></div></div></body></html>',
    expectedJobTitle: "Event Ambassador",
    expectedLink: "https://bcparksfoundation.bamboohr.com/careers/147",
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

const ExtractionSchema = z.strictObject({
  markdown: z.string(),
  jobCount: z.number().int().nonnegative(),
  jobs: z.array(ExtractedJobSchema),
});

for (const extractorCase of EXTRACTOR_CASES) {
  const skip = !existsSync(extractorCase.path);
  test(`${extractorCase.name} extractor counts extracted job rows`, { skip }, (): void => {
    const result = runExtractor(extractorCase.path, extractorCase.withJobsHtml);

    assert.equal(result.status, 0, result.stderr);
    const extraction = ExtractionSchema.parse(JSON.parse(result.stdout));
    assert.equal(extraction.jobCount, 1);
    assert.match(extraction.markdown, new RegExp(extractorCase.expectedJobTitle));
    assert.deepEqual(extraction.jobs, [{ title: extractorCase.expectedJobTitle, link: extractorCase.expectedLink }]);
  });

  test(`${extractorCase.name} extractor accepts a valid empty capture without site wording`, { skip }, (): void => {
    const result = runExtractor(extractorCase.path, extractorCase.validEmptyHtml);

    assert.equal(result.status, 0, result.stderr);
    const extraction = ExtractionSchema.parse(JSON.parse(result.stdout));
    assert.equal(extraction.jobCount, 0);
    assert.deepEqual(extraction.jobs, []);
  });

  test(`${extractorCase.name} extractor rejects a snapshot with the job structure missing`, { skip }, (): void => {
    const result = runExtractor(extractorCase.path, extractorCase.missingStructureHtml);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  });

  const unrecognizedContentHtml = extractorCase.unrecognizedContentHtml;
  if (unrecognizedContentHtml !== undefined) {
    test(`${extractorCase.name} extractor rejects unreadable job-block content`, { skip }, (): void => {
      const result = runExtractor(extractorCase.path, unrecognizedContentHtml);

      assert.notEqual(result.status, 0);
      assert.equal(result.stdout.trim(), "");
    });
  }
}
