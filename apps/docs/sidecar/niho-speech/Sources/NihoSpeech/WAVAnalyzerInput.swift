import AVFoundation
import CoreMedia
import Speech

/// Frames of a WAV as `AnalyzerInput`s, read lazily one buffer at a time when
/// the analyzer pulls (constant memory on hour-long files). The samples go
/// in as they are: 16 kHz mono Int16 is the analyzer's best format for
/// SpeechTranscriber, so nothing is converted. Each buffer carries its
/// absolute start time, so results are timed in seconds of the whole WAV.
struct WAVAnalyzerInput: AsyncSequence, Sendable {
    typealias Element = AnalyzerInput

    let reader: WAVReader
    let frames: Range<Int>
    var framesPerBuffer = WAVFormat.sampleRate

    struct Iterator: AsyncIteratorProtocol {
        let reader: WAVReader
        let end: Int
        let framesPerBuffer: Int
        let format: AVAudioFormat?
        var position: Int

        mutating func next() async throws -> AnalyzerInput? {
            guard position < end else { return nil }
            let count = Swift.min(framesPerBuffer, end - position)
            guard let format,
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
                  let samples = buffer.int16ChannelData?[0]
            else {
                throw ToolError.internalError("cannot allocate a 16 kHz mono Int16 audio buffer")
            }
            let read = try reader.readFrames(at: position, into: UnsafeMutableBufferPointer(start: samples, count: count))
            guard read == count else {
                throw ToolError.inputUnreadable("\(reader.path) ended before its data chunk did")
            }
            buffer.frameLength = AVAudioFrameCount(count)
            let startTime = CMTime(value: CMTimeValue(position), timescale: CMTimeScale(WAVFormat.sampleRate))
            position += count
            return AnalyzerInput(buffer: buffer, bufferStartTime: startTime)
        }
    }

    func makeAsyncIterator() -> Iterator {
        Iterator(
            reader: reader,
            end: frames.upperBound,
            framesPerBuffer: Swift.max(1, framesPerBuffer),
            format: AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: Double(WAVFormat.sampleRate),
                channels: 1,
                interleaved: true
            ),
            position: frames.lowerBound
        )
    }
}
