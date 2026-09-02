import {
  lstat,
  readdir,
  readlink,
  unlink,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { APPLICATION_CONFIG } from "../config.ts";
import { logger } from "../logger.ts";
import { pathExists, PROJECT_ROOT } from "../runtime.ts";

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

async function collectPageSnapshots(
  pageDirectory: string,
  cutoffMilliseconds: number,
): Promise<SnapshotCollectionResult> {
  let deletedSnapshots = 0;
  for (const entry of await readdir(pageDirectory, { withFileTypes: true })) {
    const match = SNAPSHOT_FILE_PATTERN.exec(entry.name);
    if (match?.[1] === undefined || timestampMilliseconds(match[1]) > cutoffMilliseconds) continue;

    await unlink(join(pageDirectory, entry.name));
    deletedSnapshots += 1;
  }

  const referencedObjects = new Set<string>();
  for (const entry of await readdir(pageDirectory, { withFileTypes: true })) {
    if (!HTML_SNAPSHOT_PATTERN.test(entry.name)) continue;
    const snapshotPath = join(pageDirectory, entry.name);
    if (!(await lstat(snapshotPath)).isSymbolicLink()) continue;
    referencedObjects.add(basename(await readlink(snapshotPath)));
  }

  const objectDirectory = join(pageDirectory, "objects");
  let deletedObjects = 0;
  if (await pathExists(objectDirectory)) {
    for (const entry of await readdir(objectDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !HTML_OBJECT_PATTERN.test(entry.name) || referencedObjects.has(entry.name)) continue;
      await unlink(join(objectDirectory, entry.name));
      deletedObjects += 1;
    }
  }

  return { deletedSnapshots, deletedObjects };
}

export async function collectExpiredSnapshots(
  snapshotRoot: string = SNAPSHOT_ROOT,
  now: Date = new Date(),
): Promise<SnapshotCollectionResult> {
  if (!(await pathExists(snapshotRoot))) return { deletedSnapshots: 0, deletedObjects: 0 };

  const cutoffMilliseconds = now.getTime()
    - APPLICATION_CONFIG.snapshots.retentionDays * MILLISECONDS_PER_DAY;
  let deletedSnapshots = 0;
  let deletedObjects = 0;
  for (const entry of await readdir(snapshotRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const result = await collectPageSnapshots(join(snapshotRoot, entry.name), cutoffMilliseconds);
    deletedSnapshots += result.deletedSnapshots;
    deletedObjects += result.deletedObjects;
  }
  logger.info("collected expired snapshot data.", {
    retentionDays: APPLICATION_CONFIG.snapshots.retentionDays,
    deletedSnapshots,
    deletedObjects,
  });
  return { deletedSnapshots, deletedObjects };
}
