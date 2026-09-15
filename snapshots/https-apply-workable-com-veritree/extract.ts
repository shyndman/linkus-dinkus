import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";

const BASE_URL = "https://apply.workable.com";
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
  const list = $('ul[data-ui="list"]').first();
  if (list.length === 0) {
    console.error("extract: job list (ul[data-ui=list]) not found in snapshot");
    process.exit(1);
  }

  const jobs: Array<{ title: string; link: string | null }> = [];
  list.find('li[data-ui="job"]').each((_index, element) => {
    const title = clean($(element).find('[data-ui="job-title"] span').first().text());
    const href = $(element).find("a[href]").attr("href") ?? "";
    if (!title) throw new Error("The job listing has no title.");
    const link = href ? new URL(href, BASE_URL).toString() : null;
    jobs.push({ title, link });
  });

  const markdown =
    jobs.length === 0
      ? EMPTY_RESULT_MARKDOWN
      : `# Job Openings\n\n${jobs
          .slice()
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((job) => (job.link ? `- ${job.title}: ${job.link}` : `- ${job.title}`))
          .join("\n")}\n`;
  process.stdout.write(`${JSON.stringify({ markdown, jobCount: jobs.length, jobs })}\n`);
}

try {
  main();
} catch (error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`extract: ${detail}`);
  process.exit(1);
}
