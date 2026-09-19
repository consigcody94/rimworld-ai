import Foundation
import AVFoundation

class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
    var isFinished = false

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        isFinished = true
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        isFinished = true
    }
}

func printHelp() {
    print("""
    Usage: speak-neural [--voice <id>] [--rate <0.1-1.0>] [--pitch <0.5-2.0>] <text...>
    Voices available:
      com.apple.siri.natural.Nora (Default)
      com.apple.ttsbundle.gryphon-neural_Simone_en-US_premium
    """)
}

func main() {
    var voiceId = "com.apple.siri.natural.Nora"
    var rate: Float = 0.38
    var pitch: Float = 1.0
    var textParts: [String] = []

    let args = Array(CommandLine.arguments.dropFirst())
    var i = 0
    while i < args.count {
        let arg = args[i]
        if arg == "--voice" && i + 1 < args.count {
            voiceId = args[i + 1]
            i += 2
        } else if arg == "--rate" && i + 1 < args.count {
            if let r = Float(args[i + 1]) {
                if r > 1.0 {
                    rate = 0.38
                } else {
                    rate = min(max(r, 0.20), 0.50)
                }
            }
            i += 2
        } else if arg == "--pitch" && i + 1 < args.count {
            if let p = Float(args[i + 1]) { pitch = p }
            i += 2
        } else if arg == "--help" || arg == "-h" {
            printHelp()
            exit(0)
        } else {
            textParts.append(arg)
            i += 1
        }
    }

    var text = textParts.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty {
        let stdinData = FileHandle.standardInput.readDataToEndOfFile()
        if let stdinStr = String(data: stdinData, encoding: .utf8) {
            text = stdinStr.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    guard !text.isEmpty else {
        exit(0)
    }

    let synth = AVSpeechSynthesizer()
    let delegate = SpeechDelegate()
    synth.delegate = delegate

    let utterance = AVSpeechUtterance(string: text)
    if let voice = AVSpeechSynthesisVoice(identifier: voiceId) {
        utterance.voice = voice
    } else if let fallback = AVSpeechSynthesisVoice(identifier: "com.apple.ttsbundle.gryphon-neural_Simone_en-US_premium") {
        utterance.voice = fallback
    } else {
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
    }

    utterance.rate = rate
    utterance.pitchMultiplier = pitch
    utterance.volume = 1.0

    synth.speak(utterance)

    while !delegate.isFinished {
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }
}

main()
