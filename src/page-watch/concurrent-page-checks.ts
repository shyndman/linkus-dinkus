import { createHash } from "node:crypto";
import { errorDetail, logger, withSiteLogTag } from "../logger.ts";
import type { UrlWatchResult } from "./watch-urls.ts";

export const PAGE_CHECK_CONCURRENCY = 3;
const URL_LOG_TAG_LENGTH = 3;
const URL_LOG_TAG_RADIX = 26;
const LOWERCASE_A_CODE_POINT = 97;

export type UrlCheckInput = Readonly<{
  notificationTrigger: string;
  pageCount: number;
  pageNumber: number;
  url: string;
}>;
export type UrlCheckResult =
  | Readonly<{ state: "success"; result: UrlWatchResult }>
  | Readonly<{ state: "failure"; error: string; recordError: string | null }>;
export type UrlCheckRunner = (input: UrlCheckInput) => Promise<UrlCheckResult>;
type ConcurrentPageCheckInput = Readonly<{
  notificationTrigger: string;
  urls: readonly string[];
}>;

export function urlLogTag(url: string): string {
  const digest = createHash("sha256").update(url).digest();
  let value = digest.readUInt32BE(0) % (URL_LOG_TAG_RADIX ** URL_LOG_TAG_LENGTH);
  const letters = Array.from({ length: URL_LOG_TAG_LENGTH }, (): string => {
    const letter = String.fromCodePoint(LOWERCASE_A_CODE_POINT + (value % URL_LOG_TAG_RADIX));
    value = Math.floor(value / URL_LOG_TAG_RADIX);
    return letter;
  });
  return letters.reverse().join("");
}

async function runPageCheck(input: UrlCheckInput, checkRunner: UrlCheckRunner): Promise<UrlCheckResult> {
  const site = urlLogTag(input.url);
  try {
    return await withSiteLogTag(site, async (): Promise<UrlCheckResult> => checkRunner(input));
  } catch (error: unknown) {
    const detail = errorDetail(error);
    logger.error("page check failed outside its error boundary.", { site, error: detail });
    return { state: "failure", error: detail, recordError: null };
  }
}

export async function runConcurrentPageChecks(
  input: ConcurrentPageCheckInput,
  checkRunner: UrlCheckRunner,
): Promise<readonly UrlWatchResult[]> {
  const outcomes: Array<UrlCheckResult | undefined> = new Array(input.urls.length);
  let nextIndex = 0;
  async function runNext(): Promise<void> {
    while (nextIndex < input.urls.length) {
      const index = nextIndex;
      nextIndex += 1;
      const url = input.urls[index];
      if (url === undefined) throw new Error(`No URL exists at page index ${index}`);
      const checkInput: UrlCheckInput = {
        notificationTrigger: input.notificationTrigger,
        pageCount: input.urls.length,
        pageNumber: index + 1,
        url,
      };
      outcomes[index] = await runPageCheck(checkInput, checkRunner);
    }
  }
  const checkCount = Math.min(PAGE_CHECK_CONCURRENCY, input.urls.length);
  await Promise.all(Array.from({ length: checkCount }, runNext));

  const results: UrlWatchResult[] = [];
  const failures: string[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    const url = input.urls[index];
    if (url === undefined || outcome === undefined) throw new Error(`No page-check result exists at page index ${index}`);
    if (outcome.state === "success") {
      results.push(outcome.result);
    } else {
      failures.push(`${url}: ${outcome.error}`);
      if (outcome.recordError !== null) failures.push(`${url}: could not record failure: ${outcome.recordError}`);
    }
  }
  if (failures.length > 0) throw new Error(`URL watch failures:\n${failures.join("\n")}`);
  return results;
}
