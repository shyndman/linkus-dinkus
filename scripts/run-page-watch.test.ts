import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCronResponse,
  readConfigurationAndWriteTimestamp,
  syncPollFrequency,
} from "./run-page-watch.ts";

type ToolRequest = Readonly<{
  name: string;
  arguments: Readonly<Record<string, string>>;
}>;

function textResult(value: unknown): Readonly<{
  content: readonly Readonly<{ type: "text"; text: string }>[];
}> {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

test("reads all configuration before writing the timestamp", async (): Promise<void> => {
  const calls: ToolRequest[] = [];
  const client = {
    async callTool(request: ToolRequest): Promise<unknown> {
      calls.push(request);
      if (request.name === "write_cells") return textResult({ updated_cells: 1 });
      const rangeName = request.arguments.range_notation;
      if (rangeName === "notificationTrigger") return textResult([["new job"]]);
      if (rangeName === "pollFrequency") return textResult([["every 15 minutes"]]);
      if (rangeName === "urls") return textResult([["https://one.example"], ["https://two.example"]]);
      throw new Error(`Unexpected range: ${rangeName}`);
    },
  };

  const configuration = await readConfigurationAndWriteTimestamp(client);

  assert.deepEqual(configuration, {
    notificationTrigger: "new job",
    pollFrequency: "every 15 minutes",
    urls: ["https://one.example", "https://two.example"],
  });
  assert.deepEqual(calls.slice(0, 3).map((call: ToolRequest): string => call.name), [
    "read_cells",
    "read_cells",
    "read_cells",
  ]);
  assert.equal(calls[3]?.name, "write_cells");
  assert.equal(calls[3]?.arguments.range_notation, "lastCheckDateTime");
});

test("parses cron expressions from the JSON response", (): void => {
  assert.deepEqual(
    parseCronResponse('{"cronExpressions":["*/20 * * * 1-5"]}'),
    ["*/20 * * * 1-5"],
  );
});

test("rejects Markdown before cron installation", (): void => {
  assert.throws(
    (): readonly string[] => parseCronResponse('```json\n{"cronExpressions":["*/20 * * * 1-5"]}\n```'),
    /invalid JSON/,
  );
});

test("does no schedule work when the spreadsheet text matches", (): void => {
  const calls: string[] = [];

  const changed = syncPollFrequency("every 15 minutes", {
    readCachedText: (): string => "every 15 minutes",
    getCronExpressions: (): readonly string[] => {
      calls.push("ask");
      return ["*/15 * * * *"];
    },
    installCronExpressions: (): void => {
      calls.push("install");
    },
    writeCachedText: (): void => {
      calls.push("write");
    },
  });

  assert.equal(changed, false);
  assert.deepEqual(calls, []);
});

test("caches changed text only after the cron update succeeds", (): void => {
  const calls: string[] = [];

  const changed = syncPollFrequency("every 20 minutes", {
    readCachedText: (): string => "every 15 minutes",
    getCronExpressions: (text: string): readonly string[] => {
      calls.push(`ask:${text}`);
      return ["*/20 * * * *"];
    },
    installCronExpressions: (expressions: readonly string[]): void => {
      calls.push(`install:${expressions.join("|")}`);
    },
    writeCachedText: (text: string): void => {
      calls.push(`write:${text}`);
    },
  });

  assert.equal(changed, true);
  assert.deepEqual(calls, [
    "ask:every 20 minutes",
    "install:*/20 * * * *",
    "write:every 20 minutes",
  ]);
});

test("does not cache changed text when the cron update fails", (): void => {
  let wroteCache = false;

  assert.throws((): void => {
    syncPollFrequency("every hour", {
      readCachedText: (): string => "every 15 minutes",
      getCronExpressions: (): readonly string[] => ["0 * * * *"],
      installCronExpressions: (): never => {
        throw new Error("cron rejected the expression");
      },
      writeCachedText: (): void => {
        wroteCache = true;
      },
    });
  }, /cron rejected the expression/);
  assert.equal(wroteCache, false);
});
