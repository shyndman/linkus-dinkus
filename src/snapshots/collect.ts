import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { logger } from "../logger.ts";
import { PROJECT_ROOT } from "../runtime.ts";

const RETENTION_DAYS = 7;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const SNAPSHOT_FILE_PATTERN = /^snapshot-(\d{8}T\d{6}Z)(?:\.draft)?\.(?:html|md)$/;
const HTML_SNAPSHOT_PATTERN = /^snapshot-\d{8}T\d{6}Z\.html$/;
const HTML_OBJECT_PATTERN = /^[a-f0-9]{64}\.html$/;

export const SNAPSHOT_ROOT = resolve(PROJECT_ROOT, "snapshots");

export type SnapshotCollectionResult = Readonly<{
  deletedSnapshots: number;
  deletedObjects: number;
}>;

function timestampMilliseconds(timestamp: string): number {
  return Date.UTC(
    Number(timestamp.slice(0, 4)),
    Number(timestamp.slice(4, 6)) - 1,
    Number(timestamp.slice(6, 8)),
    Number(timestamp.slice(9, 11)),
    Number(timestamp.slice(11, 13)),
    Number(timestamp.slice(13, 15)),
  );
}

function collectPageSnapshots(pageDirectory: string, cutoffMilliseconds: number): SnapshotCollectionResult {
  let deletedSnapshots = 0;
  for (const entry of readdirSync(pageDirectory, { withFileTypes: true })) {
    const match = SNAPSHOT_FILE_PATTERN.exec(entry.name);
    if (match?.[1] === undefined || timestampMilliseconds(match[1]) > cutoffMilliseconds) continue;

    unlinkSync(join(pageDirectory, entry.name));
    deletedSnapshots += 1;
  }

  const referencedObjects = new Set<string>();
  for (const entry of readdirSync(pageDirectory, { withFileTypes: true })) {
    if (!HTML_SNAPSHOT_PATTERN.test(entry.name)) continue;
    const snapshotPath = join(pageDirectory, entry.name);
    if (!lstatSync(snapshotPath).isSymbolicLink()) continue;
    referencedObjects.add(basename(readlinkSync(snapshotPath)));
  }

  const objectDirectory = join(pageDirectory, "objects");
  let deletedObjects = 0;
  if (existsSync(objectDirectory)) {
    for (const entry of readdirSync(objectDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !HTML_OBJECT_PATTERN.test(entry.name) || referencedObjects.has(entry.name)) continue;
      unlinkSync(join(objectDirectory, entry.name));
      deletedObjects += 1;
    }
  }

  return { deletedSnapshots, deletedObjects };
}

export function collectExpiredSnapshots(
  snapshotRoot: string = SNAPSHOT_ROOT,
  now: Date = new Date(),
): SnapshotCollectionResult {
  if (!existsSync(snapshotRoot)) return { deletedSnapshots: 0, deletedObjects: 0 };

  const cutoffMilliseconds = now.getTime() - RETENTION_DAYS * MILLISECONDS_PER_DAY;
  let deletedSnapshots = 0;
  let deletedObjects = 0;
  for (const entry of readdirSync(snapshotRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const result = collectPageSnapshots(join(snapshotRoot, entry.name), cutoffMilliseconds);
    deletedSnapshots += result.deletedSnapshots;
    deletedObjects += result.deletedObjects;
  }
  logger.info("Collected expired snapshot data.", {
    retentionDays: RETENTION_DAYS,
    deletedSnapshots,
    deletedObjects,
  });
  return { deletedSnapshots, deletedObjects };
}
