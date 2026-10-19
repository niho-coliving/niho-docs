import XCTest
@testable import NihoSpeech

final class TranscriptTests: XCTestCase {
    private let tenSeconds = 160_000

    private func assertInvalidRange(_ start: Double?, _ end: Double?, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(
            try TranscriptionRange.resolve(start: start, end: end, frameCount: tenSeconds),
            "\(String(describing: start)) \(String(describing: end))", file: file, line: line
        ) { error in
            XCTAssertEqual((error as? ToolError)?.code, "invalid_range", file: file, line: line)
            XCTAssertEqual((error as? ToolError)?.exitCode, 3, file: file, line: line)
        }
    }

    func testRangeDefaultsMappingAndClamping() throws {
        XCTAssertEqual(try TranscriptionRange.resolve(start: nil, end: nil, frameCount: tenSeconds).frames, 0 ..< 160_000)
        let range = try TranscriptionRange.resolve(start: 1.5, end: 3.25, frameCount: tenSeconds)
        XCTAssertEqual(range.frames, 24000 ..< 52000)
        XCTAssertEqual(range.startSec, 1.5)
        XCTAssertEqual(range.endSec, 3.25)
        XCTAssertEqual(try TranscriptionRange.resolve(start: 9, end: 100, frameCount: tenSeconds).frames, 144_000 ..< 160_000)
        XCTAssertEqual(try TranscriptionRange.resolve(start: 0, end: .greatestFiniteMagnitude, frameCount: tenSeconds).frames, 0 ..< 160_000)
    }

    /// Chunks sharing a cut (printed to 0.01 s) neither overlap nor leave a gap.
    func testAdjacentChunksShareTheCutFrame() throws {
        let frameCount = 213_536
        let first = try TranscriptionRange.resolve(start: 0, end: 7.36, frameCount: frameCount)
        let second = try TranscriptionRange.resolve(start: 7.36, end: 13.35, frameCount: frameCount)
        XCTAssertEqual(first.frames, 0 ..< 117_760)
        XCTAssertEqual(second.frames, 117_760 ..< frameCount)
        let cuts = [0, 897.3, 1801.01, 2700.37]
        let ranges = try zip(cuts, cuts.dropFirst()).map {
            try TranscriptionRange.resolve(start: $0, end: $1, frameCount: 50_000_000).frames
        }
        XCTAssertEqual(zip(ranges, ranges.dropFirst()).filter { $0.upperBound != $1.lowerBound }.count, 0)
    }

    /// The last chunk ends at the duration `silence` printed (rounded to
    /// 0.01 s): it reads to the last frame whichever way the rounding went.
    func testEndAtThePrintedDurationReadsToTheLastFrame() throws {
        // 13.344 s prints as 13.34 (rounded down): frame(13.34) = 213_440 would drop 64 frames.
        XCTAssertEqual(try TranscriptionRange.resolve(start: 7.36, end: 13.34, frameCount: 213_504).frames, 117_760 ..< 213_504)
        // 13.3467 s prints as 13.35 (rounded up).
        XCTAssertEqual(try TranscriptionRange.resolve(start: 7.36, end: 13.35, frameCount: 213_547).frames, 117_760 ..< 213_547)
        // Below the printed duration the end is still the nearest frame.
        XCTAssertEqual(try TranscriptionRange.resolve(start: 7.36, end: 13.33, frameCount: 213_504).frames, 117_760 ..< 213_280)
    }

    func testInvalidRanges() {
        assertInvalidRange(-1, nil)
        assertInvalidRange(-0.001, 5)
        assertInvalidRange(.nan, nil)
        assertInvalidRange(.infinity, nil)
        assertInvalidRange(nil, .nan)
        assertInvalidRange(nil, .infinity)
        assertInvalidRange(0, -.infinity)
        assertInvalidRange(5, 5)
        assertInvalidRange(5, 4)
        assertInvalidRange(10, nil)
        assertInvalidRange(12, 20)
        assertInvalidRange(1, 1.00001) // shorter than one frame
    }

