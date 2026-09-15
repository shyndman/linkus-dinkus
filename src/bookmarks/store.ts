import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { APPLICATION_CONFIG } from "../config.ts";
import { errorDetail, logger } from "../logger.ts";
import { ExtractedJobSchema, JobIdentitySchema, jobIdentityKey, type ExtractedJob, type JobIdentity } from "../page-watch/jobs.ts";
import { PROJECT_ROOT } from "../runtime.ts";

export type JobObservation = Readonly<{
  pageUrl: string;
  organizationName: string;
  jobs: readonly ExtractedJob[];
  extractionId: string;
}>;
export type BookmarkStore = Readonly<{
  initialize: () => Promise<void>;
  register: (job: JobIdentity) => Promise<string>;
  save: (token: string) => Promise<"saved" | "already-saved" | "unavailable">;
  observe: (observation: JobObservation) => Promise<void>;
  pendingRemovals: () => Promise<readonly Readonly<{ id: string; job: JobIdentity }>[]>;
  acknowledgeRemoval: (id: string) => Promise<void>;
}>;

const McpSchema = z.object({ mcpServers: z.object({ "google-sheets": z.object({
  command: z.string().min(1), args: z.array(z.string()),
}) }) });
const ObservationSchema = z.strictObject({
  pageUrl: z.url(), organizationName: z.string().trim().min(1),
  jobs: z.array(ExtractedJobSchema), extractionId: z.string().min(1),
});
const SaveResultSchema = z.enum(["saved", "already-saved", "unavailable"]);
const RemovalsSchema = z.array(z.strictObject({ id: z.string().min(1), job: JobIdentitySchema }));
const TokenSchema = z.string().regex(/^[a-f0-9]{40}$/);
const TOKEN_LENGTH = 40;
const executeFile = promisify(execFile);
const HELPER_PATH = resolve(PROJECT_ROOT, "src/bookmarks/store.py");
const STATE_DIRECTORY = resolve(PROJECT_ROOT, "snapshots/bookmarks");

type Command =
  | Readonly<{ action: "initialize" | "pending-removals" }>
  | Readonly<{ action: "register"; token: string; job: JobIdentity }>
  | Readonly<{ action: "save"; token: string }>
  | Readonly<{ action: "observe"; observation: JobObservation }>
  | Readonly<{ action: "acknowledge-removal"; id: string }>;

export function createBookmarkStore(): BookmarkStore {
  const config = McpSchema.parse(JSON.parse(readFileSync(resolve(PROJECT_ROOT, ".omp/mcp.json"), "utf8")));
  const { command, args } = config.mcpServers["google-sheets"];
  const python = command === "uv" ? command : resolve(PROJECT_ROOT, dirname(command), "python");
  const pythonArgs = command === "uv" ? [...args.slice(0, -1), "python"] : [];
  const call = async (request: Command): Promise<unknown> => {
    try {
      const { stdout, stderr } = await executeFile(python, [
        ...pythonArgs, HELPER_PATH, APPLICATION_CONFIG.googleSheets.spreadsheetId,
        STATE_DIRECTORY, JSON.stringify(request),
      ], { cwd: PROJECT_ROOT });
      if (stderr) process.stderr.write(stderr);
      return JSON.parse(stdout) as unknown;
    } catch (error: unknown) {
      logger.error("the bookmark operation failed.", { action: request.action, error: errorDetail(error) });
      throw error;
    }
  };
  return {
    initialize: async () => { await call({ action: "initialize" }); },
    register: async (input) => {
      const job = JobIdentitySchema.parse(input);
      const token = jobIdentityKey(job).slice(0, TOKEN_LENGTH);
      await call({ action: "register", token, job });
      return token;
    },
    save: async (token) => SaveResultSchema.parse(await call({ action: "save", token: TokenSchema.parse(token) })),
    observe: async (observation) => { await call({ action: "observe", observation: ObservationSchema.parse(observation) }); },
    pendingRemovals: async () => RemovalsSchema.parse(await call({ action: "pending-removals" })),
    acknowledgeRemoval: async (id) => { await call({ action: "acknowledge-removal", id }); },
  };
}
