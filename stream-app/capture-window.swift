//
// capture-window.swift
//
// ScreenCaptureKit capture engine for the RimWorld AI Twitch stream.
//
//   fd 1 (stdout) : raw BGRA video, fixed 1920x1080 canvas, 30 fps, never silent
//   fd 2 (stderr) : status lines (READY / WINDOW LOST / WINDOW REACQUIRED / ...)
//   fd 3          : interleaved float32 PCM system audio, 48 kHz stereo
//
// Design notes
//   * ScreenCaptureKit performs the scaling and the letterboxing (destinationRect
//     + black backgroundColor), so ffmpeg needs no scale/pad filter and the pipe
//     carries 1920x1080x30 instead of 2560x1440x60.
//   * Video leaves through a 30 Hz pump thread that always writes the most recent
//     frame (or black). SCK stops delivering frames when the screen is static and
//     delivers nothing at all when the window is gone; the pump keeps the RTMP
//     session fed either way, and caps any gap at ~33 ms.
//   * A 2 s monitor loop re-acquires the RimWorld window across restarts, pid
//     changes and resizes by tearing down and rebuilding the stream on the same
//     fixed canvas.
//   * System audio comes from a second SCStream on a display-level filter with
//     excludesCurrentProcessAudio, i.e. "desktop audio" (game + TTS via afplay).
//     The microphone is never opened.
//

import AppKit
import CoreMedia
import Foundation
import ScreenCaptureKit

// MARK: - Fixed output contract

let CANVAS_W = 1920
let CANVAS_H = 1080
let FPS: Int32 = 30
let FRAME_BYTES = CANVAS_W * CANVAS_H * 4
let VIDEO_FD: Int32 = 1
let AUDIO_FD: Int32 = 3
let AUDIO_SAMPLE_RATE = 48000
let AUDIO_CHANNELS = 2
let POLL_SECONDS: TimeInterval = 2.0

/// SCStreamConfiguration.backgroundColor is `assign` (unowned(unsafe)), so the
/// CGColor must outlive the configuration. Keep one for the whole process.
let BLACK = CGColor(red: 0, green: 0, blue: 0, alpha: 1)

// MARK: - Low level IO helpers

func logErr(_ s: String) {
    let bytes = Array((s + "\n").utf8)
    _ = bytes.withUnsafeBytes { raw in write(2, raw.baseAddress, raw.count) }
}

/// Result of a frame write: it either went out, was dropped to protect the clock, or the pipe died.
enum WriteOutcome { case ok, dropped, closed }

/// Is there room in the pipe right now? Used to decide whether to start a frame at all.
func pipeHasRoom(_ fd: Int32) -> Bool {
    var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
    let n = poll(&pfd, 1, 0)
    if n <= 0 { return false }
    return (pfd.revents & Int16(POLLOUT)) != 0
}

/// Write a whole frame, or none of it.
///
/// This is the difference between our pipeline and a stuttering one. Raw video carries no
/// timestamps, so ffmpeg derives presentation time from the frame count. If a slow encoder makes
/// the write block, the capture falls behind the wall clock, every later frame is stamped early,
/// and the RTMP session drifts behind real time by exactly the accumulated stall. Twitch buffers
/// that and the viewer sees lag that never catches up. OBS drops whole frames to hold the clock.
///
/// Partial frames are NOT an option: raw video has no framing, so half a frame desynchronises
/// the stream permanently ("packet size N < expected frame_size M"). So the decision to skip is
/// made BEFORE the first byte goes out, and once started the write always runs to completion.
func writeFrameOrDrop(_ fd: Int32, _ base: UnsafeRawPointer, _ count: Int) -> WriteOutcome {
    if !pipeHasRoom(fd) { return .dropped }
    var off = 0
    while off < count {
        let n = write(fd, base.advanced(by: off), count - off)
        if n > 0 { off += n; continue }
        if n < 0 {
            let e = errno
            if e == EINTR { continue }
            if e == EAGAIN || e == EWOULDBLOCK {
                // Committed to this frame now: wait for the reader rather than truncating it.
                var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                if poll(&pfd, 1, 2000) <= 0 { return .closed }
                continue
            }
            return .closed
        }
        return .closed
    }
    return .ok
}