    func testProgressTracker() {
        var tracker = ProgressTracker()
        XCTAssertNil(tracker.advance(to: 0.005))
        XCTAssertEqual(tracker.advance(to: 0.01), 0.01)
        XCTAssertNil(tracker.advance(to: 0.019))
        XCTAssertEqual(tracker.advance(to: 0.29), 0.29)
        XCTAssertEqual(tracker.advance(to: 0.4299), 0.42)
        XCTAssertNil(tracker.advance(to: 0.3))
        XCTAssertNil(tracker.advance(to: .nan))
        XCTAssertEqual(tracker.advance(to: 0.999), 0.99)
        XCTAssertEqual(tracker.advance(to: 7), 1)
        XCTAssertNil(tracker.advance(to: 1))
    }

    func testSegmentsAreClampedToTheRange() throws {
        let range = try TranscriptionRange.resolve(start: 2, end: 6, frameCount: tenSeconds)
        var lines = TranscriptLines(range: range)
        XCTAssertEqual(lines.lines(text: "  ", start: 2, end: 3), [])
        XCTAssertEqual(lines.lines(text: " 今日は ", start: 1.5, end: 3), [
            #"{"type":"segment","start":2,"end":3,"text":"今日は"}"#,
            #"{"type":"progress","ratio":0.25}"#,
        ])
        XCTAssertEqual(lines.lines(text: "鎌倉", start: 3.004, end: 3.03), [
            #"{"type":"segment","start":3,"end":3.03,"text":"鎌倉"}"#,
        ])
        XCTAssertEqual(lines.lines(text: "記事", start: 5.5, end: 6.4), [
            #"{"type":"segment","start":5.5,"end":6,"text":"記事"}"#,
            #"{"type":"progress","ratio":1}"#,
        ])
        XCTAssertEqual(lines.segmentCount, 3)
        // Ratio 1 was reported already: only done.
        XCTAssertEqual(lines.finish(durationMs: 1234), [#"{"type":"done","segments":3,"durationMs":1234}"#])
    }

    func testSpeakerMapSegmentsAlwaysCarryNumberOrNullWhileRawOmitsSpeaker() throws {
        let range = try TranscriptionRange.resolve(start: 2, end: 6, frameCount: tenSeconds)
        var mapped = TranscriptLines(range: range)
        XCTAssertEqual(mapped.lines(text: "一人目", start: 2.5, end: 3, speaker: 1).first,
                       #"{"type":"segment","start":2.5,"end":3,"text":"一人目","speaker":1}"#)
        XCTAssertEqual(mapped.lines(text: "不明", start: nil, end: nil, speaker: nil).first,
                       #"{"type":"segment","start":3,"end":3,"text":"不明","speaker":null}"#)

        var raw = TranscriptLines(range: range)
        let line = try XCTUnwrap(raw.lines(text: "従来", start: 2.5, end: 3).first)
        XCTAssertFalse(line.contains("speaker"))
    }

    func testFinishReportsRatioOneOnce() throws {
        var lines = TranscriptLines(range: try TranscriptionRange.resolve(start: nil, end: nil, frameCount: tenSeconds))
        _ = lines.lines(text: "a", start: 0, end: 4)
        XCTAssertEqual(lines.finish(durationMs: 5), [
            #"{"type":"progress","ratio":1}"#,
            #"{"type":"done","segments":1,"durationMs":5}"#,
        ])
        var silent = TranscriptLines(range: try TranscriptionRange.resolve(start: nil, end: nil, frameCount: tenSeconds))
        XCTAssertEqual(silent.finish(durationMs: 0), [
            #"{"type":"progress","ratio":1}"#,
            #"{"type":"done","segments":0,"durationMs":0}"#,
        ])
    }
}
