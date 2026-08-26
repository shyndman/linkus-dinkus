import { createInterface } from "node:readline";
import { fail } from "./lib.ts";

type JsonObject = Readonly<Record<string, unknown>>;
type Color = (text: string) => string;
type StreamState = {
  started: boolean;
  content: string;
};

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code: number): Color => (text: string): string => useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
const cyan = paint(36);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const dim = paint(2);
const MAX_DETAIL_CHARACTERS = 2_000;

const thinking: StreamState = { started: false, content: "" };
const text: StreamState = { started: false, content: "" };

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function truncate(value: string): string {
  if (value.length <= MAX_DETAIL_CHARACTERS) return value;
  const omitted = value.length - MAX_DETAIL_CHARACTERS;
  return `${value.slice(0, MAX_DETAIL_CHARACTERS)}\n${dim(`[${omitted} characters omitted]`)}`;
}

function argumentsObject(value: unknown): JsonObject | null {
  if (typeof value !== "string") return object(value);
  try {
    return object(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function selectedArguments(name: string, arguments_: JsonObject): JsonObject {
  if (name === "eval") {
    return { language: arguments_.language, code: arguments_.code };
  }
  if (name === "bash") {
    return { cwd: arguments_.cwd, command: arguments_.command };
  }
  if (name === "read") return { path: arguments_.path };
  if (name === "write") return { path: arguments_.path, content: arguments_.content };
  const { i: _intent, ...details } = arguments_;
  return details;
}

function printToolCall(toolCall: JsonObject): void {
  const name = string(toolCall.name) ?? "unknown tool";
  const arguments_ = argumentsObject(toolCall.arguments);
  const intent = string(toolCall.intent)
    ?? (arguments_ === null ? null : string(arguments_.i) ?? string(arguments_.title));
  process.stdout.write(`${cyan("Tool")} ${name}${intent === null ? "" : ` — ${intent}`}\n`);
  if (arguments_ === null) return;
  const details = JSON.stringify(selectedArguments(name, arguments_), null, 2);
  process.stdout.write(`${dim("Details")}\n${truncate(details)}\n`);
}


function printBlock(label: string, body: string, color: Color): void {
  const content = body.trim();
  if (content.length === 0) return;
  process.stdout.write(`${color(label)}\n${content}\n\n`);
}
function writeDelta(state: StreamState, label: string, delta: string, color: Color): void {
  if (delta.length === 0) return;
  if (!state.started) {
    process.stdout.write(`${color(label)}\n`);
    state.started = true;
  }
  state.content += delta;
  process.stdout.write(delta);
}

function finishStream(state: StreamState, label: string, complete: string | null, color: Color): void {
  if (state.started) {
    process.stdout.write("\n\n");
  } else {
    printBlock(label, complete ?? state.content, color);
  }
  state.started = false;
  state.content = "";
}


function contentText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((item: unknown): string[] => {
    const entry = object(item);
    const itemText = entry === null ? null : string(entry.text);
    return itemText === null ? [] : [itemText];
  });
  return parts.length === 0 ? null : parts.join("\n");
}

function toolResult(event: JsonObject): Readonly<{ output: string | null; failed: boolean }> {
  const result = object(event.result);
  if (result === null) return { output: null, failed: false };
  const output = contentText(result.content);
  const failed = result.isError === true || output?.startsWith("Error:") === true;
  return { output, failed };
}


function handleMessageUpdate(event: JsonObject): void {
  const update = object(event.assistantMessageEvent);
  if (update === null) return;
  const updateType = string(update.type);
  if (updateType === "thinking_delta") {
    writeDelta(thinking, "Thinking", string(update.delta) ?? "", dim);
  }
  if (updateType === "text_delta") {
    writeDelta(text, "Assistant", string(update.delta) ?? "", green);
  }
  if (updateType === "thinking_end") {
    finishStream(thinking, "Thinking", string(update.content), dim);
  }
  if (updateType === "text_end") {
    finishStream(text, "Assistant", string(update.content), green);
  }
  if (updateType === "toolcall_end") {
    const toolCall = object(update.toolCall);
    if (toolCall !== null) printToolCall(toolCall);
  }
}

function handleEvent(value: unknown): void {
  const event = object(value);
  if (event === null) return;
  const eventType = string(event.type);
  if (eventType === "message_update") handleMessageUpdate(event);
  if (eventType === "tool_execution_end") {
    const result = toolResult(event);
    process.stdout.write(`${result.failed ? red("Failed") : green("Done")}\n`);
    if (result.output !== null) {
      process.stdout.write(`${dim("Result")}\n${truncate(result.output.trim())}\n`);
    }
    process.stdout.write("\n");
  }
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      handleEvent(JSON.parse(line) as unknown);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(yellow(`Could not read an OMP event: ${detail}`));
      process.exitCode = 1;
    }
  }
  if (thinking.started) finishStream(thinking, "Thinking", null, dim);
  if (text.started) finishStream(text, "Assistant", null, green);
}

main().catch(fail);
