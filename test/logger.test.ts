import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { SITE_LOG_TAG_ENVIRONMENT_VARIABLE } from "../src/logger.ts";

const LOG_PROGRAM =
  'import("./src/logger.ts").then(({ logger }) => logger.info("checked https://example.com/jobs?token=secret.", { url: "https://example.com/jobs?location=Toronto#open" }))';
const COLORED_SITE_TAG =
  "\u001b[38;2;50;110;70m(\u001b[38;2;110;200;130mexample.com\u001b[38;2;50;110;70m)\u001b[0m";
const ELAPSED_TIME_DIGIT_COLOR = "\u001b[38;2;105;105;105m";
const FIELD_NAME_COLOR = "\u001b[38;2;140;140;140m";
const INFO_LEVEL =
  "\u001b[38;2;52;94;128m[\u001b[38;2;86;156;214minfo\u001b[38;2;52;94;128m]\u001b[0m";

test("formats the site tag and elides URL queries", (): void => {
  const result: SpawnSyncReturns<string> = spawnSync(
    process.execPath,
    ["--import", "tsx", "--eval", LOG_PROGRAM],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, [SITE_LOG_TAG_ENVIRONMENT_VARIABLE]: "example.com" },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.includes(COLORED_SITE_TAG));
  assert.ok(result.stderr.startsWith(ELAPSED_TIME_DIGIT_COLOR));
  assert.ok(result.stderr.includes(INFO_LEVEL));
  assert.ok(result.stderr.includes(`${FIELD_NAME_COLOR}url\u001b[0m:`));
  assert.match(
    stripVTControlCharacters(result.stderr),
    /^\d+:\d{2}\.\d{3} \[info\] \(example\.com\) checked https:\/\/example\.com\/jobs\?… url: https:\/\/example\.com\/jobs\?…\n$/,
  );
});
