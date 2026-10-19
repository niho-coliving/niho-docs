import Foundation
import NihoOnDeviceSpeech
import Speech

/// `{"available","needsDownload","engine","locale"}`; exit 0 whatever the state.
enum ProbeCommand {
    static func run(language: String, output: Output) async {
        let locale = await SpeechEngine.supportedLocale(for: language)
        let available = SpeechEngine.isAvailable && locale != nil
        var needsDownload = false
        if available, let locale {
            needsDownload = !(await SpeechEngine.isInstalled(locale))
        }
        let diarization = await DiarizationSupport.status()
        if diarization.state != .ready { needsDownload = true }
        output.json([
            "available": .bool(available),
            "needsDownload": .bool(needsDownload),
            "engine": .string(SpeechEngine.name),
            "locale": locale.map { .string($0.identifier) } ?? .null,
            "diarization": .object([
                "state": .string(diarization.state.rawValue),
                "detail": diarization.detail.map(JSONValue.string) ?? .null,
            ]),
        ])
    }
}

/// Installs the model: progress lines while downloading, then `done`. The
/// only command that may reserve a locale (see `SpeechEngine`).
enum DownloadCommand {
    static func run(language: String, output: Output) async throws {
        let locale = try await SpeechEngine.requireSupportedLocale(language: language)
        if !(await SpeechEngine.isInstalled(locale)) {
            let request: AssetInstallationRequest?
            do {
                request = try await AssetInventory.assetInstallationRequest(supporting: [SpeechEngine.makeTranscriber(locale: locale)])
            } catch {
                throw ToolError.downloadFailed("cannot request the \(locale.identifier) model: \(ErrorText.describe(error))")
            }
            if let request {
                let progress = request.progress
                let reporter = Task {
                    var tracker = ProgressTracker()
                    while !Task.isCancelled {
                        if let ratio = tracker.advance(to: progress.fractionCompleted) {
                            output.line(ProgressTracker.line(ratio))
                        }
                        try? await Task.sleep(for: .milliseconds(200))
                    }
                    return tracker
                }
                do {
                    try await request.downloadAndInstall()
                } catch {
                    reporter.cancel()
                    _ = await reporter.value
                    throw ToolError.downloadFailed("cannot download the \(locale.identifier) model: \(ErrorText.describe(error))")
                }
                reporter.cancel()
                var tracker = await reporter.value
                if let ratio = tracker.advance(to: progress.fractionCompleted) {
                    output.line(ProgressTracker.line(ratio))
                }
            }
            guard await SpeechEngine.isInstalled(locale) else {
                throw ToolError.downloadFailed("the \(locale.identifier) model is still not installed after the download")
            }
        }
        try await DiarizationSupport.prepare(output: output)
        output.json(["type": "done", "ok": true])
    }
}

/// `{"durationSec"}` of the WAV written.
enum ConvertCommand {
    static func run(_ options: ConvertOptions, output: Output) async throws {
        let frames = try await AudioConverter.convert(input: options.input, output: options.output)
        output.json(["durationSec": .hundredths(WAVFormat.seconds(frames: frames))])
    }
}

/// `{"cuts","durationSec","soundSec"}`: boundaries and non-silent seconds for each chunk.
enum SilenceCommand {
    static func run(_ options: SilenceOptions, output: Output) throws {
        let reader = try WAVReader(path: options.input)
        guard reader.frameCount > 0 else {
            throw ToolError.inputEmpty("\(options.input) has no samples")
        }
        do {
            try ChunkPlanner.validate(
                durationSec: reader.durationSec,
                targetChunkSec: options.target,
                searchWindowSec: options.window,
                minChunkSec: options.min
            )
        } catch ChunkPlanner.PlanError.tooManyCuts {
            throw ToolError.invalidArguments(
                "--target and --min would create more than \(ChunkPlanner.maximumCuts + 1) chunks; increase --target or --min"
            )
        } catch ChunkPlanner.PlanError.invalidParameters {
            throw ToolError.invalidArguments("invalid silence chunking parameters")
        } catch {
            throw ToolError.inputEmpty("\(options.input) has no readable duration")
        }
        let silences = try SilenceDetector.detect(in: reader)
        let chunks: [ChunkPlanner.Chunk]
        do {
            chunks = try ChunkPlanner.plan(
                durationSec: reader.durationSec,
                silenceMidpointsSec: silences.map(\.midpointSec),
                targetChunkSec: options.target,
                searchWindowSec: options.window,
                minChunkSec: options.min
            )
        } catch ChunkPlanner.PlanError.tooManyCuts {
            throw ToolError.invalidArguments(
                "--target and --min would create more than \(ChunkPlanner.maximumCuts + 1) chunks; increase --target or --min"
            )
        } catch ChunkPlanner.PlanError.invalidParameters {
            throw ToolError.invalidArguments("invalid silence chunking parameters")
        } catch {
            throw ToolError.inputEmpty("\(options.input) has no readable duration")
        }
        output.json([
            "cuts": .array(chunks.dropFirst().map { .hundredths($0.startSec) }),
            "durationSec": .hundredths(reader.durationSec),
            "soundSec": .array(chunks.map { chunk in
                let silentSec = silences.reduce(0.0) { total, silence in
                    total + max(0, min(chunk.endSec, silence.endSec) - max(chunk.startSec, silence.startSec))
                }
                return .hundredths(max(0, chunk.endSec - chunk.startSec - silentSec))
            }),
        ])
    }
}