/// write(2) until everything is out. Returns false once the far end is gone.
@discardableResult
func writeAll(_ fd: Int32, _ base: UnsafeRawPointer, _ count: Int) -> Bool {
    var off = 0
    while off < count {
        let n = write(fd, base.advanced(by: off), count - off)
        if n > 0 { off += n; continue }
        if n < 0 {
            let e = errno
            if e == EINTR { continue }
            if e == EAGAIN || e == EWOULDBLOCK { usleep(500); continue }
            return false
        }
        return false
    }
    return true
}

// MARK: - Video frame bus (double buffered, lock handoff)

final class FrameBus {
    private let lock = NSLock()
    private var front: UnsafeMutableRawPointer
    private var back: UnsafeMutableRawPointer
    private var dirty = false
    private(set) var framesWritten: UInt64 = 0
    private var droppedFrames: UInt64 = 0

    init() {
        front = UnsafeMutableRawPointer.allocate(byteCount: FRAME_BYTES, alignment: 64)
        back = UnsafeMutableRawPointer.allocate(byteCount: FRAME_BYTES, alignment: 64)
        FrameBus.fillBlack(front)
        FrameBus.fillBlack(back)
    }

    static func fillBlack(_ p: UnsafeMutableRawPointer) {
        let pattern: [UInt8] = [0, 0, 0, 255] // BGRA opaque black
        pattern.withUnsafeBytes { memset_pattern4(p, $0.baseAddress!, FRAME_BYTES) }
    }

    func blank() {
        lock.lock()
        FrameBus.fillBlack(back)
        dirty = true
        lock.unlock()
    }

    func submit(_ pb: CVPixelBuffer) {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let src = CVPixelBufferGetBaseAddress(pb) else { return }
        let w = CVPixelBufferGetWidth(pb)
        let h = CVPixelBufferGetHeight(pb)
        let srcStride = CVPixelBufferGetBytesPerRow(pb)
        let dstStride = CANVAS_W * 4
        let rowBytes = min(w, CANVAS_W) * 4
        let rows = min(h, CANVAS_H)

        lock.lock()
        if w != CANVAS_W || h != CANVAS_H { FrameBus.fillBlack(back) }
        if srcStride == dstStride && rowBytes == dstStride && rows == CANVAS_H {
            memcpy(back, src, FRAME_BYTES)
        } else {
            for row in 0..<rows {
                memcpy(back.advanced(by: row * dstStride),
                       src.advanced(by: row * srcStride),
                       rowBytes)
            }
        }
        dirty = true
        lock.unlock()
    }

    /// Called only from the pump thread. False means stdout is gone.
    func pump() -> Bool {
        lock.lock()
        if dirty {
            swap(&front, &back)
            dirty = false
        }
        let p = front
        lock.unlock()
        // A third of a frame interval is the whole budget: past that the encoder is behind and
        // holding this frame only makes the stream later.
        switch writeFrameOrDrop(VIDEO_FD, p, FRAME_BYTES) {
        case .ok:
            break
        case .dropped:
            droppedFrames += 1
            if droppedFrames % 30 == 1 {
                FileHandle.standardError.write("ENCODER BEHIND: dropped \(droppedFrames) frame(s) to hold real time\n".data(using: .utf8)!)
            }
        case .closed:
            return false
        }
        framesWritten += 1
        return true
    }
}

// MARK: - Audio bus (fd 3, interleaved float32)

final class AudioBus {
    private let lock = NSLock()
    private var scratch = [Float](repeating: 0, count: 16384)
    private var alive = true
    private(set) var bytesWritten: UInt64 = 0

