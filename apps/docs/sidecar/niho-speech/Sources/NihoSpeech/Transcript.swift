import Foundation
import NihoOnDeviceSpeech

/// The part of the WAV that `transcribe` reads and `slice` copies.
struct TranscriptionRange: Equatable {
    let frames: Range<Int>

    var startSec: Double { WAVFormat.seconds(frames: frames.lowerBound) }
    var endSec: Double { WAVFormat.seconds(frames: frames.upperBound) }

    /// `--start` (default 0) and `--end` (default the end of the audio; later
    /// is clamped) for a WAV of `frameCount` frames. An end at or after the
    /// duration as `convert` / `silence` print it (0.01 s) reads to the last
    /// frame, so a last chunk ending at the printed duration never drops the
    /// few milliseconds the rounding cut off. A negative or non-finite value,
    /// an end not after the start, or a start at or after the end of the audio
    /// is `invalid_range`.
    static func resolve(start: Double?, end: Double?, frameCount: Int) throws -> TranscriptionRange {
        let durationSec = WAVFormat.seconds(frames: frameCount)
        let start = start ?? 0
        guard start.isFinite, start >= 0 else {
            throw ToolError.invalidRange("--start must be a finite number of seconds ≥ 0 (got \(start))")
        }
        guard start < durationSec else {
            throw ToolError.invalidRange("--start \(start) is not before the end of the audio (\(durationSec) s)")
        }
        let end = end ?? durationSec
        guard end.isFinite else {
            throw ToolError.invalidRange("--end must be a finite number of seconds (got \(end))")
        }
        guard end > start else {
            throw ToolError.invalidRange("--end \(end) must be after --start \(start)")
        }
        let startFrame = WAVFormat.frame(seconds: start)
        let printedDurationSec = (durationSec * 100).rounded() / 100
        let endFrame = end >= printedDurationSec
            ? frameCount
            : min(WAVFormat.frame(seconds: min(end, durationSec)), frameCount)
        guard endFrame > startFrame else {
            throw ToolError.invalidRange("--start \(start) to --end \(end) is shorter than one sample")
        }
        return TranscriptionRange(frames: startFrame ..< endFrame)
    }
}

/// Progress in 0.01 steps: a ratio is reported only once it has grown by at
/// least 0.01 since the last report, so reported ratios only increase. Ratios
/// are rounded down, so 1 means done.
struct ProgressTracker {
    private(set) var lastPercent = 0

    /// The ratio to report for `fraction` (clamped to 0...1), or nil.
    mutating func advance(to fraction: Double) -> Double? {
        guard fraction.isFinite else { return nil }
        let percent = Int((min(max(fraction, 0), 1) * 100 + 1e-9).rounded(.down))
        guard percent > lastPercent else { return nil }
        lastPercent = percent
        return Double(percent) / 100
    }

    static func line(_ ratio: Double) -> String {
        JSONLine.encode(["type": "progress", "ratio": .hundredths(ratio)])
    }
}

/// Turns final transcriber results into `segment` and `progress` lines in
/// seconds of the whole WAV, clamped to the requested range.
struct TranscriptLines {
    let range: TranscriptionRange
    private(set) var segmentCount = 0
    private var progress = ProgressTracker()
    private var lastEnd: Double

    init(range: TranscriptionRange) {
        self.range = range
        lastEnd = range.startSec
    }

    /// Nothing for empty text; else the segment and, when the ratio grew by
    /// 0.01, a progress line.
    mutating func lines(text: String, start: Double, end: Double) -> [String] {
        makeLines(text: text, start: start, end: end, speaker: nil, includeSpeaker: false)
    }

    /// `--speaker-map` があるときだけ speaker を必ず出す（不明は null）。
    mutating func lines(text: String, start: Double?, end: Double?, speaker: Int?) -> [String] {
        makeLines(text: text, start: start ?? lastEnd, end: end ?? start ?? lastEnd, speaker: speaker, includeSpeaker: true)
    }

    private mutating func makeLines(
        text: String,
        start: Double,
        end: Double,
        speaker: Int?,
        includeSpeaker: Bool
    ) -> [String] {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return [] }
        let lower = range.startSec
        let upper = range.endSec
        let start = start.isFinite ? min(max(start, lower), upper) : lastEnd
        let end = end.isFinite ? min(max(end, start), upper) : start
        lastEnd = end
        segmentCount += 1
        let segment = includeSpeaker
            ? JSONLine.encode([
                "type": "segment", "start": .hundredths(start), "end": .hundredths(end), "text": .string(text),
                "speaker": speaker.map(JSONValue.integer) ?? .null,
            ])
            : JSONLine.encode([
                "type": "segment", "start": .hundredths(start), "end": .hundredths(end), "text": .string(text),
            ])
        var lines = [segment]
        if let ratio = progress.advance(to: (end - lower) / (upper - lower)) {
            lines.append(ProgressTracker.line(ratio))
        }
        return lines
    }

    /// Ratio 1 unless already reported, then `done`.
    mutating func finish(durationMs: Int) -> [String] {
        var lines: [String] = []
        if let ratio = progress.advance(to: 1) {
            lines.append(ProgressTracker.line(ratio))
        }
        lines.append(JSONLine.encode([
            "type": "done", "segments": .integer(segmentCount), "durationMs": .integer(durationMs),
        ]))
        return lines
    }
}

/// SpeechTranscriberの確定結果1件。runの実時刻はこの単位で直ちに話者へ対応付ける。
struct CollectedSpeechResult: Sendable {
    let text: String
    let start: Double
    let end: Double
    let timedText: [TimedText]
}

/// 確定結果を保持せず、その場でsegment/progressへ変換する。後続の失敗や取消でも出力済み行は残る。
struct StreamingTranscriptCollector: Sendable {
    private var lines: TranscriptLines
    private let speakerMap: SpeakerMap?
    private let output: Output

    init(range: TranscriptionRange, speakerMap: SpeakerMap?, output: Output) {
        lines = TranscriptLines(range: range)
        self.speakerMap = speakerMap
        self.output = output
    }

    mutating func accept(_ result: CollectedSpeechResult) throws {
        if let speakerMap {
            for utterance in try SpeakerAlignment.align(result.timedText, to: speakerMap) {
                for line in lines.lines(
                    text: utterance.text,
                    start: utterance.start,
                    end: utterance.end,
                    speaker: utterance.speaker
                ) { output.line(line) }
            }
        } else {
            for line in lines.lines(text: result.text, start: result.start, end: result.end) { output.line(line) }
        }
    }

    mutating func finish(durationMs: Int) {
        for line in lines.finish(durationMs: durationMs) { output.line(line) }
    }
}

/// productionのSpeechTranscriber.resultsとテストのAsyncThrowingStreamで同じ逐次処理を使う。
func streamFinalResults<S: AsyncSequence>(
    _ results: S,
    collector initial: StreamingTranscriptCollector,
    transform: (S.Element) throws -> CollectedSpeechResult?
) async throws -> StreamingTranscriptCollector {
    var collector = initial
    for try await value in results {
        try Task.checkCancellation()
        if let result = try transform(value) { try collector.accept(result) }
    }
    try Task.checkCancellation()
    return collector
}
