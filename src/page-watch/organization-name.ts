import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { errorDetail, logger } from "../logger.ts";
import { PROJECT_ROOT } from "../runtime.ts";

export const ORGANIZATION_NAME_FILE = "organization-name.txt";

export function organizationNamePath(snapshotDirectory: string): string {
  return join(snapshotDirectory, ORGANIZATION_NAME_FILE);
}

export async function readOrganizationName(snapshotDirectory: string): Promise<string | null> {
  const path = resolve(PROJECT_ROOT, organizationNamePath(snapshotDirectory));
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      logger.debug("no saved organization name exists.");
      return null;
    }
    logger.error("could not read the organization name.", { path, error: errorDetail(error) });
    throw error;
  }

  const name = content.trim();
  if (name.length === 0 || name.includes("\n")) {
    logger.error("the saved organization name is invalid.", { path });
    throw new Error(`${path} must contain one nonempty line`);
  }
  logger.debug("read the saved organization name.", { organizationName: name });
  return name;
}
