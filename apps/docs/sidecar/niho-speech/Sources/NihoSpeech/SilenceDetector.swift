import Foundation

/// A silence in frames: `[startFrame, endFrame)`.
struct SilenceInterval: Equatable {
    let startFrame: Int
    let endFrame: Int

    var startSec: Double { WAVFormat.seconds(frames: startFrame) }
    var endSec: Double { WAVFormat.seconds(frames: endFrame) }
    var midpointSec: Double { (startSec + endSec) / 2 }
}

/// ffmpeg `silencedetect=noise=-35dB:d=0.35` on 16 kHz s16 mono, sample for
/// sample (libavfilter/af_silencedetect.c), as the API runs it:
/// - a sample is silent iff `-582 < s < 582` (ffmpeg truncates
///   10^(-35/20) × 32767 = 582.69 to the sample type);
/// - a silence is a run of at least 5600 silent samples (0.35 s);
/// - it starts at the run's first sample and ends at the first sample after
///   it that is not silent, or at the end of the file.
///
/// Fed in buffers of any size (constant memory); runs carry across buffers.
struct SilenceDetector {
    static let threshold = Int16(pow(10.0, -35.0 / 20.0) * Double(Int16.max))
    static let minimumFrames = 5600

    private(set) var intervals: [SilenceInterval] = []
    private(set) var frameCount = 0
    private var runStart: Int?

    mutating func consume(_ samples: UnsafeBufferPointer<Int16>) {
        let threshold = Self.threshold
        var position = frameCount
        for sample in samples {
            if sample < threshold, sample > -threshold {
                if runStart == nil { runStart = position }
            } else if let start = runStart {
                if position - start >= Self.minimumFrames {
                    intervals.append(SilenceInterval(startFrame: start, endFrame: position))
                }
                runStart = nil
            }
            position += 1
        }
        frameCount = position
    }

    mutating func consume(_ samples: [Int16]) {
        samples.withUnsafeBufferPointer { consume($0) }
    }

    /// Closes a silence that reaches the end of the file; returns every interval.
    mutating func finish() -> [SilenceInterval] {
        if let start = runStart, frameCount - start >= Self.minimumFrames {
            intervals.append(SilenceInterval(startFrame: start, endFrame: frameCount))
        }
        runStart = nil
        return intervals
    }

    /// Every silence of a WAV, read 64 Ki frames at a time.
    static func detect(in reader: WAVReader) throws -> [SilenceInterval] {
        var detector = SilenceDetector()
        var buffer = [Int16](repeating: 0, count: 65_536)
        var frame = 0
        while frame < reader.frameCount {
            let read = try buffer.withUnsafeMutableBufferPointer { try reader.readFrames(at: frame, into: $0) }
            guard read > 0 else { break }
            buffer.withUnsafeBufferPointer { detector.consume(UnsafeBufferPointer(rebasing: $0[0 ..< read])) }
            frame += read
        }
        return detector.finish()
    }
}
