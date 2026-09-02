import { z } from "zod";

export const WatchedUrlSchema = z.url().brand<"WatchedUrl">();
export type WatchedUrl = z.infer<typeof WatchedUrlSchema>;

export const NotificationTriggerSchema = z.string().min(1).brand<"NotificationTrigger">();
export type NotificationTrigger = z.infer<typeof NotificationTriggerSchema>;

export const SnapshotDirectorySchema = z.string().min(1).brand<"SnapshotDirectory">();
export type SnapshotDirectory = z.infer<typeof SnapshotDirectorySchema>;

export const HtmlSnapshotPathSchema = z.string().endsWith(".html").brand<"HtmlSnapshotPath">();
export type HtmlSnapshotPath = z.infer<typeof HtmlSnapshotPathSchema>;

export const CanonicalSnapshotPathSchema = z.string().endsWith(".md").brand<"CanonicalSnapshotPath">();
export type CanonicalSnapshotPath = z.infer<typeof CanonicalSnapshotPathSchema>;

export const OrganizationNameSchema = z.string()
  .transform((name: string): string => name.trim())
  .pipe(z.string().min(1).refine((name: string): boolean => !name.includes("\n")))
  .brand<"OrganizationName">();
export type OrganizationName = z.infer<typeof OrganizationNameSchema>;
