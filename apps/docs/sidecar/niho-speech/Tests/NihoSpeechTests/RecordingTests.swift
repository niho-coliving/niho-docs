@preconcurrency import AVFoundation
import Darwin
import Synchronization
import XCTest
@testable import NihoSpeech

/// A sine tone (or silence) in the input device's format: float32, non-interleaved.
private func toneBuffer(format: AVAudioFormat, frames: Int, startFrame: Int, amplitude: Float) -> AVAudioPCMBuffer {
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
    buffer.frameLength = AVAudioFrameCount(frames)
    for channel in 0 ..< Int(format.channelCount) {
        let data = buffer.floatChannelData![channel]
        for index in 0 ..< frames {
            let time = Double(startFrame + index) / format.sampleRate
            data[index] = amplitude * Float(sin(2 * .pi * 440 * time))
        }
    }
    return buffer
}

private func deviceFormat(sampleRate: Double, channels: AVAudioChannelCount) -> AVAudioFormat {
    AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: channels)!
}

/// The microphone's stand-in: delivers `segments` (a device change between
/// them) as fast as it can on its own thread, then calls `whenDone`.
private final class SyntheticInput: RecordingInput, @unchecked Sendable {
    struct Segment {
        var format: AVAudioFormat
        var seconds: Double
        var amplitude: Float = 0.5
    }

    let segments: [Segment]
    let whenDone: @Sendable () -> Void
    private let stopped = Mutex(false)

    init(_ segments: [Segment], whenDone: @escaping @Sendable () -> Void) {
        self.segments = segments
        self.whenDone = whenDone
    }

    func start(events: RecordingInputEvents) throws -> (format: AVAudioFormat, device: String?) {
        let segments = segments
        let whenDone = whenDone
        Thread { [self] in
            for (index, segment) in segments.enumerated() {
                if index > 0 { events.onDeviceChange(segment.format, "Synthetic \(index + 1)") }
                let total = Int(segment.seconds * segment.format.sampleRate)
                let chunk = Int(segment.format.sampleRate / 10)
                var frame = 0
                while frame < total, !stopped.withLock({ $0 }) {
                    let count = min(chunk, total - frame)
                    events.onBuffer(toneBuffer(format: segment.format, frames: count, startFrame: frame, amplitude: segment.amplitude))
                    frame += count
                }
            }
            whenDone()
        }.start()
        return (segments[0].format, "Synthetic 1")
    }

    func stop() {
        stopped.withLock { $0 = true }
    }
}

