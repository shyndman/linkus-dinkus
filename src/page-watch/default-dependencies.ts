import { createBookmarkStore } from "../bookmarks/store.ts";
import { runChangeJudge, runExtractorAgent, runZeroJobInspection } from "../integrations/agents.ts";
import { createJobTelegramNotifier, createPageChangeTelegramNotifier } from "../integrations/telegram.ts";
import { capturePage } from "../snapshots/capture.ts";
import { extractorAuditDue, recordExtractorAudit } from "../snapshots/extractor-audit.ts";
import { collectExpiredSnapshots } from "../snapshots/collect.ts";
import { compareSnapshots } from "../snapshots/compare.ts";
import { discardSnapshotAttempt } from "../snapshots/discard-attempt.ts";
import { extractSnapshot, readSnapshotJobCount, readSnapshotJobs, recordSnapshotInspection } from "../snapshots/extract.ts";
import {
  CanonicalSnapshotPathSchema,
  HtmlSnapshotPathSchema,
  OrganizationNameSchema,
} from "./domain.ts";
import { readOrganizationName } from "./organization-name.ts";
import type { PageWatchDependencies } from "./ports.ts";
import { recordUrlResult } from "./record-result.ts";
import { getUrlState } from "./url-state.ts";

export function createDefaultPageWatchDependencies(): PageWatchDependencies {
  const bookmarks = createBookmarkStore();
  return {
    pageState: {
      classify: getUrlState,
      recordResult: async (url, result, detail): Promise<void> => {
        await recordUrlResult(url, result, detail);
      },
    },
    snapshots: {
      capture: async (url, renderSettleMs) => HtmlSnapshotPathSchema.parse(await capturePage(url, renderSettleMs)),
      extract: async (snapshot) => CanonicalSnapshotPathSchema.parse(await extractSnapshot(snapshot)),
      jobCount: readSnapshotJobCount,
      jobs: readSnapshotJobs,
      recordInspection: recordSnapshotInspection,
      compare: compareSnapshots,
      collectExpired: async (): Promise<void> => {
        await collectExpiredSnapshots();
      },
      discardAttempt: discardSnapshotAttempt,
    },
    extractorAudits: { isDue: extractorAuditDue, recordSuccess: recordExtractorAudit },
    organizations: {
      read: async (snapshotDirectory) => {
        const name = await readOrganizationName(snapshotDirectory);
        return name === null ? null : OrganizationNameSchema.parse(name);
      },
    },
    extractorAgent: { run: runExtractorAgent },
    changeJudge: { run: runChangeJudge },
    zeroJobInspector: { run: runZeroJobInspection },
    notifier: {
      send: async (text: string): Promise<void> => {
        await createPageChangeTelegramNotifier()(text);
      },
    },
    bookmarks,
    jobNotifier: { send: createJobTelegramNotifier(bookmarks) },
    retryClock: {
      wait: async (milliseconds: number): Promise<void> => {
        await new Promise<void>((resolveWait): void => {
          setTimeout(resolveWait, milliseconds);
        });
      },
    },
  };
}