/// `{"durationSec"}` of the chunk WAV written: the frames of `--start`..`--end`
/// (the same range as `transcribe`), so a chunk file holds exactly the samples
/// `transcribe --start --end` would read.
enum SliceCommand {
    static func run(_ options: SliceOptions, output: Output) throws {
        let reader = try WAVReader(path: options.input)
        guard reader.frameCount > 0 else {
            throw ToolError.inputEmpty("\(options.input) has no samples")
        }
        let range = try TranscriptionRange.resolve(start: options.start, end: options.end, frameCount: reader.frameCount)
        let writer = try WAVWriter(destination: options.output)
        do {
            var buffer = [Int16](repeating: 0, count: 65_536)
            var frame = range.frames.lowerBound
            while frame < range.frames.upperBound {
                let count = min(buffer.count, range.frames.upperBound - frame)
                let read = try buffer.withUnsafeMutableBufferPointer {
                    try reader.readFrames(at: frame, into: UnsafeMutableBufferPointer(rebasing: $0[0 ..< count]))
                }
                guard read == count else {
                    throw ToolError.inputUnreadable("\(options.input) ended before its data chunk did")
                }
                try buffer.withUnsafeBufferPointer { samples in
                    #if _endian(big)
                    let littleEndian = samples[0 ..< read].map(\.littleEndian)
                    try littleEndian.withUnsafeBytes { try writer.append($0) }
                    #else
                    try writer.append(UnsafeRawBufferPointer(UnsafeBufferPointer(rebasing: samples[0 ..< read])))
                    #endif
                }
                frame += read
            }
            try writer.commit()
        } catch {
            writer.discard()
            throw error
        }
        output.json(["durationSec": .hundredths(WAVFormat.seconds(frames: writer.frameCount))])
    }
}

/// Segment lines streamed as final results arrive, progress, then `done`.
enum TranscribeCommand {
    static func run(_ options: TranscribeOptions, output: Output, started: ContinuousClock.Instant) async throws {
        // 1. The input and the range.
        let reader = try WAVReader(path: options.input)
        guard reader.frameCount > 0 else {
            throw ToolError.inputEmpty("\(options.input) has no samples")
        }
        let range = try TranscriptionRange.resolve(start: options.start, end: options.end, frameCount: reader.frameCount)
        let speakerMap: SpeakerMap?
        do {
            speakerMap = try options.speakerMap.map { try SpeakerMap.read(from: URL(fileURLWithPath: $0)) }
        } catch {
            throw ToolError.invalidArguments("cannot read --speaker-map: \(ErrorText.describe(error))")
        }
        if let speakerMap, abs(speakerMap.duration - reader.durationSec) > 0.02 {
            throw ToolError.invalidArguments("--speaker-map belongs to a different audio duration")
        }

        // 2. Hints: terms only (variants are known misspellings).
        let hints = try options.hints.map { try Hints.load(path: $0) } ?? []
        let (contextualStrings, ignoredTerms) = Hints.contextualStrings(for: hints)
        if ignoredTerms > 0 {
            output.note("only the first \(Hints.maximumTerms) unique hint terms are used; \(ignoredTerms) ignored")
        }

        // 3. The engine and the model (never reserves or downloads).
        let locale = try await SpeechEngine.requireSupportedLocale(language: options.language)
        guard await SpeechEngine.isInstalled(locale) else {
            throw SpeechEngine.modelNotInstalled(language: options.language)
        }

        // 4. Analysis.
        let transcriber = SpeechEngine.makeTranscriber(locale: locale)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let language = options.language
        if !contextualStrings.isEmpty {
            let context = AnalysisContext()
            context.contextualStrings[.general] = contextualStrings
            do {
                try await analyzer.setContext(context)
            } catch {
                throw SpeechEngine.toolError(for: error, language: language)
            }
        }
        let collector = Task {
            try await streamFinalResults(
                transcriber.results,
                collector: StreamingTranscriptCollector(range: range, speakerMap: speakerMap, output: output)
            ) { result in
                guard result.isFinal else { return nil }
                return CollectedSpeechResult(
                    text: String(result.text.characters),
                    start: result.range.start.seconds,
                    end: result.range.end.seconds,
                    timedText: try timedTextRuns(result.text)
                )
            }
        }
        do {
            let input = WAVAnalyzerInput(reader: reader, frames: range.frames)
            if let lastSampleTime = try await analyzer.analyzeSequence(input) {
                try await analyzer.finalizeAndFinish(through: lastSampleTime)
            } else {
                await analyzer.cancelAndFinishNow()
            }
        } catch {
            // Segments already printed stay valid; stop the results first.
            await analyzer.cancelAndFinishNow()
            _ = try? await collector.value
            throw SpeechEngine.toolError(for: error, language: language)
        }
        var completed: StreamingTranscriptCollector
        do {
            completed = try await collector.value
        } catch {
            throw SpeechEngine.toolError(for: error, language: language)
        }
        let durationMs = Int(started.duration(to: .now) / .milliseconds(1))
        completed.finish(durationMs: durationMs)
    }
}

/// SpeechTranscriber が付けた各 AttributedString run の実時刻だけを使う。
/// result.range の文字数按分は行わず、時刻の無い run は nil のまま shared alignment へ渡す。
private func timedTextRuns(_ attributed: AttributedString) throws -> [TimedText] {
    try attributed.runs.map { run in
        let text = String(attributed[run.range].characters)
        guard let time = run.audioTimeRange else { return try TimedText(text: text) }
        return try TimedText(text: text, start: time.start.seconds, end: time.end.seconds)
    }
}
