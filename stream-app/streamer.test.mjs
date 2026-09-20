#!/usr/bin/env node
/**
 * Regression tests for the stream engine's dead-air watchdog.
 *
 * No ffmpeg and no capture binary are spawned: the tests drive parseCaptureStatus directly and
 * assert on whether the engine decided to cut the broadcast. Run with `node --test stream-app/`.
 */
process.env.STREAM_WINDOW_LOST_GRACE_MS = "60";   // must be set before the module is imported

import test from "node:test";
import assert from "node:assert/strict";
const { StreamEngine } = await import("./streamer.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An engine that believes it is broadcasting, with stop() recorded instead of performed. */
function liveEngine() {
  const e = new StreamEngine({ streamKey: "test" });
  e.requested = true;
  e.stats.running = true;
  e.stats.captureState = "capturing";
  e.stopped = 0;
  e.stop = () => { e.stopped += 1; e.requested = false; e.clearWindowLostWatchdog(); return { ok: true }; };
  return e;
}

test("a capture source that never comes back cuts the broadcast", async () => {
  // Regression: on 2026-09-19 RimWorld exited mid-stream and ffmpeg kept pushing a frozen frame
  // to Twitch for about an hour, because WINDOW LOST only set a status field.
  const e = liveEngine();
  e.parseCaptureStatus("WINDOW LOST");
  assert.equal(e.stats.captureState, "window-lost");
  assert.ok(e.stats.windowLostSince, "windowLostSince should be stamped");
  await sleep(150);
  assert.equal(e.stopped, 1, "the watchdog should have stopped the broadcast");
});

test("the capture binary's own stop line also arms the watchdog", async () => {
  const e = liveEngine();
  e.parseCaptureStatus("VIDEO STREAM STOPPED: Failed to find any displays or windows to capture");
  await sleep(150);
  assert.equal(e.stopped, 1);
});

test("a window that comes back within the grace period keeps the broadcast up", async () => {
  const e = liveEngine();
  e.parseCaptureStatus("WINDOW LOST");
  await sleep(20);
  e.parseCaptureStatus("WINDOW REACQUIRED id=1 pid=2 window=960x568");
  assert.equal(e.stats.captureState, "capturing");
  assert.equal(e.stats.windowLostSince, null);
  await sleep(150);
  assert.equal(e.stopped, 0, "a brief window loss must not end the stream");
});

test("repeated WINDOW LOST lines do not stack timers", async () => {
  const e = liveEngine();
  for (let i = 0; i < 5; i += 1) e.parseCaptureStatus("WINDOW LOST");
  await sleep(150);
  assert.equal(e.stopped, 1, "exactly one stop, not one per line");
});

test("an idle engine is never stopped by the watchdog", async () => {
  const e = liveEngine();
  e.requested = false;              // not broadcasting
  e.parseCaptureStatus("WINDOW LOST");
  await sleep(150);
  assert.equal(e.stopped, 0);
});
