import Foundation
import NihoOnDeviceSpeech

enum DiarizationSupport {
    static func store() throws -> DiarizationModelStore {
        try DiarizationModelStore(cacheRoot: DiarizationModelStore.defaultCacheRoot())
    }

    static func status() async -> DiarizationModelStatus {
        do {
            return try await store().status()
        } catch NihoSpeechError.modelMissing(let detail) {
            return DiarizationModelStatus(state: .missing, detail: detail)
        } catch {
            return DiarizationModelStatus(state: .corrupt, detail: ErrorText.describe(error))
        }
    }

    static func prepare(output: Output) async throws {
        do {
            let modelStore = try store()
            try await modelStore.prepare { completed, total in
                output.json([
                    "type": "progress",
                    "ratio": .hundredths(Double(completed) / Double(total)),
                    "phase": "diarization",
                ])
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw ToolError.downloadFailed("cannot prepare the fixed diarization model: \(ErrorText.describe(error))")
        }
    }

    static func constraint(for options: DiarizeOptions) -> SpeakerConstraint {
        if let count = options.speakers { return .exactly(count) }
        if let count = options.minimumSpeakers { return .atLeast(count) }
        return .automatic
    }
}

enum DiarizeCommand {
    static func run(_ options: DiarizeOptions, output: Output) async throws {
        let reader = try WAVReader(path: options.input)
        guard reader.frameCount > 0 else { throw ToolError.inputEmpty("\(options.input) has no samples") }
        do {
            let modelStore = try DiarizationSupport.store()
            guard await modelStore.status().state == .ready else {
                throw ToolError.modelNotInstalled("the fixed diarization model is not ready; run `niho-speech download`")
            }
            let diarizer = NihoDiarizer(modelStore: modelStore)
            let map = try await diarizer.diarize(
                URL(fileURLWithPath: options.input),
                duration: reader.durationSec,
                constraint: DiarizationSupport.constraint(for: options)
            )
            try map.write(to: URL(fileURLWithPath: options.output))
            output.json(["ok": true, "turns": .integer(map.turns.count)])
        } catch let error as ToolError {
            throw error
        } catch {
            throw ToolError.transcriptionFailed("speaker diarization failed: \(ErrorText.describe(error))")
        }
    }
}
