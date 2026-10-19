import AVFoundation
import CoreMedia
import Foundation

/// Decodes every audio track of an AVFoundation-readable audio or video file
/// to 16 kHz mono 16-bit PCM and streams it to a WAV (constant memory: one
/// decoded buffer at a time).
///
/// Two adjustments for parity with the API's `ffmpeg -ac 1 -ar 16000 -sample_fmt s16`:
/// - A source with more than one channel is read as 16 kHz stereo and
///   averaged, (L + R) / 2 like ffmpeg: AVFoundation's own mono mix is
///   (L + R) / √2, 3 dB louder, which would move the -35 dB silence
///   threshold. (AVFoundation folds more than two channels to stereo first.)
/// - The reader's sample-rate converter is not flushed and drops its last
///   ~16 source samples: the WAV is padded with silence up to the end of the
///   audio tracks (at most 10 ms), so its duration is the source's. The
///   start is not shifted (checked against ffmpeg).
enum AudioConverter {
    static let maximumTailPadding = WAVFormat.sampleRate / 100

    /// `AVAssetReaderAudioMixOutput` settings: linear PCM, 16000 Hz, 16-bit
    /// signed integer, little-endian, interleaved, with 1 or 2 channels.
    static func outputSettings(channels: Int) -> [String: Any] {
        var layout = AudioChannelLayout()
        layout.mChannelLayoutTag = channels == 1 ? kAudioChannelLayoutTag_Mono : kAudioChannelLayoutTag_Stereo
        return [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: WAVFormat.sampleRate,
            AVNumberOfChannelsKey: channels,
            AVChannelLayoutKey: Data(bytes: &layout, count: MemoryLayout<AudioChannelLayout>.size),
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
    }

    /// Writes `output` (replacing it) and returns its frame count. Missing
    /// input → `input_not_found`; no audio track or a decoder failure →
    /// `input_unreadable`; no samples → `input_empty`; more than
    /// `InputLimits` (2 GiB, 6 hours) → `input_too_large`; the output →
    /// `write_failed`. `output` is untouched on failure.
    static func convert(input: String, output: String) async throws -> Int {
        let bytes = try InputFile.byteCount(input)
        guard bytes <= InputLimits.maximumFileBytes else {
            throw ToolError.inputTooLarge(
                "\(input) is \(bytes) bytes; the limit is \(InputLimits.maximumFileBytes) bytes (2 GiB)"
            )
        }
        let asset = AVURLAsset(url: URL(fileURLWithPath: input))
        let tracks: [AVAssetTrack]
        do {
            tracks = try await asset.loadTracks(withMediaType: .audio)
        } catch {
            throw ToolError.inputUnreadable("cannot read \(input) as audio or video: \(ErrorText.describe(error))")
        }
        guard !tracks.isEmpty else {
            throw ToolError.inputUnreadable("\(input) has no audio track")
        }
        let channels = await sourceChannelCount(tracks) > 1 ? 2 : 1
        let endFrame = await audioEndFrame(asset: asset, tracks: tracks)
        // Refuse before decoding when the container already says it is too long
        // (the loop below catches a source whose length is unknown).
        if let endFrame, endFrame > InputLimits.maximumFrames {
            throw durationLimit(input)
        }
        func decodeFailure(_ reason: String) -> ToolError {
            endFrame == 0
                ? ToolError.inputEmpty("\(input) has no audio samples")
                : ToolError.inputUnreadable("cannot decode \(input): \(reason)")
        }

        let reader: AVAssetReader
        do {
            reader = try AVAssetReader(asset: asset)
        } catch {
            throw decodeFailure(ErrorText.describe(error))
        }
        let mix = AVAssetReaderAudioMixOutput(audioTracks: tracks, audioSettings: outputSettings(channels: channels))
        mix.alwaysCopiesSampleData = false
        guard reader.canAdd(mix) else {
            throw decodeFailure("the audio cannot be decoded to 16 kHz PCM")
        }
        reader.add(mix)
        guard reader.startReading() else {
            throw decodeFailure(reader.error.map(ErrorText.describe) ?? "the reader did not start")
        }

        let writer = try WAVWriter(destination: output)
        do {
            var scratch: [UInt8] = []
            while let sampleBuffer = mix.copyNextSampleBuffer() {
                try autoreleasepool {
                    try append(sampleBuffer, channels: channels, to: writer, scratch: &scratch)
                }
                if writer.frameCount > InputLimits.maximumFrames {
                    throw durationLimit(input)
                }
            }
            guard reader.status == .completed else {
                throw decodeFailure(reader.error.map(ErrorText.describe) ?? "the reader stopped (\(reader.status.rawValue))")
            }
            guard writer.frameCount > 0 else {
                throw ToolError.inputEmpty("\(input) has no audio samples")
            }
            // The frames the reader's resampler did not flush (see above).
            let missing = (endFrame ?? 0) - writer.frameCount
            if missing > 0, missing <= maximumTailPadding {
                let silence = [UInt8](repeating: 0, count: missing * WAVFormat.bytesPerFrame)
                try silence.withUnsafeBytes { try writer.append($0) }
            }
            try writer.commit()
            return writer.frameCount
        } catch {
            reader.cancelReading()
            writer.discard()
            throw error
        }
    }

    private static func durationLimit(_ input: String) -> ToolError {
        ToolError.inputTooLarge(
            "\(input) is longer than \(InputLimits.maximumDurationSec) seconds (6 hours), the limit for one input"
        )
    }

    /// The most channels any track has (0 when unknown).
    private static func sourceChannelCount(_ tracks: [AVAssetTrack]) async -> Int {
        var channels = 0
        for track in tracks {
            guard let descriptions = try? await track.load(.formatDescriptions) else { continue }
            for description in descriptions {
                if let format = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee {
                    channels = max(channels, Int(format.mChannelsPerFrame))
                }
            }
        }
        return channels
    }

    /// Where the audio tracks end on the 16 kHz timeline, or nil when unknown.
    private static func audioEndFrame(asset: AVURLAsset, tracks: [AVAssetTrack]) async -> Int? {
        var end: Double?
        for track in tracks {
            guard let range = try? await track.load(.timeRange), range.end.isNumeric else { return nil }
            end = max(end ?? 0, range.end.seconds)
        }
        if let duration = try? await asset.load(.duration), duration.isNumeric, let trackEnd = end {
            end = min(trackEnd, duration.seconds)
        }
        guard let end, end.isFinite, end >= 0 else { return nil }
        return WAVFormat.frame(seconds: end)
    }

    private static func append(
        _ sampleBuffer: CMSampleBuffer,
        channels: Int,
        to writer: WAVWriter,
        scratch: inout [UInt8]
    ) throws {
        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        try requireOutputFormat(sampleBuffer, channels: channels)
        let length = CMBlockBufferGetDataLength(block)
        guard length > 0 else { return }
        if scratch.count < length {
            scratch = [UInt8](repeating: 0, count: length)
        }
        try scratch.withUnsafeMutableBytes { raw in
            guard CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
                == kCMBlockBufferNoErr
            else {
                throw ToolError.inputUnreadable("cannot copy decoded audio")
            }
            let frames = length / (channels * WAVFormat.bytesPerFrame)
            if channels == 2 {
                // In place: frame f is written after samples 2f and 2f + 1 are read.
                raw.withMemoryRebound(to: Int16.self) { samples in
                    for frame in 0 ..< frames {
                        samples[frame] = averageOf(
                            Int16(littleEndian: samples[2 * frame]),
                            Int16(littleEndian: samples[2 * frame + 1])
                        ).littleEndian
                    }
                }
            }
            try writer.append(UnsafeRawBufferPointer(rebasing: raw[0 ..< frames * WAVFormat.bytesPerFrame]))
        }
    }

    /// ffmpeg's stereo-to-mono: 0.5 · L + 0.5 · R, rounded half to even (`lrintf`).
    static func averageOf(_ left: Int16, _ right: Int16) -> Int16 {
        Int16((Double(Int32(left) + Int32(right)) / 2).rounded(.toNearestOrEven))
    }

    /// The reader promises the settings; check anyway before writing bytes as 16 kHz s16.
    private static func requireOutputFormat(_ sampleBuffer: CMSampleBuffer, channels: Int) throws {
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let format = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
              format.mFormatID == kAudioFormatLinearPCM,
              format.mSampleRate == Double(WAVFormat.sampleRate),
              format.mChannelsPerFrame == UInt32(channels),
              format.mBitsPerChannel == 16,
              format.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0,
              format.mFormatFlags & (kAudioFormatFlagIsFloat | kAudioFormatFlagIsBigEndian | kAudioFormatFlagIsNonInterleaved) == 0
        else {
            throw ToolError.internalError("the decoder did not return 16 kHz 16-bit little-endian interleaved PCM")
        }
    }
}
