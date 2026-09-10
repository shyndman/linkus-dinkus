import type { SnapshotComparison } from "../snapshots/compare.ts";
import type {
  CanonicalSnapshotPath,
  HtmlSnapshotPath,
  NotificationTrigger,
  OrganizationName,
  SnapshotDirectory,
  WatchedUrl,
} from "./domain.ts";
import type { JudgmentResult } from "./judgment.ts";
import type { UrlResult } from "./record-result.ts";
import type { UrlStateResult } from "./url-state.ts";

export type PageWatchConfiguration = Readonly<{
  notificationTrigger: NotificationTrigger;
  pollFrequency: string;
  urls: readonly WatchedUrl[];
}>;

export type ConfigurationSource = Readonly<{
  readAndRecordCheck: () => Promise<PageWatchConfiguration>;
}>;

export type ScriptAgentTask = Readonly<{
  url: WatchedUrl;
  snapshotDirectory: SnapshotDirectory;
  currentSnapshot: HtmlSnapshotPath;
}> & (
  | Readonly<{
    reason: "setup";
    notificationTrigger: NotificationTrigger;
    organizationNamePath: string;
  }>
  | Readonly<{
    reason: "fifth-html-change";
    notificationTrigger: NotificationTrigger;
  }>
  | Readonly<{
    reason: "organization-name";
    organizationNamePath: string;
  }>
);

export type JudgeAgentTask = Readonly<{
  url: WatchedUrl;
  notificationTrigger: NotificationTrigger;
  snapshotDirectory: SnapshotDirectory;
  currentSnapshot: HtmlSnapshotPath;
  organizationName: OrganizationName;
  comparison: Extract<SnapshotComparison, Readonly<{ state: "changed" }>>;
}>;

export type ZeroJobInspectionTask = Readonly<{
  url: WatchedUrl;
  snapshotDirectory: SnapshotDirectory;
  currentSnapshot: HtmlSnapshotPath;
  previousSnapshot: CanonicalSnapshotPath;
  previousJobCount: number;
  organizationName: OrganizationName;
}>;

export type PageStateStore = Readonly<{
  classify: (url: WatchedUrl) => Promise<UrlStateResult>;
  recordResult: (url: WatchedUrl, result: UrlResult, detail: string | null) => Promise<void>;
}>;

export type SnapshotStore = Readonly<{
  capture: (url: WatchedUrl, renderSettleMs: number) => Promise<HtmlSnapshotPath>;
  extract: (snapshot: HtmlSnapshotPath) => Promise<CanonicalSnapshotPath>;
  jobCount: (snapshot: CanonicalSnapshotPath) => Promise<number>;
  recordInspection: (snapshot: CanonicalSnapshotPath, previousJobCount: number, judgment: JudgmentResult) => Promise<void>;
  compare: (snapshotDirectory: SnapshotDirectory) => Promise<SnapshotComparison>;
  htmlChanged: (
    snapshotDirectory: SnapshotDirectory,
    currentSnapshot: HtmlSnapshotPath,
  ) => Promise<boolean>;
  incrementHtmlChangeCount: (snapshotDirectory: SnapshotDirectory) => Promise<number>;
  collectExpired: () => Promise<void>;
  discardAttempt: (snapshot: HtmlSnapshotPath) => Promise<void>;
  rollbackHtmlChangeCount: (snapshotDirectory: SnapshotDirectory) => Promise<void>;
}>;

export type OrganizationStore = Readonly<{
  read: (snapshotDirectory: SnapshotDirectory) => Promise<OrganizationName | null>;
}>;

export type ExtractorAgent = Readonly<{
  run: (task: ScriptAgentTask) => Promise<void>;
}>;

export type ChangeJudge = Readonly<{
  run: (task: JudgeAgentTask) => Promise<JudgmentResult>;
}>;

export type Notifier = Readonly<{
  send: (text: string) => Promise<void>;
}>;
export type RetryClock = Readonly<{
  wait: (milliseconds: number) => Promise<void>;
}>;


export type PageWatchDependencies = Readonly<{
  pageState: PageStateStore;
  snapshots: SnapshotStore;
  organizations: OrganizationStore;
  extractorAgent: ExtractorAgent;
  changeJudge: ChangeJudge;
  zeroJobInspector: Readonly<{
    run: (task: ZeroJobInspectionTask) => Promise<JudgmentResult>;
  }>;
  notifier: Notifier;
  retryClock: RetryClock;
}>;
