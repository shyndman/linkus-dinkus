import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";

const BASE_URL = "https://bcinvasives.ca";
const EMPTY_STATE_TEXT = "We currently have no open positions.";
const EMPTY_RESULT_MARKDOWN = `# Job Openings\n\n${EMPTY_STATE_TEXT}\n`;

interface Job {
  title: string;
  link: string;
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
  const board = $(".BambooHR-ATS-board").first();
  if (board.length === 0) {
    console.error("extract: BambooHR job board not found in snapshot");
    process.exit(1);
  }

  // Direct job links in the BambooHR board. Exclude the "Powered by BambooHR"
  // footer link and any blank-state markup (which contains no anchors).
  const jobs: Job[] = [];
  board.find("a[href]").each((_index, element) => {
    const title = clean($(element).text());
    const href = $(element).attr("href") ?? "";
    if (!title) return;
    if (!/bamboohr\.com/i.test(href) && !/bamboohr\.com/i.test(title)) {
      const link = href ? new URL(href, BASE_URL).toString() : "";
      jobs.push({ title, link });
    }
  });

  if (jobs.length === 0) {
    const emptyStateText = clean(board.find(".BambooHR-ATS-blankState strong").first().text());
    if (emptyStateText !== EMPTY_STATE_TEXT) {
      console.error("extract: no job listings or explicit empty-state marker found in snapshot");
      process.exit(1);
    }
    process.stdout.write(EMPTY_RESULT_MARKDOWN);
    return;
  }

  const lines = jobs
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((job) => (job.link ? `- ${job.title}: ${job.link}` : `- ${job.title}`));

  process.stdout.write(`# Job Openings\n\n${lines.join("\n")}\n`);
}

try {
  main();
} catch (error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`extract: ${detail}`);
  process.exit(1);
}