import Speech
import XCTest
@testable import NihoSpeech

/// On-device transcription of the fixture through the built CLI (Kyoko TTS,
/// 13.35 s: 「こんにちは。今日は鎌倉の拠点で、新しい取り組みについて話します。」,
/// a 2.5 s pause, 「来月から、会員のみなさんと一緒に記事を作ります。」).
///
/// Runs only with NIHO_SPEECH_E2E=1 on a Mac where SpeechTranscriber is
/// available and the ja model installed. Never downloads or reserves a locale.
final class EndToEndTests: XCTestCase {
    private struct Segment {
        let start: Double
        let end: Double
        let text: String
    }

    private struct Transcript {
        let segments: [Segment]
        let ratios: [Double]
        let done: [String: Any]
    }

    private var directory: URL!
    private var wav: URL!

    override func setUp() async throws {
        guard ProcessInfo.processInfo.environment["NIHO_SPEECH_E2E"] == "1" else {
            throw XCTSkip("set NIHO_SPEECH_E2E=1 to run the on-device transcription tests")
        }
        guard SpeechTranscriber.isAvailable else {
            throw XCTSkip("SpeechTranscriber is not available on this Mac")
        }
        guard let ja = await SpeechEngine.supportedLocale(for: "ja"), await SpeechEngine.isInstalled(ja) else {
            throw XCTSkip("the ja speech model is not installed (niho-speech download --language ja)")
        }
        directory = try makeTemporaryDirectory(for: self)
        wav = directory.appendingPathComponent("ja-sample.wav")
        let result = try CLI.run(["convert", "--input", try fixtureURL("ja-sample", "m4a").path, "--output", wav.path], in: directory)
        XCTAssertEqual(result.status, 0, result.stdout)
    }

    private func transcribe(_ extra: [String] = [], file: StaticString = #filePath, line: UInt = #line) throws -> Transcript {
        let result = try CLI.run(["transcribe", "--input", wav.path] + extra, in: directory)
        XCTAssertEqual(result.status, 0, result.stdout, file: file, line: line)
        let objects = try result.objects()
        var segments: [Segment] = []
        var ratios: [Double] = []
        for object in objects.dropLast() {
            switch object["type"] as? String {
            case "segment":
                segments.append(Segment(
                    start: try XCTUnwrap(object["start"] as? Double),
                    end: try XCTUnwrap(object["end"] as? Double),
                    text: try XCTUnwrap(object["text"] as? String)
                ))
            case "progress":
                ratios.append(try XCTUnwrap(object["ratio"] as? Double))
            default:
                XCTFail("unexpected line \(object)", file: file, line: line)
            }
        }
        let done = try XCTUnwrap(objects.last, "no output", file: file, line: line)
        XCTAssertEqual(done["type"] as? String, "done", file: file, line: line)
        XCTAssertEqual(done["segments"] as? Int, segments.count, file: file, line: line)
        XCTAssertNotNil(done["durationMs"] as? Int, file: file, line: line)
        XCTAssertEqual(ratios, ratios.sorted(), "progress goes back", file: file, line: line)
        XCTAssertEqual(Set(ratios).count, ratios.count, "progress repeats", file: file, line: line)
        XCTAssertEqual(ratios.last, 1, file: file, line: line)
        return Transcript(segments: segments, ratios: ratios, done: done)
    }

    /// The cut and the duration as `silence` prints them.
    private func plan() throws -> (cut: Double, duration: Double) {
        let result = try CLI.run(["silence", "--input", wav.path, "--target", "6", "--window", "3", "--min", "2"], in: directory)
        XCTAssertEqual(result.status, 0, result.stdout)
        let object = try jsonObject(result.stdout)
        let cuts = try XCTUnwrap(object["cuts"] as? [Double])
        XCTAssertEqual(cuts.count, 1, "\(cuts)")
        return (try XCTUnwrap(cuts.first), try XCTUnwrap(object["durationSec"] as? Double))
    }