    func submit(_ sb: CMSampleBuffer) {
        lock.lock()
        let ok = alive
        lock.unlock()
        guard ok else { return }

        let declared = sb.numSamples
        guard declared > 0 else { return }

        try? sb.withAudioBufferList { abl, _ in
            let bufs = Array(abl)
            guard let first = bufs.first, first.mData != nil else { return }

            let chInBuf = Int(max(1, first.mNumberChannels))
            let availPerChannel = Int(first.mDataByteSize) / 4 / chInBuf
            let n = min(declared, availPerChannel)
            guard n > 0 else { return }

            lock.lock()
            defer { lock.unlock() }

            let needed = n * AUDIO_CHANNELS
            if scratch.count < needed {
                scratch = [Float](repeating: 0, count: needed)
            }

            var filled = false
            scratch.withUnsafeMutableBufferPointer { out in
                if bufs.count >= 2,
                   let l = bufs[0].mData?.assumingMemoryBound(to: Float.self),
                   let r = bufs[1].mData?.assumingMemoryBound(to: Float.self) {
                    // SCK default: non-interleaved, one buffer per channel.
                    for i in 0..<n {
                        out[i * 2] = l[i]
                        out[i * 2 + 1] = r[i]
                    }
                    filled = true
                } else if let src = first.mData?.assumingMemoryBound(to: Float.self) {
                    if chInBuf >= 2 {
                        // already interleaved: take the first two channels
                        for i in 0..<n {
                            out[i * 2] = src[i * chInBuf]
                            out[i * 2 + 1] = src[i * chInBuf + 1]
                        }
                    } else {
                        // mono: duplicate to stereo
                        for i in 0..<n {
                            out[i * 2] = src[i]
                            out[i * 2 + 1] = src[i]
                        }
                    }
                    filled = true
                }
            }
            guard filled else { return }

            let byteCount = needed * 4
            let wrote = scratch.withUnsafeBytes { raw -> Bool in
                writeAll(AUDIO_FD, raw.baseAddress!, byteCount)
            }
            if wrote {
                bytesWritten += UInt64(byteCount)
            } else {
                alive = false
                logErr("AUDIO PIPE CLOSED (fd 3 unavailable, continuing video only)")
            }
        }
    }
}

// MARK: - Stream outputs

func sampleFrameStatus(_ sb: CMSampleBuffer) -> SCFrameStatus? {
    guard let raw = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]],
          let value = raw.first?[.status] as? Int,
          let status = SCFrameStatus(rawValue: value)
    else { return nil }
    return status
}

final class VideoSink: NSObject, SCStreamOutput {
    let bus: FrameBus
    init(bus: FrameBus) { self.bus = bus }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let pb = sb.imageBuffer else { return }
        if let status = sampleFrameStatus(sb), status != .complete { return }
        bus.submit(pb)
    }
}

final class AudioSink: NSObject, SCStreamOutput {
    let bus: AudioBus
    init(bus: AudioBus) { self.bus = bus }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        bus.submit(sb)
    }
}

/// The audio stream needs a screen output attached, but its frames are discarded.
final class DiscardSink: NSObject, SCStreamOutput {
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {}
}

// MARK: - Controller

struct WinInfo {
    let id: CGWindowID
    let pid: pid_t
    let frame: CGRect
    let window: SCWindow
}

final class Capture: NSObject, SCStreamDelegate {
    let bus = FrameBus()
    let audioBus = AudioBus()

    private let ctl = DispatchQueue(label: "capture.control")
    private let videoQueue = DispatchQueue(label: "capture.video", qos: .userInteractive)
    private let audioQueue = DispatchQueue(label: "capture.audio", qos: .userInitiated)

    private lazy var videoSink = VideoSink(bus: bus)
    private lazy var audioSink = AudioSink(bus: audioBus)
    private let discardSink = DiscardSink()

    // All of the following are touched only on `ctl`.
    private var videoStream: SCStream?
    private var audioStream: SCStream?
    private var curWindowID: CGWindowID = 0
    private var curPID: pid_t = 0
    private var curSize: CGSize = .zero
    private var announcedReady = false
    private var reportedLost = false

    // MARK: Discovery

