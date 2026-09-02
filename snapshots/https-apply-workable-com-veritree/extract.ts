import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";

const BASE_URL = "https://apply.workable.com";
const EMPTY_STATE_TEXT = "Sorry, no job openings at the moment.";
const EMPTY_RESULT_MARKDOWN = "# Job Openings\n\nWe currently have no open positions.\n";

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
  const jobs: Array<{ title: string; link: string }> = [];

  $('li[data-ui="job"]').each((_index, element) => {
    const title = clean($(element).find('[data-ui="job-title"] span').first().text());
    const href = $(element).find("a[href]").attr("href") ?? "";
    if (!title) return;
    const link = href
      ? new URL(href, BASE_URL).toString()
      : "";
    jobs.push({ title, link });
  });

  if (jobs.length === 0) {
    const hasExplicitEmptyState = $("p").toArray().some(
      (element): boolean => clean($(element).text()) === EMPTY_STATE_TEXT,
    );
    if (!hasExplicitEmptyState) {
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
