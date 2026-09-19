import AppKit
import ScreenCaptureKit
import CoreMedia
import Foundation

_ = NSApplication.shared

class FrameWriter: NSObject, SCStreamOutput {
    let stdoutHandle = FileHandle.standardOutput
    var frameCount: UInt64 = 0

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let pixelBuffer = sampleBuffer.imageBuffer else { return }

        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)

        if bytesPerRow == width * 4 {
            let data = Data(bytesNoCopy: base, count: width * height * 4, deallocator: .none)
            self.stdoutHandle.write(data)
        } else {
            for row in 0..<height {
                let rowPtr = base.advanced(by: row * bytesPerRow)
                let data = Data(bytesNoCopy: rowPtr, count: width * 4, deallocator: .none)
                self.stdoutHandle.write(data)
            }
        }
        frameCount += 1
    }
}

func findRimWorldWindow() async throws -> SCWindow? {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    var candidates: [SCWindow] = []
    for win in content.windows {
        guard let app = win.owningApplication else { continue }
        let appName = app.applicationName
        let title = win.title ?? ""
        if (appName.contains("RimWorld") || title.contains("RimWorld")) && win.frame.height > 200 && win.frame.width > 200 {
            candidates.append(win)
        }
    }
    // Sort descending by area (width * height) to always pick the main game window
    candidates.sort { ($0.frame.width * $0.frame.height) > ($1.frame.width * $1.frame.height) }
    return candidates.first
}

func main() async {
    let args = CommandLine.arguments
    let printOnly = args.contains("--dims")

    do {
        guard let win = try await findRimWorldWindow() else {
            FileHandle.standardError.write("ERROR: RimWorld window not found\n".data(using: .utf8)!)
            exit(1)
        }

        // Logical frame to backing pixels (scale: 2 on Retina)
        let scale: CGFloat = 2.0
        let targetWidth = Int(win.frame.width * scale)
        let targetHeight = Int(win.frame.height * scale)

        // Make width and height even for video encoders
        let evenWidth = targetWidth - (targetWidth % 2)
        let evenHeight = targetHeight - (targetHeight % 2)

        if printOnly {
            print("\(evenWidth) \(evenHeight)")
            exit(0)
        }

        FileHandle.standardError.write("READY: \(evenWidth)x\(evenHeight) ID=\(win.windowID)\n".data(using: .utf8)!)

        let filter = SCContentFilter(desktopIndependentWindow: win)
        let config = SCStreamConfiguration()
        config.width = evenWidth
        config.height = evenHeight
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        let writer = FrameWriter()
        try stream.addStreamOutput(writer, type: .screen, sampleHandlerQueue: DispatchQueue.global(qos: .userInteractive))

        signal(SIGINT) { _ in exit(0) }
        signal(SIGTERM) { _ in exit(0) }
        signal(SIGPIPE) { _ in exit(0) }

        try await stream.startCapture()

        // Keep running until terminated
        while true {
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
    } catch {
        FileHandle.standardError.write("FATAL: \(error.localizedDescription)\n".data(using: .utf8)!)
        exit(1)
    }
}

Task {
    await main()
}
RunLoop.main.run()