    private func shareableContent() -> SCShareableContent? {
        let sem = DispatchSemaphore(value: 0)
        var out: SCShareableContent?
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
            if let error = error {
                logErr("ERROR SCShareableContent: \(error.localizedDescription)")
            }
            out = content
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 10.0)
        return out
    }

    private func findWindow(in content: SCShareableContent) -> WinInfo? {
        var candidates: [SCWindow] = []
        for win in content.windows {
            guard let app = win.owningApplication else { continue }
            let bundle = app.bundleIdentifier
            let name = app.applicationName
            let isRimWorld = bundle == "ludeon.rimworld"
                || (name.hasPrefix("RimWorld")
                    && !name.contains("Safari")
                    && !name.contains("Chrome")
                    && !name.contains("AutoFill"))
            if isRimWorld && win.frame.width > 200 && win.frame.height > 200 && win.windowLayer == 0 {
                candidates.append(win)
            }
        }
        // RimWorld owns several off-screen helper windows, some of which are
        // larger than the real game window (a hidden 500x500 one outranks the
        // 640x388 splash on area alone). Rank on-screen, titled windows first and
        // only then fall back to raw area.
        func rank(_ w: SCWindow) -> (Int, Int, CGFloat) {
            let onScreen = w.isOnScreen ? 1 : 0
            let titled = (w.title?.isEmpty == false) ? 1 : 0
            return (onScreen, titled, w.frame.width * w.frame.height)
        }
        candidates.sort { a, b in
            let ra = rank(a), rb = rank(b)
            if ra.0 != rb.0 { return ra.0 > rb.0 }
            if ra.1 != rb.1 { return ra.1 > rb.1 }
            return ra.2 > rb.2
        }
        guard let win = candidates.first, let app = win.owningApplication else { return nil }
        return WinInfo(id: win.windowID, pid: app.processID, frame: win.frame, window: win)
    }

    // MARK: Geometry

    /// Aspect-preserving destination rect centred on the fixed canvas, so a
    /// non-16:9 window is letterboxed against black instead of stretched.
    static func letterbox(srcW: CGFloat, srcH: CGFloat) -> CGRect {
        let cw = CGFloat(CANVAS_W)
        let ch = CGFloat(CANVAS_H)
        guard srcW > 0, srcH > 0 else { return CGRect(x: 0, y: 0, width: cw, height: ch) }
        let scale = min(cw / srcW, ch / srcH)
        var w = (srcW * scale).rounded(.down)
        var h = (srcH * scale).rounded(.down)
        w -= w.truncatingRemainder(dividingBy: 2)
        h -= h.truncatingRemainder(dividingBy: 2)
        let x = ((cw - w) / 2).rounded(.down)
        let y = ((ch - h) / 2).rounded(.down)
        return CGRect(x: x, y: y, width: w, height: h)
    }

    // MARK: Video stream lifecycle

    private func startVideo(_ info: WinInfo) -> Bool {
        let filter = SCContentFilter(desktopIndependentWindow: info.window)
        let cfg = SCStreamConfiguration()
        cfg.width = CANVAS_W
        cfg.height = CANVAS_H
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: FPS)
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.showsCursor = false
        cfg.queueDepth = 5
        cfg.scalesToFit = true
        cfg.preservesAspectRatio = true
        cfg.backgroundColor = BLACK
        cfg.destinationRect = Capture.letterbox(srcW: info.frame.width, srcH: info.frame.height)

        let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
        do {
            try stream.addStreamOutput(videoSink, type: .screen, sampleHandlerQueue: videoQueue)
        } catch {
            logErr("ERROR addStreamOutput(screen): \(error.localizedDescription)")
            return false
        }

        var ok = false
        let sem = DispatchSemaphore(value: 0)
        stream.startCapture { error in
            if let error = error {
                logErr("ERROR startCapture(video): \(error.localizedDescription)")
            } else {
                ok = true
            }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 10.0)
        guard ok else { return false }
        videoStream = stream
        return true
    }

    private func stopVideo() {
        guard let s = videoStream else { return }
        videoStream = nil
        let sem = DispatchSemaphore(value: 0)
        s.stopCapture { _ in sem.signal() }
        _ = sem.wait(timeout: .now() + 3.0)
    }

    // MARK: Audio stream lifecycle (system / desktop audio, never the mic)

    private func startAudio(_ content: SCShareableContent) -> Bool {
        guard let display = content.displays.first else {
            logErr("ERROR no display available for audio capture")
            return false
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = true
        cfg.sampleRate = AUDIO_SAMPLE_RATE
        cfg.channelCount = AUDIO_CHANNELS
        // Video side of this stream is unused; keep it as cheap as possible.
        cfg.width = 128
        cfg.height = 128
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        cfg.queueDepth = 5
        cfg.showsCursor = false

        let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
        do {
            try stream.addStreamOutput(audioSink, type: .audio, sampleHandlerQueue: audioQueue)
            try stream.addStreamOutput(discardSink, type: .screen, sampleHandlerQueue: audioQueue)
        } catch {
            logErr("ERROR addStreamOutput(audio): \(error.localizedDescription)")
            return false
        }

        var ok = false
        let sem = DispatchSemaphore(value: 0)
        stream.startCapture { error in
            if let error = error {
                logErr("ERROR startCapture(audio): \(error.localizedDescription)")
            } else {
                ok = true
            }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 10.0)
        guard ok else { return false }
        audioStream = stream
        logErr("AUDIO READY 48000 Hz stereo float32 -> fd 3 (system audio, mic excluded)")
        return true
    }

    // MARK: Monitor

    private func markLost() {
        bus.blank()
        if !reportedLost {
            logErr("WINDOW LOST")
            reportedLost = true
        }
        curWindowID = 0
        curPID = 0
        curSize = .zero
    }

    private func tick() {
        guard let content = shareableContent() else { return }

        if audioStream == nil {
            _ = startAudio(content)
        }

        guard let info = findWindow(in: content) else {
            if videoStream != nil { stopVideo() }
            markLost()
            return
        }

        let sameWindow = (info.id == curWindowID && info.pid == curPID && curWindowID != 0)
        let resized = sameWindow && info.frame.size != curSize
        let changed = !sameWindow || resized

        guard videoStream == nil || changed else { return } // steady state

        if videoStream != nil { stopVideo() }
        guard startVideo(info) else {
            markLost()
            return
        }

        let dims = "\(Int(info.frame.width))x\(Int(info.frame.height))"
        if !announcedReady {
            logErr("READY \(CANVAS_W) \(CANVAS_H) id=\(info.id) pid=\(info.pid) window=\(dims) fps=\(FPS)")
            announcedReady = true
        } else if resized {
            logErr("WINDOW RESIZED id=\(info.id) pid=\(info.pid) window=\(dims) canvas=\(CANVAS_W)x\(CANVAS_H)")
        } else {
            logErr("WINDOW REACQUIRED id=\(info.id) pid=\(info.pid) window=\(dims)")
        }
        curWindowID = info.id
        curPID = info.pid
        curSize = info.frame.size
        reportedLost = false
    }

    func runMonitor() {
        while true {
            ctl.sync { self.tick() }
            Thread.sleep(forTimeInterval: POLL_SECONDS)
        }
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        ctl.async { [weak self] in
            guard let self = self else { return }
            if stream === self.videoStream {
                self.videoStream = nil
                logErr("VIDEO STREAM STOPPED: \(error.localizedDescription)")
                self.markLost()
            } else if stream === self.audioStream {
                self.audioStream = nil
                logErr("AUDIO STREAM STOPPED: \(error.localizedDescription)")
            }
        }
    }
}

