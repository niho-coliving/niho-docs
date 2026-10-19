import XCTest
@testable import NihoSpeech

/// Parity with ffmpeg `silencedetect=noise=-35dB:d=0.35` on 16 kHz s16 mono.
final class SilenceDetectorTests: XCTestCase {
    private let loud: Int16 = 10_000

    private func detect(_ samples: [Int16]) -> [SilenceInterval] {
        var detector = SilenceDetector()
        detector.consume(samples)
        return detector.finish()
    }

    private func interval(_ start: Int, _ end: Int) -> SilenceInterval {
        SilenceInterval(startFrame: start, endFrame: end)
    }

    func testConstantsMatchFFmpeg() {
        // ffmpeg: noise = 10^(-35/20) = 0.0177828, × INT16_MAX, truncated to int16_t.
        XCTAssertEqual(SilenceDetector.threshold, 582)
        // d = 0.35 s at 16 kHz.
        XCTAssertEqual(SilenceDetector.minimumFrames, 5600)
    }

    func testIntervalBoundaries() {
        let samples = [Int16](repeating: loud, count: 1000) + [Int16](repeating: 0, count: 6000)
            + [Int16](repeating: loud, count: 1000)
        let intervals = detect(samples)
        XCTAssertEqual(intervals, [interval(1000, 7000)])
        XCTAssertEqual(intervals[0].startSec, 0.0625)
        XCTAssertEqual(intervals[0].endSec, 0.4375)
        XCTAssertEqual(intervals[0].midpointSec, 0.25)
    }

    func testRunsShorterThanMinimumAreIgnored() {
        let short = [loud] + [Int16](repeating: 0, count: 5599) + [loud]
        XCTAssertEqual(detect(short), [])
        let exact = [loud] + [Int16](repeating: 0, count: 5600) + [loud]
        XCTAssertEqual(detect(exact), [interval(1, 5601)])
    }

    func testLeadingSilenceStartsAtZero() {
        let samples = [Int16](repeating: 0, count: 6000) + [Int16](repeating: loud, count: 100)
        XCTAssertEqual(detect(samples), [interval(0, 6000)])
    }

    func testTrailingSilenceEndsAtTheEnd() {
        let samples = [Int16](repeating: loud, count: 100) + [Int16](repeating: 0, count: 6000)
        XCTAssertEqual(detect(samples), [interval(100, 6100)])
        // Too short at the end: nothing.
        XCTAssertEqual(detect([Int16](repeating: loud, count: 100) + [Int16](repeating: 0, count: 5599)), [])
        // All silent.
        XCTAssertEqual(detect([Int16](repeating: 0, count: 5600)), [interval(0, 5600)])
    }

    func testThresholdBoundary() {
        let quiet = (0 ..< 6000).map { $0.isMultiple(of: 2) ? Int16(581) : Int16(-581) }
        XCTAssertEqual(detect([loud] + quiet + [loud]), [interval(1, 6001)])
        XCTAssertEqual(detect([loud] + [Int16](repeating: 582, count: 6000) + [loud]), [])
        XCTAssertEqual(detect([loud] + [Int16](repeating: -582, count: 6000) + [loud]), [])
        XCTAssertEqual(detect([Int16](repeating: .min, count: 6000)), [])
        // One sample at the threshold splits a silence.
        let split = [Int16](repeating: 0, count: 6000) + [582] + [Int16](repeating: 0, count: 6000)
        XCTAssertEqual(detect(split), [interval(0, 6000), interval(6001, 12001)])
    }

    func testUnevenBuffersGiveTheSameIntervals() {
        // Silences of several lengths at irregular places, some loud blips.
        var samples: [Int16] = []
        for (index, length) in [7000, 300, 5600, 5599, 12_345, 1, 6001, 900, 20_000].enumerated() {
            samples += [Int16](repeating: index.isMultiple(of: 2) ? 3 : -3, count: length)
            samples += [Int16](repeating: index.isMultiple(of: 3) ? 600 : -9000, count: 1 + index * 37)
        }
        samples += [Int16](repeating: 0, count: 8000)
        let whole = detect(samples)
        XCTAssertEqual(whole.count, 6)

        for sizes in [[1], [7, 4999, 13], [5600], [65_536], [3, 1, 11_111, 2]] {
            var detector = SilenceDetector()
            var offset = 0
            var turn = 0
            while offset < samples.count {
                let size = min(sizes[turn % sizes.count], samples.count - offset)
                detector.consume(Array(samples[offset ..< offset + size]))
                offset += size
                turn += 1
            }
            XCTAssertEqual(detector.finish(), whole, "\(sizes)")
        }
    }

    func testDetectStreamsAWAVAcrossReadBuffers() throws {
        let directory = try makeTemporaryDirectory(for: self)
        // A silence across the 65 536-frame read boundary, and one at the end.
        var samples = [Int16](repeating: loud, count: 80_000)
        for index in 60_000 ..< 70_000 { samples[index] = 0 }
        for index in 74_000 ..< 80_000 { samples[index] = 1 }
        let url = directory.appendingPathComponent("a.wav")
        try writeWAV(samples, to: url)
        let intervals = try SilenceDetector.detect(in: WAVReader(path: url.path))
        XCTAssertEqual(intervals, [interval(60_000, 70_000), interval(74_000, 80_000)])
    }
}
