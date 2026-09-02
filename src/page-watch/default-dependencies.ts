import { runChangeJudge, runExtractorAgent } from "../integrations/agents.ts";
import { createTelegramNotifier } from "../integrations/telegram.ts";
import { capturePage } from "../snapshots/capture.ts";
import { htmlChanged, incrementHtmlChangeCount } from "../snapshots/change-tracking.ts";
import { collectExpiredSnapshots } from "../snapshots/collect.ts";
import { compareSnapshots } from "../snapshots/compare.ts";
import { extractSnapshot } from "../snapshots/extract.ts";
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
  return {
    pageState: {
      classify: getUrlState,
      recordResult: async (url, result): Promise<void> => {
        await recordUrlResult(url, result);
      },
    },
    snapshots: {
      capture: async (url) => HtmlSnapshotPathSchema.parse(await capturePage(url)),
      extract: async (snapshot) => CanonicalSnapshotPathSchema.parse(await extractSnapshot(snapshot)),
      compare: compareSnapshots,
      htmlChanged,
      incrementHtmlChangeCount,
      collectExpired: async (): Promise<void> => {
        await collectExpiredSnapshots();
      },
    },
    organizations: {
      read: async (snapshotDirectory) => {
        const name = await readOrganizationName(snapshotDirectory);
        return name === null ? null : OrganizationNameSchema.parse(name);
      },
    },
    extractorAgent: { run: runExtractorAgent },
    changeJudge: { run: runChangeJudge },
    notifier: {
      send: async (text: string): Promise<void> => {
        await createTelegramNotifier()(text);
      },
    },
  };
}
