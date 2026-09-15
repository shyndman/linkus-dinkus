import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";

const EMPTY_RESULT_MARKDOWN = "# Job Openings\n\nWe currently have no open positions.\n";

interface Job {
  title: string;
  location: string;
  link: null;
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function main(): void {
  const snapshotPath = process.argv[2];
  if (!snapshotPath) {
    throw new Error("Usage: extract <snapshot.html>");
  }
  let html: string;
  try {
    html = readFileSync(snapshotPath, "utf8");
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`extract: cannot read snapshot: ${detail}`);
    process.exit(1);
  }

  const $ = cheerio.load(html);

  // Each job is rendered in a container whose id encodes the requisition id:
  // job_item_view_main_div_<requisitionId>_1
  const jobs: Job[] = [];
  $("div[id^='job_item_view_main_div_']").each((_index, element) => {
    const $card = $(element);
    const title = clean($card.find("sdf-link[id^='lblTitle_']").first().text());
    if (!title) throw new Error("The job listing has no title.");

    const location = clean($card.find(".current-opening-locations").text());

    // The sdf-link anchors use href="#" and no real job URL is present in the
    // snapshot, so no direct per-job link can be recovered from the DOM.
    const link = null;

    jobs.push({ title, location, link });
  });

  if (jobs.length === 0) {
    // The openings tile is part of the page shell on every load, so it gates
    // a zero count: without it the ADP application never loaded.
    const openingsCountText = clean($("#tileCurrentOpenings").first().text());
    if (openingsCountText.length === 0) {
      console.error("extract: ADP openings tile (#tileCurrentOpenings) not found in snapshot");
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify({ markdown: EMPTY_RESULT_MARKDOWN, jobCount: 0, jobs: [] })}\n`);
    return;
  }

  const lines = jobs
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((job) => {
      const suffix = job.location ? ` (${job.location})` : "";
      return job.link ? `- ${job.title}${suffix}: ${job.link}` : `- ${job.title}${suffix}`;
    });

  process.stdout.write(`${JSON.stringify({ markdown: `# Job Openings\n\n${lines.join("\n")}\n`, jobCount: jobs.length, jobs: jobs.map(({ title, link }) => ({ title, link })) })}\n`);
}

try {
  main();
} catch (error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`extract: ${detail}`);
  process.exit(1);
}