final class RecordingTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = try makeTemporaryDirectory(for: self)
    }

    private func record(
        _ segments: [SyntheticInput.Segment], output name: String = "rec.m4a"
    ) async throws -> (lines: [[String: Any]], output: URL) {
        let output = directory.appendingPathComponent(name)
        let stop = StopTrigger()
        let input = SyntheticInput(segments) { stop.fire() }
        let captured = CapturedOutput()
        try await RecordCommand.record(RecordOptions(output: output.path), input: input, output: captured.output, stop: stop)
        return (try captured.lines.map { try jsonObject($0) }, output)
    }

    func testLevelMeterIsTheRMSInDBFS() {
        var meter = LevelMeter()
        // A full-scale-half sine: RMS 0.5 / √2 = -9.03 dBFS.
        let tone = (0 ..< LevelMeter.windowFrames * 2).map { Int16(16384 * sin(2 * .pi * 440 * Double($0) / 24000)) }
        let levels = tone.withUnsafeBufferPointer { meter.add($0) }
        XCTAssertEqual(levels.count, 2)
        XCTAssertEqual(levels[0], -9.03, accuracy: 0.05)
        let silence = [Int16](repeating: 0, count: LevelMeter.windowFrames - 1)
        XCTAssertEqual(silence.withUnsafeBufferPointer { meter.add($0) }, [])
        XCTAssertEqual([Int16(0)].withUnsafeBufferPointer { meter.add($0) }, [LevelMeter.silenceDB])
        XCTAssertEqual(LevelMeter.dB(meanSquare: 1), 0)
        XCTAssertEqual(LevelMeter.dB(meanSquare: 1e-30), LevelMeter.silenceDB)
    }

    /// 48 kHz stereo (a MacBook's microphone format) → 24 kHz mono CAF → AAC m4a; the lines in order.
    func testRecordsToAnM4AWithLevelsAndDone() async throws {
        let (lines, output) = try await record([.init(format: deviceFormat(sampleRate: 48000, channels: 2), seconds: 3)])
        XCTAssertEqual(lines.first?["type"] as? String, "started")
        XCTAssertEqual(lines.first?["device"] as? String, "Synthetic 1")
        XCTAssertEqual(lines.first?["sampleRate"] as? Int, 24000)
        let levels = lines.filter { $0["type"] as? String == "level" }
        // Every 0.2 s of audio (the first ones may be held back until `started`).
        XCTAssertGreaterThanOrEqual(levels.count, 13)
        XCTAssertLessThanOrEqual(levels.count, 15)
        for level in levels {
            XCTAssertEqual(try XCTUnwrap(level["db"] as? Double), -9.0, accuracy: 0.3, "\(level)")
        }
        let times = levels.compactMap { $0["durationSec"] as? Double }
        XCTAssertEqual(times, times.sorted())
        XCTAssertEqual(times.last ?? 0, 3.0, accuracy: 0.21)

        let done = try XCTUnwrap(lines.last)
        XCTAssertEqual(done["type"] as? String, "done")
        XCTAssertEqual(done["file"] as? String, output.path)
        XCTAssertEqual(try XCTUnwrap(done["durationSec"] as? Double), 3.0, accuracy: 0.02)
        let bytes = try XCTUnwrap(done["bytes"] as? Int)
        XCTAssertEqual(bytes, try FileManager.default.attributesOfItem(atPath: output.path)[.size] as? Int)
        // About 48 kbps: 3 s ≈ 18 KB of audio, plus about 32 KB of container (AVAudioFile's m4a; measured).
        XCTAssertGreaterThan(bytes, 8_000)
        XCTAssertLessThan(bytes, 64_000)
        // Only the m4a is left (the CAF and the export's temporary file are gone).
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["rec.m4a"])

        let file = try AVAudioFile(forReading: output)
        let format = file.fileFormat.streamDescription.pointee
        XCTAssertEqual(format.mFormatID, kAudioFormatMPEG4AAC)
        XCTAssertEqual(format.mSampleRate, 24000)
        XCTAssertEqual(format.mChannelsPerFrame, 1)
        XCTAssertEqual(Double(file.length) / 24000, 3.0, accuracy: 0.03)
        // convert (the transcription's first step) reads it.
        let wav = directory.appendingPathComponent("rec.wav")
        let frames = try await AudioConverter.convert(input: output.path, output: wav.path)
        XCTAssertEqual(Double(frames) / 16000, 3.0, accuracy: 0.03)
    }

    /// 60 minutes of synthetic PCM through the real resampler, CAF and AAC exporter.
    /// Reuses one second of input; no microphone or hour-long wall clock wait.
    func testOneHourSyntheticRecordingKeepsDurationAndBoundedMemory() throws {
        guard ProcessInfo.processInfo.environment["NIHO_SPEECH_LONG_RECORDING_TEST"] == "1" else {
            throw XCTSkip("set NIHO_SPEECH_LONG_RECORDING_TEST=1 for the synthetic one-hour recording check")
        }
        func peakRSS() -> Int64 {
            var usage = rusage()
            getrusage(RUSAGE_SELF, &usage)
            return Int64(usage.ru_maxrss) // bytes on macOS
        }
        let started = Date()
        let baseline = peakRSS()
        let caf = directory.appendingPathComponent("one-hour.recording.caf")
        let output = directory.appendingPathComponent("one-hour.m4a")
        var levelCount = 0
        var lastLevelSec = 0.0
        let writer = RecordingWriter(caf: try CAFWriter(path: caf.path)) {
            levelCount += 1
            lastLevelSec = $0.durationSec
        }
        let input = toneBuffer(format: deviceFormat(sampleRate: 48000, channels: 2), frames: 48000, startFrame: 0, amplitude: 0.5)
        for _ in 0 ..< 3600 {
            try autoreleasepool { try writer.append(input) }
        }
        let frames = try writer.finish()
        XCTAssertEqual(Double(frames) / 24000, 3600, accuracy: 0.02)
        XCTAssertEqual(lastLevelSec, 3600, accuracy: 0.21)
        XCTAssertEqual(levelCount, 18000)
        XCTAssertEqual(try AVAudioFile(forReading: caf).length, AVAudioFramePosition(frames))
        XCTAssertEqual(try RecordingExporter.export(caf: caf.path, to: output.path), frames)
        let audio = try AVAudioFile(forReading: output)
        let duration = Double(audio.length) / audio.processingFormat.sampleRate
        XCTAssertEqual(duration, 3600, accuracy: 0.03)
        let growth = max(0, peakRSS() - baseline)
        // A whole-hour float stereo input is >1.2 GiB; streaming must stay well below that.
        XCTAssertLessThan(growth, 128 * 1024 * 1024)
        let bytes = try FileManager.default.attributesOfItem(atPath: output.path)[.size] as? Int ?? 0
        print("NIHO_RECORDING_60MIN durationSec=\(duration) frames=\(frames) levels=\(levelCount) m4aBytes=\(bytes) baselineRSS=\(baseline) peakRSS=\(peakRSS()) growthRSS=\(growth) elapsedSec=\(Date().timeIntervalSince(started))")
    }

    /// The device changes mid-recording (48 kHz stereo → 44.1 kHz mono): one recording, both parts.
    func testDeviceChangeKeepsRecording() async throws {
        let (lines, output) = try await record([
            .init(format: deviceFormat(sampleRate: 48000, channels: 2), seconds: 1),
            .init(format: deviceFormat(sampleRate: 44100, channels: 1), seconds: 1.5, amplitude: 0.25),
        ])
        let started = lines.filter { $0["type"] as? String == "started" }
        XCTAssertEqual(started.compactMap { $0["device"] as? String }, ["Synthetic 1", "Synthetic 2"])
        let done = try XCTUnwrap(lines.last)
        XCTAssertEqual(try XCTUnwrap(done["durationSec"] as? Double), 2.5, accuracy: 0.02)
        // The quieter second part: amplitude 0.25 = -15.05 dBFS.
        let lastLevel = try XCTUnwrap(lines.last { $0["type"] as? String == "level" }?["db"] as? Double)
        XCTAssertEqual(lastLevel, -15.05, accuracy: 0.3)
        XCTAssertEqual(Double(try AVAudioFile(forReading: output).length) / 24000, 2.5, accuracy: 0.03)
    }

    /// A recording cut off by a crash: the CAF on disk (its data chunk still -1) reads as everything written so far.
    func testACAFCutOffMidRecordingIsReadable() async throws {
        let path = directory.appendingPathComponent("cut.recording.caf").path
        let writer = RecordingWriter(caf: try CAFWriter(path: path)) { _ in }
        let format = deviceFormat(sampleRate: 48000, channels: 1)
        for second in 0 ..< 2 {
            try writer.append(toneBuffer(format: format, frames: 48000, startFrame: second * 48000, amplitude: 0.5))
        }
        let written = writer.frameCount
        XCTAssertEqual(Double(written) / 24000, 2.0, accuracy: 0.01)
        // What a crash would leave: the file as it is now, never closed.
        let copy = directory.appendingPathComponent("crashed.caf")
        try FileManager.default.copyItem(atPath: path, toPath: copy.path)
        let bytes = try [UInt8](Data(contentsOf: copy))
        XCTAssertEqual(Array(bytes[56 ..< 64]), [UInt8](repeating: 0xFF, count: 8), "data size -1 while recording")
        XCTAssertEqual(bytes.count, CAFWriter.headerBytes + written * 2)

        XCTAssertEqual(try AVAudioFile(forReading: copy).length, AVAudioFramePosition(written))
        let wav = directory.appendingPathComponent("crashed.wav")
        let frames = try await AudioConverter.convert(input: copy.path, output: wav.path)
        XCTAssertEqual(Double(frames) / 16000, Double(written) / 24000, accuracy: 0.01)
        // The export works on it too (the app adds a leftover CAF as it is).
        let m4a = directory.appendingPathComponent("crashed.m4a")
        XCTAssertEqual(try RecordingExporter.export(caf: copy.path, to: m4a.path), written)

        // Closed normally, the header has the real size.
        XCTAssertGreaterThanOrEqual(try writer.finish(), written)
        let closed = try [UInt8](Data(contentsOf: URL(fileURLWithPath: path)))
        let size = closed[56 ..< 64].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
        XCTAssertEqual(Int(size), closed.count - CAFWriter.headerBytes + 4)
    }

    /// The export fails (here the folder became read-only): done names the CAF, which is kept and readable.
    func testExportFailureKeepsTheCAF() async throws {
        let output = directory.appendingPathComponent("rec.m4a")
        let stop = StopTrigger()
        let folder = directory!
        let input = SyntheticInput([.init(format: deviceFormat(sampleRate: 48000, channels: 1), seconds: 1)]) {
            chmod(folder.path, 0o555)
            stop.fire()
        }
        addTeardownBlock { chmod(folder.path, 0o755) }
        let captured = CapturedOutput()
        try await RecordCommand.record(RecordOptions(output: output.path), input: input, output: captured.output, stop: stop)
        chmod(folder.path, 0o755)
        let done = try jsonObject(try XCTUnwrap(captured.lines.last))
        XCTAssertEqual(done["type"] as? String, "done")
        let caf = directory.appendingPathComponent("rec.recording.caf").path
        XCTAssertEqual(done["file"] as? String, caf)
        XCTAssertEqual(try XCTUnwrap(done["durationSec"] as? Double), 1.0, accuracy: 0.02)
        XCTAssertEqual(Double(try AVAudioFile(forReading: URL(fileURLWithPath: caf)).length) / 24000, 1.0, accuracy: 0.02)
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
        XCTAssertTrue(captured.notes.contains { $0.contains("cannot export") }, "\(captured.notes)")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["rec.recording.caf"])
    }

    func testNothingRecordedIsAnErrorAndLeavesNothing() async throws {
        let output = directory.appendingPathComponent("rec.m4a")
        let stop = StopTrigger()
        let input = SyntheticInput([.init(format: deviceFormat(sampleRate: 48000, channels: 1), seconds: 0)]) { stop.fire() }
        do {
            try await RecordCommand.record(RecordOptions(output: output.path), input: input, output: CapturedOutput().output, stop: stop)
            XCTFail("recorded nothing without an error")
        } catch {
            XCTAssertEqual((error as? ToolError)?.code, "input_empty")
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }

    func testNeverReplacesAnExistingRecording() async throws {
        let output = directory.appendingPathComponent("rec.m4a")
        try Data("old".utf8).write(to: output)
        let stop = StopTrigger()
        let input = SyntheticInput([.init(format: deviceFormat(sampleRate: 48000, channels: 1), seconds: 1)]) { stop.fire() }
        do {
            try await RecordCommand.record(RecordOptions(output: output.path), input: input, output: CapturedOutput().output, stop: stop)
            XCTFail("replaced \(output.path)")
        } catch {
            XCTAssertEqual((error as? ToolError)?.code, "write_failed")
        }
        // A leftover CAF of the same name is not replaced either.
        try FileManager.default.removeItem(at: output)
        let caf = directory.appendingPathComponent("rec.recording.caf")
        try Data("crashed".utf8).write(to: caf)
        XCTAssertThrowsError(try CAFWriter(path: caf.path)) { error in
            XCTAssertEqual((error as? ToolError)?.code, "write_failed")
        }
        XCTAssertEqual(try String(contentsOf: caf, encoding: .utf8), "crashed")
    }

    func testWorkingFileIsNextToTheOutput() {
        XCTAssertEqual(RecordCommand.workingFile(for: "/a/b/rec-1.m4a"), "/a/b/rec-1.recording.caf")
        XCTAssertEqual(RecordCommand.startedLine(device: nil), #"{"type":"started","device":null,"sampleRate":24000}"#)
    }

    func testStopTriggerFiresOnce() async {
        let trigger = StopTrigger()
        let waiter = Task { await trigger.wait() }
        trigger.fire()
        trigger.fire()
        await waiter.value
        XCTAssertTrue(trigger.fired)
        await trigger.wait() // already fired: returns at once
    }
}

/// The real microphone through the built CLI: 2 s, stopped with SIGTERM.
/// Runs only with NIHO_SPEECH_E2E=1 on a Mac with an input device whose microphone access is already
/// granted to the process running the tests (never asks).
final class RecordEndToEndTests: XCTestCase {
    func testRecordsTheMicrophoneUntilSIGTERM() throws {
        guard ProcessInfo.processInfo.environment["NIHO_SPEECH_E2E"] == "1" else {
            throw XCTSkip("set NIHO_SPEECH_E2E=1 to record from the microphone")
        }
        guard InputDevice.defaultID() != nil else { throw XCTSkip("no input device") }
        guard MicrophonePermission.status() == "authorized" else {
            throw XCTSkip("microphone access is \(MicrophonePermission.status()) for this process")
        }
        let directory = try makeTemporaryDirectory(for: self)
        let output = directory.appendingPathComponent("mic.m4a")
        let stdoutURL = directory.appendingPathComponent("stdout.txt")
        FileManager.default.createFile(atPath: stdoutURL.path, contents: nil)
        let handle = try FileHandle(forWritingTo: stdoutURL)
        let process = Process()
        process.executableURL = CLI.executable
        process.arguments = ["record", "--output", output.path]
        process.standardOutput = handle
        try process.run()
        Thread.sleep(forTimeInterval: 2.5)
        process.terminate() // SIGTERM
        process.waitUntilExit()
        try handle.close()
        XCTAssertEqual(process.terminationStatus, 0)
        let lines = try String(contentsOf: stdoutURL, encoding: .utf8).split(separator: "\n").map { try jsonObject(String($0)) }
        XCTAssertEqual(lines.first?["type"] as? String, "started")
        XCTAssertGreaterThan(lines.filter { $0["type"] as? String == "level" }.count, 5)
        let done = try XCTUnwrap(lines.last)
        XCTAssertEqual(done["type"] as? String, "done")
        XCTAssertEqual(done["file"] as? String, output.path)
        XCTAssertGreaterThan(try XCTUnwrap(done["durationSec"] as? Double), 1.5)
        XCTAssertGreaterThan(try AVAudioFile(forReading: output).length, 24000)
    }
}
