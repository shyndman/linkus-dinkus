import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { APPLICATION_CONFIG } from "../config.ts";
import { errorDetail, logger } from "../logger.ts";
import { PROJECT_ROOT } from "../runtime.ts";

/** One-based row and column positions within the configured URL range. */
export type InvalidUrlCellOffset = Readonly<{ row: number; column: number }>;

type InvalidUrlCellStyler = (cells: readonly InvalidUrlCellOffset[]) => Promise<void>;
const executeFile = promisify(execFile);
const STYLE_INVALID_URLS_PATH = resolve(PROJECT_ROOT, "src/integrations/style-invalid-urls.py");
const UV_COMMAND = "uv";

export function createInvalidUrlCellStyler(command: string, args: readonly string[]): InvalidUrlCellStyler {
  const pythonCommand = command === UV_COMMAND ? command : resolve(PROJECT_ROOT, dirname(command), "python");
  const pythonArgs = command === UV_COMMAND ? [...args.slice(0, -1), "python"] : [];
  return async (cells): Promise<void> => {
    logger.info("marking invalid URL cells in the spreadsheet.", { cellCount: cells.length });
    try {
      const { stderr } = await executeFile(pythonCommand, [
        ...pythonArgs,
        STYLE_INVALID_URLS_PATH,
        APPLICATION_CONFIG.googleSheets.spreadsheetId,
        APPLICATION_CONFIG.googleSheets.urlsRange,
        JSON.stringify(cells),
      ], { cwd: PROJECT_ROOT });
      if (stderr.length > 0) process.stderr.write(stderr);
      logger.info("marked invalid URL cells in the spreadsheet.", { cellCount: cells.length });
    } catch (error: unknown) {
      logger.error("could not mark invalid URL cells in the spreadsheet.", { error: errorDetail(error) });
      throw error;
    }
  };
}
