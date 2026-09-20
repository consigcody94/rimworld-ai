/**
 * Hardware-Accelerated FFmpeg Streaming Engine
 *
 * Pipeline
 *   capture-window (ScreenCaptureKit)
 *     fd 1 -> raw BGRA 1920x1080 @ 30 fps  -> ffmpeg pipe:0
 *     fd 3 -> float32 PCM 48 kHz stereo    -> ffmpeg pipe:3   (system/desktop audio)
 *     fd 2 -> status lines                 -> forwarded to our stderr + parsed
 *
 * ScreenCaptureKit already scales and letterboxes onto a fixed 1920x1080 canvas,
 * so ffmpeg does no scale/pad work: it just encodes with h264_videotoolbox.
 *
 * There is deliberately no avfoundation input: the microphone is never opened.
 */

import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CAPTURE_BIN = fileURLToPath(new URL("./bin/capture-window", import.meta.url));

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;
const AUDIO_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = "160k";

// Twitch ingest ceiling for non-partners is ~6000 kbps video, and the keyframe
// interval must be 2 seconds.
const TWITCH_MAX_VIDEO_KBPS = 6000;
const KEYFRAME_SECONDS = 2;

/**
 * How long the capture source may stay lost before the broadcast is cut.
 *
 * ffmpeg keeps encoding whatever the capture pipe last gave it, so losing the game window does
 * not stop the RTMP push: it just turns the channel into dead air. On 2026-09-19 RimWorld exited
 * and the encoder kept pushing a frozen frame to Twitch for about an hour. A window can be lost
 * legitimately for a few seconds (fullscreen toggle, resize, space switch), so there is a grace
 * period rather than an immediate cut. Set STREAM_WINDOW_LOST_GRACE_MS=0 to disable the watchdog.
 */
const WINDOW_LOST_GRACE_MS = (() => {
  const raw = process.env.STREAM_WINDOW_LOST_GRACE_MS;
  if (raw == null || raw === "") return 120000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 120000;
})();

/** "6000k" | "6000" | 6000 -> 6000 (kbps). Returns null when unparseable. */
function parseKbps(value) {
  if (value == null) return null;
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  if (unit === "m") return Math.round(n * 1000);
  return Math.round(n); // bare numbers and "k" are both treated as kbps
}

const RESTART_DELAY_MS = 3000;
const MAX_RESTARTS = 5;

export class StreamEngine {
  constructor(options = {}) {
    this.streamKey = options.streamKey ?? "";
    this.ingestServer = options.ingestServer ?? "rtmp://live.twitch.tv/app";
    // fps and bitrate are overridable by the caller, then by env, then default.
    // 30 is the default; 60 is supported (the gop follows fps automatically).
    this.fps = options.fps ?? (parseInt(process.env.STREAM_FPS ?? "", 10) || 30);
    // Default below the Twitch ceiling. On a busy machine a 6000k target is what pushes the
    // encoder under 1.0x speed, and anything under real time becomes permanent viewer lag.
    const DEFAULT_VIDEO_KBPS = 4500;
    const requestedKbps =
      parseKbps(options.bitrate) ?? parseKbps(process.env.STREAM_BITRATE) ?? DEFAULT_VIDEO_KBPS;
    if (requestedKbps > TWITCH_MAX_VIDEO_KBPS) {
      console.warn(
        `[StreamEngine] Requested ${requestedKbps} kbps exceeds the Twitch non-partner ceiling; clamping to ${TWITCH_MAX_VIDEO_KBPS} kbps.`
      );
    }
    this.videoKbps = Math.min(requestedKbps, TWITCH_MAX_VIDEO_KBPS);
    this.bitrate = `${this.videoKbps}k`;
    // A 2 second VBV buffer is what Twitch's ingest expects alongside maxrate.
    this.bufsize = `${this.videoKbps * 2}k`;
    this.audioBitrate = options.audioBitrate ?? AUDIO_BITRATE;
    this.resolution = options.resolution ?? `${CANVAS_WIDTH}x${CANVAS_HEIGHT}`;
    this.deviceIndex = options.deviceIndex ?? "3";

    this.captureChild = null;
    this.child = null;

    // Restart bookkeeping
    this.requested = false;      // true between start() and stop()
    this.stopping = false;       // true while stop() is tearing things down
    this.restartCount = 0;
    this.restartTimer = null;
    this.lastStartArgs = null;   // { key, testFile } so a restart can replay it
    this.windowLostTimer = null; // watchdog: cuts the broadcast if the window never comes back

    this.stats = {
      running: false,
      fps: 0,
      bitrate: "0 kbits/s",
      speed: "0x",
      frames: 0,
      time: "00:00:00",
      startedAt: null,
      error: null,
      captureState: "idle", // "capturing" | "window-lost" | "idle"
      windowLostSince: null, // ms epoch the capture source went away, else null
      // Additive telemetry. Existing field names above are untouched because
      // server.mjs spreads this object straight into /api/stream/status.
      restartCount: 0,
      targetFps: this.fps,
      targetBitrate: this.bitrate,
      maxrate: this.bitrate,
      bufsize: this.bufsize,
      keyframeSeconds: KEYFRAME_SECONDS,
    };
    this.listeners = new Set();
  }