// MARK: - Entry point

let args = CommandLine.arguments

if args.contains("--dims") {
    // Fixed canvas: the window size no longer influences the encoder geometry.
    print("\(CANVAS_W) \(CANVAS_H)")
    exit(0)
}

_ = NSApplication.shared

/// Put a descriptor in non-blocking mode so a full pipe surfaces as EAGAIN instead of parking the
/// pump thread. Without this the drop path below can never trigger.
@discardableResult
func setNonBlocking(_ fd: Int32) -> Bool {
    let flags = fcntl(fd, F_GETFL, 0)
    if flags < 0 { return false }
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK) >= 0
}

signal(SIGPIPE, SIG_IGN)
// Non-blocking video pipe: a full pipe must surface as EAGAIN so the pump can drop the frame and
// hold real time, rather than parking and letting the whole stream drift behind.
setNonBlocking(VIDEO_FD)
signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }

let capture = Capture()

// 30 Hz video pump: the pipe is never silent for more than one frame interval,
// no matter what ScreenCaptureKit is or is not delivering.
let pumpThread = Thread {
    let interval = 1.0 / Double(FPS)
    var next = Date().timeIntervalSince1970
    while true {
        next += interval
        if !capture.bus.pump() {
            logErr("VIDEO PIPE CLOSED, exiting")
            exit(0)
        }
        let now = Date().timeIntervalSince1970
        let delta = next - now
        if delta > 0 {
            usleep(UInt32(delta * 1_000_000))
        } else if delta < -0.5 {
            next = now // resync after a long stall
        }
    }
}
pumpThread.name = "video-pump"
pumpThread.stackSize = 512 * 1024
pumpThread.start()

let monitorThread = Thread {
    capture.runMonitor()
}
monitorThread.name = "window-monitor"
monitorThread.stackSize = 1024 * 1024
monitorThread.start()

RunLoop.main.run()