    func testProbe() throws {
        let result = try CLI.run(["probe", "--language", "ja"], in: directory)
        XCTAssertEqual(result.status, 0)
        let object = try jsonObject(result.stdout)
        XCTAssertEqual(object["available"] as? Bool, true)
        XCTAssertEqual(object["needsDownload"] as? Bool, false)
        XCTAssertEqual(object["engine"] as? String, "SpeechAnalyzer")
        XCTAssertEqual(object["locale"] as? String, "ja_JP")
    }

    /// A bare language resolves to its likely region, the same on every run.
    func testBareLanguageTakesItsLikelyRegion() async throws {
        for (language, expected) in [("ja", "ja_JP"), ("en", "en_US"), ("fr", "fr_FR"), ("fr-CA", "fr_CA"), ("pt", "pt_BR")] {
            let locale = await SpeechEngine.supportedLocale(for: language)
            XCTAssertEqual(locale?.identifier, expected, language)
        }
        let unsupported = await SpeechEngine.supportedLocale(for: "xx-YY")
        XCTAssertNil(unsupported)
    }

    func testSilenceCutsInThePause() throws {
        let (cut, duration) = try plan()
        // ffmpeg's silence is [5.923, 8.798]: midpoint 7.36.
        XCTAssertEqual(cut, 7.36, accuracy: 0.1)
        XCTAssertEqual(duration, 13.35, accuracy: 0.011)
    }

    func testChunksTranscribeLikeTheWholeFile() throws {
        let (cut, duration) = try plan()
        let whole = try transcribe()
        let first = try transcribe(["--start", "0", "--end", "\(cut)"])
        let second = try transcribe(["--start=\(cut)", "--end=\(duration)"])

        XCTAssertTrue(whole.segments.map(\.text).joined().contains("鎌倉"))
        XCTAssertTrue(whole.segments.map(\.text).joined().contains("記事"))
        XCTAssertTrue(first.segments.map(\.text).joined().contains("鎌倉"), "\(first.segments)")
        XCTAssertTrue(second.segments.map(\.text).joined().contains("記事"), "\(second.segments)")
        // Times are seconds of the whole WAV, inside each chunk.
        for (chunk, range) in [(first, 0 ... cut), (second, cut ... duration), (whole, 0 ... duration)] {
            XCTAssertFalse(chunk.segments.isEmpty)
            for segment in chunk.segments {
                XCTAssertTrue(range.contains(segment.start) && range.contains(segment.end), "\(segment) outside \(range)")
                XCTAssertLessThanOrEqual(segment.start, segment.end)
            }
        }
        // Splitting at the silence keeps the segments where they were (relative
        // times would put the second chunk's first segment near 1.3 s).
        let chunked = first.segments + second.segments
        XCTAssertEqual(chunked.count, whole.segments.count)
        for (part, all) in zip(chunked, whole.segments) {
            XCTAssertEqual(part.start, all.start, accuracy: 0.2, "\(part) vs \(all)")
        }
    }

    func testHints() throws {
        let hints = directory.appendingPathComponent("hints.json")
        try Data(#"[{"term":"NIHO鎌倉","reading":"にほかまくら","variants":["NIHO 鎌倉"]},{"term":"拠点"}]"#.utf8)
            .write(to: hints)
        let transcript = try transcribe(["--hints", hints.path])
        XCTAssertTrue(transcript.segments.map(\.text).joined().contains("鎌倉"))
    }

    func testLanguageWithoutModel() async throws {
        if let ko = await SpeechEngine.supportedLocale(for: "ko"), await SpeechEngine.isInstalled(ko) {
            throw XCTSkip("the ko model is installed on this Mac")
        }
        let result = try CLI.run(["transcribe", "--input", wav.path, "--language", "ko"], in: directory)
        XCTAssertEqual(result.status, 2, result.stdout)
        XCTAssertEqual(result.lines.count, 1)
        let error = try jsonObject(result.stdout)
        XCTAssertEqual(error["code"] as? String, "model_not_installed")
        XCTAssertTrue((error["message"] as? String ?? "").contains("niho-speech download --language ko"))
    }
}