  onStats(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitStats() {
    for (const listener of this.listeners) {
      try {
        listener(this.stats);
      } catch {}
    }
  }

  /**
   * @param {string|null} customKey Twitch stream key (ignored when testFile is set)
   * @param {{testFile?: string}} [opts] write to a local .flv/.mp4 instead of RTMP
   */
  start(customKey = null, opts = {}) {
    if (this.child || this.captureChild) {
      throw new Error("Stream is already active.");
    }

    const testFile = opts.testFile ?? null;
    let key = null;
    if (!testFile) {
      key = customKey || this.streamKey;
      if (!key) {
        throw new Error("Missing Twitch Stream Key. Configure it in settings or .env.");
      }
    }

    this.requested = true;
    this.stopping = false;
    this.restartCount = 0;
    this.stats.restartCount = 0;
    this.lastStartArgs = { key: customKey, testFile };

    this.launch(key, testFile);
    return { ok: true, status: testFile ? "recording" : "broadcasting" };
  }

  /**
   * The full ffmpeg argument vector. Broken out so the exact list can be
   * inspected and validated without spawning a capture device.
   *
   * Quality notes (all options verified against `ffmpeg -h encoder=h264_videotoolbox`
   * on this machine; nothing here is passed speculatively):
   *   -profile:v high -level 4.2  High profile is what Twitch wants at 1080p.
   *   -coder cabac                CABAC over CAVLC: a real bitrate saving on fine
   *                               UI text, which is the whole point here.
   *   -allow_sw 1                 lets the encoder fall back to software rather
   *                               than dying if the VideoToolbox session is busy.
   *   -realtime 1                 required for live capture pacing.
   *   -g / -keyint_min            pinned to exactly KEYFRAME_SECONDS of frames so
   *                               keyframes land on a fixed 2 s cadence.
   *   bt709 + -color_range tv     correct color signalling for Twitch, and
   *                               -color_range tv also silences VideoToolbox's
   *                               "Color range not set" warning.
   *
   * @param {{width:number,height:number,outputFormat:string,target:string}} o
   * @returns {string[]}
   */
  buildFfmpegArgs({ width, height, outputFormat, target }) {
    const gop = Math.max(1, Math.round(this.fps * KEYFRAME_SECONDS));

    const args = [
      "-y",
      // ---- video input: raw BGRA from capture-window on stdin ----
      "-thread_queue_size", "512",
      "-f", "rawvideo",
      "-pixel_format", "bgra",
      "-video_size", `${width}x${height}`,
      "-framerate", String(this.fps),
      "-i", "pipe:0",
      // ---- audio input: system audio from ScreenCaptureKit, never the microphone ----
      "-thread_queue_size", "512",
      "-f", "f32le",
      "-ar", String(AUDIO_RATE),
      "-ac", String(AUDIO_CHANNELS),
      "-i", "pipe:3",
      // ---- video encode ----
      "-c:v", "h264_videotoolbox",
      "-realtime", "1",
      "-allow_sw", "1",
      "-profile:v", "high",
      "-level", "4.2",
      "-coder", "cabac",
      "-b:v", this.bitrate,
      "-maxrate", this.bitrate,
      "-bufsize", this.bufsize,
      "-g", String(gop),
      "-keyint_min", String(gop),
      "-r", String(this.fps),
      // ---- color: correct signalling for Twitch ----
      "-pix_fmt", "yuv420p",
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      "-colorspace", "bt709",
      "-color_range", "tv",
      // ---- audio encode ----
      "-c:a", "aac",
      "-b:a", this.audioBitrate,
      "-ar", String(AUDIO_RATE),
      "-ac", String(AUDIO_CHANNELS),
    ];

    if (outputFormat === "mp4") {
      args.push("-movflags", "+faststart");
    } else if (outputFormat === "flv") {
      // Valid on the flv muxer (encode side). Keeps the muxer from writing
      // bogus zero duration/filesize metadata into a live stream.
      args.push("-flvflags", "no_duration_filesize");
    }

    args.push("-f", outputFormat, target);
    return args;
  }

  /**
   * Ask the capture binary for its canvas size, once per process. It prints two compile-time
   * constants, and calling it synchronously on the /api/stream/start request path used to block
   * the event loop, and every other connection with it, for up to five seconds.
   */
  static canvasDims() {
    if (StreamEngine._dims) return StreamEngine._dims;
    let width = CANVAS_WIDTH;
    let height = CANVAS_HEIGHT;
    try {
      const out = execFileSync(CAPTURE_BIN, ["--dims"], { encoding: "utf8", timeout: 5000 }).trim();
      const [w, h] = out.split(/\s+/).map((n) => parseInt(n, 10));
      if (w > 200 && h > 200) { width = w; height = h; }
    } catch (e) {
      console.warn(`[StreamEngine] --dims failed, using ${width}x${height}: ${e.message}`);
    }
    StreamEngine._dims = { width, height };
    return StreamEngine._dims;
  }

  /** Spawns capture + ffmpeg. Used by start() and by the auto-restart path. */
  launch(key, testFile) {
    // Canvas geometry is fixed by the capture binary; --dims is the source of truth.
    const { width, height } = StreamEngine.canvasDims();

    console.log(
      `[StreamEngine] Output canvas: ${width}x${height} @ ${this.fps}fps, ` +
        `${this.bitrate} video (maxrate ${this.bitrate}, bufsize ${this.bufsize}), ` +
        `${KEYFRAME_SECONDS}s keyframes (ScreenCaptureKit scales + letterboxes)`
    );

    // 1. Native ScreenCaptureKit capture: fd1 = video, fd2 = status, fd3 = audio.
    //    fd2 is piped (not inherited) purely so captureState can be parsed; every
    //    chunk is forwarded verbatim to our own stderr, so it still behaves as if
    //    it were inherited.
    this.captureChild = spawn(CAPTURE_BIN, [], {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const audioPipe = this.captureChild.stdio[3];

    let target;
    let outputFormat;
    if (testFile) {
      target = path.resolve(testFile);
      outputFormat = target.toLowerCase().endsWith(".mp4") ? "mp4" : "flv";
      console.log(`[StreamEngine] TEST MODE: writing ${outputFormat} to ${target}`);
    } else {
      target = `${this.ingestServer}/${key}`;
      outputFormat = "flv";
    }

    // 2. FFmpeg: raw video on pipe:0, raw PCM on pipe:3, VideoToolbox H.264 + AAC.
    const args = this.buildFfmpegArgs({ width, height, outputFormat, target });

    // 3. Hand the capture process's own pipe ends to ffmpeg as its stdin and fd 3. At
    //    1920x1080x4 bytes x 30 fps that is roughly 248 MB/s, which must never be copied through
    //    the JS event loop: doing so starved the HTTP server that serves the overlay and made
    //    the encoder stutter. Passing the streams here makes the kernel move the bytes instead.
    if (!audioPipe) console.warn("[StreamEngine] Warning: audio pipe unavailable; stream will have no audio.");
    console.log(`[StreamEngine] Spawning FFmpeg (h264_videotoolbox + aac, no microphone input)...`);
    this.child = spawn("ffmpeg", args, {
      stdio: ["pipe", "pipe", "pipe", audioPipe ?? "ignore"],
    });
    this.captureChild.stdout.pipe(this.child.stdin);
    this.captureChild.stdout.on("error", () => {});
    this.child.stdin.on("error", () => {});

    this.stats.running = true;
    this.stats.startedAt = Date.now();
    this.stats.error = null;
    this.stats.captureState = "window-lost";
    this.emitStats();

    // 4. Capture status lines -> stats.captureState (and straight through to stderr).
    let captureBuf = "";
    this.captureChild.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      captureBuf += text;
      const lines = captureBuf.split("\n");
      captureBuf = lines.pop() ?? "";
      for (const line of lines) {
        this.parseCaptureStatus(line);
      }
    });

    // 5. FFmpeg progress lines -> stats.
    let stderrBuf = "";
    this.stats.lastFfmpegLines = [];
    this.child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 65536) stderrBuf = stderrBuf.slice(-16384);
      // ffmpeg writes its progress line with \r and everything else, including every real
      // error, with \n. The old parser only ever looked at \r segments, so a bad stream key or
      // a refused RTMP handshake surfaced as nothing but an exit code.
      const parts = stderrBuf.split(/(?<=[\r\n])/);
      stderrBuf = parts.pop() ?? "";
      for (const raw of parts) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith("frame=")) {
          this.parseFfmpegStats(line);
          continue;
        }
        this.stats.lastFfmpegLines.push(line);
        if (this.stats.lastFfmpegLines.length > 20) this.stats.lastFfmpegLines.shift();
        if (/error|failed|invalid|unable|denied|refused|unknown encoder|no such/i.test(line)) {
          console.error(`[ffmpeg] ${line}`);
        }
      }
    });

    this.child.on("close", (code) => {
      console.log(`[StreamEngine] FFmpeg process exited with code ${code}`);
      const wasRequested = this.requested && !this.stopping;
      this.teardown();
      if (wasRequested && code !== 0 && code !== null) {
        this.scheduleRestart(`ffmpeg exited with code ${code}`);
      } else if (!wasRequested) {
        this.requested = false;
      }
    });

    this.captureChild.on("close", (code) => {
      console.log(`[StreamEngine] Capture process exited with code ${code}`);
      // ffmpeg sees EOF on stdin and exits on its own; its close handler decides
      // whether to restart.
      if (this.child) {
        try { this.child.stdin.end(); } catch {}
      }
      this.captureChild = null;
    });

    this.child.on("error", (err) => {
      console.error("[StreamEngine] FFmpeg process error:", err);
      this.stats.error = err.message;
      this.emitStats();
    });

    this.captureChild.on("error", (err) => {
      console.error("[StreamEngine] Capture process error:", err);
      this.stats.error = err.message;
      this.emitStats();
    });
  }

  parseCaptureStatus(line) {
    if (!line) return;
    if (line.startsWith("READY") || line.startsWith("WINDOW REACQUIRED") || line.startsWith("WINDOW RESIZED")) {
      this.clearWindowLostWatchdog();
      if (this.stats.captureState !== "capturing") {
        this.stats.captureState = "capturing";
        this.emitStats();
      }
    } else if (line.startsWith("WINDOW LOST") || line.startsWith("VIDEO STREAM STOPPED")) {
      if (this.stats.captureState !== "window-lost") {
        this.stats.captureState = "window-lost";
        this.stats.windowLostSince = Date.now();
        this.emitStats();
      }
      this.armWindowLostWatchdog();
    }
  }

  /** Start the dead-air countdown. Idempotent: an already-running timer is left alone. */
  armWindowLostWatchdog() {
    if (WINDOW_LOST_GRACE_MS <= 0 || this.windowLostTimer || !this.requested) return;
    this.windowLostTimer = setTimeout(() => {
      this.windowLostTimer = null;
      if (this.stats.captureState !== "window-lost") return;
      const grace = WINDOW_LOST_GRACE_MS >= 1000 ? `${Math.round(WINDOW_LOST_GRACE_MS / 1000)}s` : `${WINDOW_LOST_GRACE_MS}ms`;
      const message = `capture source lost for ${grace}; stopping the broadcast rather than pushing dead air`;
      console.error(`[StreamEngine] ${message}`);
      this.stop();
      this.stats.error = message;
      this.emitStats();
    }, WINDOW_LOST_GRACE_MS);
    this.windowLostTimer.unref?.();
  }

  clearWindowLostWatchdog() {
    if (this.windowLostTimer) {
      clearTimeout(this.windowLostTimer);
      this.windowLostTimer = null;
    }
    this.stats.windowLostSince = null;
  }

  scheduleRestart(reason) {
    if (!this.requested) return;
    if (this.restartCount >= MAX_RESTARTS) {
      this.stats.error = `${reason}; giving up after ${MAX_RESTARTS} restart attempts`;
      this.requested = false;
      this.stats.captureState = "idle";
      this.emitStats();
      console.error(`[StreamEngine] ${this.stats.error}`);
      return;
    }
    this.restartCount += 1;
    this.stats.restartCount = this.restartCount;
    this.stats.error = `${reason}; restarting (attempt ${this.restartCount}/${MAX_RESTARTS}) in ${RESTART_DELAY_MS / 1000}s`;
    this.emitStats();
    console.error(`[StreamEngine] ${this.stats.error}`);

    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.requested || this.child || this.captureChild) return;
      const { key, testFile } = this.lastStartArgs ?? {};
      try {
        this.launch(testFile ? null : (key || this.streamKey), testFile ?? null);
      } catch (e) {
        this.stats.error = `restart failed: ${e.message}`;
        this.emitStats();
      }
    }, RESTART_DELAY_MS);
  }

  /** Kills whatever is left and resets the live half of stats. */
  teardown() {
    if (this.captureChild) {
      try { this.captureChild.kill("SIGINT"); } catch {}
      this.captureChild = null;
    }
    if (this.child) {
      try { this.child.kill("SIGINT"); } catch {}
      this.child = null;
    }
    this.stats.running = false;
    this.stats.startedAt = null;
    this.stats.captureState = "idle";
    this.emitStats();
  }

  /** A stream that has been healthy for a while has earned its restart budget back. */
  noteHealthy() {
    if (this.stats.running && this.restartCount > 0 && this.stats.startedAt && Date.now() - this.stats.startedAt > 300000) {
      this.restartCount = 0;
      this.stats.restartCount = 0;
    }
  }

  parseFfmpegStats(line) {
    const frameMatch = line.match(/frame=\s*(\d+)/);
    const fpsMatch = line.match(/fps=\s*([\d.]+)/);
    const timeMatch = line.match(/time=\s*([\d:.]+)/);
    const bitrateMatch = line.match(/bitrate=\s*([\d.]+kbits\/s)/);
    const speedMatch = line.match(/speed=\s*([\d.]+x)/);

    if (frameMatch) this.stats.frames = parseInt(frameMatch[1], 10);
    if (fpsMatch) this.stats.fps = parseFloat(fpsMatch[1]);
    if (timeMatch) this.stats.time = timeMatch[1];
    if (bitrateMatch) this.stats.bitrate = bitrateMatch[1];
    if (speedMatch) this.stats.speed = speedMatch[1];

    this.noteHealthy();
    this.emitStats();
  }

  stop() {
    this.requested = false;
    this.clearWindowLostWatchdog();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.child && !this.captureChild) {
      this.stats.running = false;
      this.stats.captureState = "idle";
      return { ok: true, status: "idle" };
    }

    console.log("[StreamEngine] Stopping broadcast gracefully...");
    this.stopping = true;

    // Closing the capture process first lets ffmpeg flush and finalize the file.
    const capture = this.captureChild;
    const ff = this.child;
    if (capture) {
      try { capture.kill("SIGINT"); } catch {}
    }
    if (ff) {
      try { ff.stdin.end(); } catch {}
      try { ff.kill("SIGINT"); } catch {}
    }

    setTimeout(() => {
      if (capture === this.captureChild && this.captureChild) {
        try { this.captureChild.kill("SIGKILL"); } catch {}
        this.captureChild = null;
      }
      if (ff === this.child && this.child) {
        try { this.child.kill("SIGKILL"); } catch {}
        this.child = null;
      }
      this.stats.running = false;
      this.stats.startedAt = null;
      this.stats.captureState = "idle";
      this.stopping = false;
      this.emitStats();
    }, 3000);

    return { ok: true, status: "stopping" };
  }
}
