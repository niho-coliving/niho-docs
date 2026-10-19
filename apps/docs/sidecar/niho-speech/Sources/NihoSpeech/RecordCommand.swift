@preconcurrency import AVFoundation
import Darwin
import Foundation
import Synchronization

/// Fires once: SIGTERM / SIGINT, the parent going away, the input ending, a write failing.
final class StopTrigger: Sendable {
    private let state = Mutex<(fired: Bool, waiters: [CheckedContinuation<Void, Never>])>((false, []))

    func fire() {
        let waiters = state.withLock { state -> [CheckedContinuation<Void, Never>] in
            guard !state.fired else { return [] }
            state.fired = true
            defer { state.waiters = [] }
            return state.waiters
        }
        for waiter in waiters { waiter.resume() }
    }

    var fired: Bool { state.withLock { $0.fired } }

    func wait() async {
        await withCheckedContinuation { continuation in
            let resumeNow = state.withLock { state -> Bool in
                if state.fired { return true }
                state.waiters.append(continuation)
                return false
            }
            if resumeNow { continuation.resume() }
        }
    }
}

/// SIGTERM (how NIHO docs stops a recording) and SIGINT (Ctrl-C) fire the
/// trigger instead of ending the process; so does the parent going away
/// (the app crashed: the recording is still saved). SIGPIPE is ignored so a
/// closed stdout never kills the export.
final class SignalStop: @unchecked Sendable {
    private let queue = DispatchQueue(label: "niho-speech.record.signals")
    private var sources: [DispatchSourceProtocol] = []

    init(_ trigger: StopTrigger) {
        signal(SIGPIPE, SIG_IGN)
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
            source.setEventHandler { trigger.fire() }
            source.resume()
            sources.append(source)
        }
        let parent = getppid()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler {
            if getppid() != parent { trigger.fire() }
        }
        timer.resume()
        sources.append(timer)
    }

    deinit {
        for source in sources { source.cancel() }
    }
}

/// `record --output a.m4a`: `started`, `level` lines, then `done` (README).
enum RecordCommand {
    static func run(_ options: RecordOptions, output: Output) async throws {
        // The device first: with no microphone there is nothing to ask permission for.
        let input = try MicrophoneInput()
        try await MicrophonePermission.require()
        let trigger = StopTrigger()
        let signals = SignalStop(trigger)
        defer { withExtendedLifetime(signals) {} }
        try await record(options, input: input, output: output, stop: trigger)
    }

    /// The working CAF next to the output: `a.m4a` → `a.recording.caf`.
    static func workingFile(for output: String) -> String {
        let url = URL(fileURLWithPath: output)
        return url.deletingPathExtension().appendingPathExtension("recording.caf").path
    }

    /// Records `input` until `stop` fires, then exports. `started` is printed
    /// once the input runs (and again with the new device when it changes).
    static func record(_ options: RecordOptions, input: RecordingInput, output: Output, stop: StopTrigger) async throws {
        guard !FileManager.default.fileExists(atPath: options.output) else {
            throw ToolError.writeFailed("\(options.output) already exists")
        }
        let cafPath = workingFile(for: options.output)
        let caf = try CAFWriter(path: cafPath)
        let session = RecordingSession(writer: RecordingWriter(caf: caf) { reading in
            output.json([
                "type": "level",
                "db": .number((reading.db * 10).rounded() / 10),
                "durationSec": .hundredths(reading.durationSec),
            ])
        }, stop: stop)

        let activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .idleSystemSleepDisabled],
            reason: "Recording audio for NIHO docs"
        )
        defer { ProcessInfo.processInfo.endActivity(activity) }

        let started: (format: AVAudioFormat, device: String?)
        do {
            started = try input.start(events: RecordingInputEvents(
                onBuffer: { session.append($0) },
                onDeviceChange: { format, device in
                    output.note("the input device changed to \(device ?? "an unnamed device") (\(format))")
                    output.line(startedLine(device: device))
                },
                onEnd: { reason in
                    output.note("the input ended: \(reason)")
                    stop.fire()
                }
            ))
        } catch {
            input.stop()
            _ = try? session.finish()
            unlink(cafPath)
            throw error
        }
        // `started` before any `level` line (the audio before it is kept, its levels are not printed).
        do {
            try session.begin(format: started.format) {
                output.line(startedLine(device: started.device))
            }
        } catch {
            input.stop()
            _ = try? session.finish()
            unlink(cafPath)
            throw error
        }

        await stop.wait()
        input.stop()
        // A failure here leaves the CAF as written so far (its data runs to the end of the file).
        let frames = try session.finish()
        if let failure = session.failure {
            output.note("recording stopped early: \(failure.message)")
        }
        guard frames > 0 else {
            unlink(cafPath)
            throw ToolError.inputEmpty("no audio was recorded")
        }
        let durationSec = Double(frames) / Double(CAFWriter.sampleRate)
        var file = options.output
        do {
            _ = try RecordingExporter.export(caf: cafPath, to: options.output)
            unlink(cafPath)
        } catch {
            // Keep the recording: the CAF itself is the result (convert reads it).
            output.note("cannot export to AAC, keeping \(cafPath): \(ErrorText.describe(error))")
            file = cafPath
        }
        output.json([
            "type": "done",
            "file": .string(file),
            "durationSec": .hundredths(durationSec),
            "bytes": .integer(fileSize(file)),
        ])
    }

    static func startedLine(device: String?) -> String {
        JSONLine.encode([
            "type": "started",
            "device": device.map { .string($0) } ?? .null,
            "sampleRate": .integer(CAFWriter.sampleRate),
        ])
    }

    static func fileSize(_ path: String) -> Int {
        var info = stat()
        return stat(path, &info) == 0 ? Int(info.st_size) : 0
    }
}

/// The writer behind a lock: buffers come from the input's thread, the
/// format and the finish from the command. A write failure (a full disk)
/// stops the recording; what was written stays in the CAF. Buffers after
/// `finish` are dropped.
final class RecordingSession: Sendable {
    private struct State {
        var writer: RecordingWriter
        var finished = false
        var failure: ToolError?
    }

    private let state: Mutex<State>
    private let stop: StopTrigger

    init(writer: sending RecordingWriter, stop: StopTrigger) {
        writer.reportsLevels = false
        state = Mutex(State(writer: writer))
        self.stop = stop
    }

    var failure: ToolError? { state.withLock { $0.failure } }

    /// Prints levels from now on; `announce` runs first, under the lock.
    func begin(format: AVAudioFormat, announce: () -> Void) throws {
        try state.withLock { state in
            try state.writer.setInputFormat(format)
            announce()
            state.writer.reportsLevels = true
        }
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        let failed = state.withLock { state -> Bool in
            guard !state.finished, state.failure == nil else { return false }
            do {
                try state.writer.append(buffer)
                return false
            } catch {
                state.failure = error as? ToolError ?? .recordingFailed(ErrorText.describe(error))
                return true
            }
        }
        if failed { stop.fire() }
    }

    /// Flushes and closes the CAF (once); later buffers are dropped.
    func finish() throws -> Int {
        try state.withLock { state in
            guard !state.finished else { return state.writer.frameCount }
            state.finished = true
            return try state.writer.finish()
        }
    }
}
