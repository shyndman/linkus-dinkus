export type ApplicationConfig = Readonly<{
  agents: Readonly<{
    model: "openrouter/z-ai/glm-5.3-flash";
    extractorMaxTimeSeconds: string;
    judgeMaxTimeSeconds: string;
    scheduleMaxTimeSeconds: string;
  }>;
  googleSheets: Readonly<{
    spreadsheetId: string;
    notificationTriggerRange: string;
    pollFrequencyRange: string;
    urlsRange: string;
    lastCheckDateTimeRange: string;
  }>;
  pageChecks: Readonly<{
    concurrency: number;
    extractorAuditInterval: number;
    attemptCount: number;
    retryDelayMs: number;
  }>;
  snapshots: Readonly<{
    retentionDays: number;
    renderSettleMs: number;
    retryRenderSettleMs: number;
  }>;
  systemd: Readonly<{
    timerUnitName: string;
    serviceUnitName: string;
  }>;
}>;

export const APPLICATION_CONFIG = {
  agents: {
    model: "openrouter/z-ai/glm-5.3-flash",
    extractorMaxTimeSeconds: "900",
    judgeMaxTimeSeconds: "900",
    scheduleMaxTimeSeconds: "60",
  },
  googleSheets: {
    spreadsheetId: "1885pAekZfP__9yGRXhCJU5_N8jAzoXUi6IyHaPf149E",
    notificationTriggerRange: "notificationTrigger",
    pollFrequencyRange: "pollFrequency",
    urlsRange: "urls",
    lastCheckDateTimeRange: "lastCheckDateTime",
  },
  pageChecks: {
    extractorAuditInterval: 5,
    concurrency: 6,
    attemptCount: 3,
    retryDelayMs: 10_000,
  },
  snapshots: {
    retentionDays: 7,
    renderSettleMs: 6_000,
    retryRenderSettleMs: 25_000,
  },
  systemd: {
    timerUnitName: "linkus-dinkus.timer",
    serviceUnitName: "linkus-dinkus.service",
  },
} as const satisfies ApplicationConfig;
