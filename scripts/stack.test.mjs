#!/usr/bin/env node
/** The stack script's pure helpers: nothing it prints may carry a secret. */
import test from "node:test";
import assert from "node:assert/strict";
import { redact, parseEnv } from "./stack.mjs";

test("stream keys and tokens never reach the terminal", () => {
  const line = "ffmpeg -f flv rtmps://live.twitch.tv/app/live_123456789_AbCdEf oauth:abc123xyz TWITCH_STREAM_KEY=live_999_zz";
  const out = redact(line);
  assert.doesNotMatch(out, /live_123456789|AbCdEf|abc123xyz|live_999_zz/);
  assert.match(out, /rtmps:\/\/live\.twitch\.tv\/app\/<redacted>/);
});

test(".env is read the way the studio reads it: no quoting, spaces kept", () => {
  const env = parseEnv("# comment\nSTREAM_TITLE=AI Plays RimWorld | 50-Colonist Challenge\nEMPTY=\nKEY = value \n");
  assert.equal(env.STREAM_TITLE, "AI Plays RimWorld | 50-Colonist Challenge");
  assert.equal(env.KEY, "value");
  assert.equal(env.EMPTY, "");
});
