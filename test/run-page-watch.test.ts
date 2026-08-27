import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSystemdCalendarPrompt,
  parseSystemdCalendarResponse,
  readConfigurationAndWriteTimestamp,
  syncPollFrequency,
} from "../src/page-watch/run.ts";

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

test("parses systemd calendar expressions from the JSON response", (): void => {
  assert.deepEqual(
    parseSystemdCalendarResponse('{\"calendarExpressions\":[\"Mon..Fri *-*-* *:0/20:00\"]}'),
    ["Mon..Fri *-*-* *:0/20:00"],
  );
});

test("rejects Markdown before systemd timer installation", (): void => {
  assert.throws(
    (): readonly string[] => parseSystemdCalendarResponse('```json\n{\"calendarExpressions\":[\"hourly\"]}\n```'),
    /invalid JSON/,
  );
});
test("supplies complete systemd documentation and validation feedback", (): void => {
  const documentation = "SYSTEMD.TIME COMPLETE REFERENCE\nFinal reference line.";
  const prompt = buildSystemdCalendarPrompt(
    "business hours",
    "bad expression: Invalid argument",
    documentation,
  );

  assert.ok(prompt.includes(documentation));
  assert.match(prompt, /Validation error: bad expression: Invalid argument/);
  assert.match(prompt, /Schedule:\nbusiness hours$/);
});


test("does no schedule work when the spreadsheet text matches", (): void => {
  const calls: string[] = [];

  const changed = syncPollFrequency("every 15 minutes", {
    readCachedText: (): string => "every 15 minutes",
    getCalendarExpressions: (): readonly string[] => {
      calls.push("ask");
      return ["*:0/15"];
    },
    validateCalendarExpressions: (): Readonly<{ state: "valid" }> => {
      calls.push("validate");
      return { state: "valid" };
    },
    installCalendarExpressions: (): void => {
      calls.push("install");
    },
    writeCachedText: (): void => {
      calls.push("write");
    },
  });

  assert.equal(changed, false);
  assert.deepEqual(calls, []);
});

test("caches changed text only after the systemd update succeeds", (): void => {
  const calls: string[] = [];

  const changed = syncPollFrequency("every 20 minutes", {
    readCachedText: (): string => "every 15 minutes",
    getCalendarExpressions: (text: string, validationError: string | null): readonly string[] => {
      calls.push(`ask:${text}:${validationError ?? "none"}`);
      return ["*:0/20"];
    },
    validateCalendarExpressions: (expressions: readonly string[]): Readonly<{ state: "valid" }> => {
      calls.push(`validate:${expressions.join("|")}`);
      return { state: "valid" };
    },
    installCalendarExpressions: (expressions: readonly string[]): void => {
      calls.push(`install:${expressions.join("|")}`);
    },
    writeCachedText: (text: string): void => {
      calls.push(`write:${text}`);
    },
  });

  assert.equal(changed, true);
  assert.deepEqual(calls, [
    "ask:every 20 minutes:none",
    "validate:*:0/20",
    "install:*:0/20",
    "write:every 20 minutes",
  ]);
});

test("does not cache changed text when the systemd update fails", (): void => {
  let wroteCache = false;

  assert.throws((): void => {
    syncPollFrequency("every hour", {
      readCachedText: (): string => "every 15 minutes",
      getCalendarExpressions: (): readonly string[] => ["hourly"],
      validateCalendarExpressions: (): Readonly<{ state: "valid" }> => ({ state: "valid" }),
      installCalendarExpressions: (): never => {
        throw new Error("systemd rejected the expression");
      },
      writeCachedText: (): void => {
        wroteCache = true;
      },
    });
  }, /systemd rejected the expression/);
  assert.equal(wroteCache, false);
});

test("asks the model to correct an invalid calendar expression", (): void => {
  const calls: string[] = [];

  const changed = syncPollFrequency("business hours", {
    readCachedText: (): string => "all day",
    getCalendarExpressions: (_text: string, validationError: string | null): readonly string[] => {
      calls.push(`ask:${validationError ?? "none"}`);
      return validationError === null ? ["bad expression"] : ["corrected expression"];
    },
    validateCalendarExpressions: (expressions: readonly string[]) => {
      const expression = expressions[0];
      calls.push(`validate:${expression}`);
      return expression === "bad expression"
        ? { state: "invalid" as const, detail: "Invalid argument" }
        : { state: "valid" as const };
    },
    installCalendarExpressions: (expressions: readonly string[]): void => {
      calls.push(`install:${expressions.join("|")}`);
    },
    writeCachedText: (text: string): void => {
      calls.push(`write:${text}`);
    },
  });

  assert.equal(changed, true);
  assert.deepEqual(calls, [
    "ask:none",
    "validate:bad expression",
    "ask:Invalid argument",
    "validate:corrected expression",
    "install:corrected expression",
    "write:business hours",
  ]);
});
