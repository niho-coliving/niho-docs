@preconcurrency import AVFoundation
import Darwin
import Foundation
import System

/// The recording's working file (`record`, #18590): a CAF of 24 kHz mono
/// 16-bit little-endian PCM written straight to disk.
///
/// The data chunk's size stays -1 while recording (CAF: the last chunk runs
/// to the end of the file), so a file cut off by a crash or SIGKILL is a
/// valid CAF of everything written so far (`convert` and AVAudioFile read
/// it). `close()` writes the real size.
final class CAFWriter {
    static let sampleRate = 24_000
    static let bytesPerFrame = 2
    /// File header (8) + `desc` chunk (12 + 32) + `data` chunk header (12) + edit count (4).
    static let headerBytes = 68
    /// Where the `data` chunk's size (Int64, big-endian) is.
    private static let dataSizeOffset: Int64 = 56
    /// fsync about every 10 s of audio (the page cache already survives a crash of this process).
    private static let syncEveryBytes = 10 * sampleRate * bytesPerFrame

    let path: String
    private var descriptor: FileDescriptor?
    private(set) var dataBytes = 0
    private var unsyncedBytes = 0

    var frameCount: Int { dataBytes / Self.bytesPerFrame }

    /// Creates `path`; an existing file is never replaced (`write_failed`).
    init(path: String) throws {
        self.path = path
        do {
            descriptor = try FileDescriptor.open(
                FilePath(path), .writeOnly,
                options: [.create, .exclusiveCreate, .closeOnExec],
                permissions: [.ownerReadWrite, .groupRead, .otherRead]
            )
            try descriptor?.writeAll(Self.header(dataBytes: nil))
        } catch {
            if let descriptor { try? descriptor.close() }
            descriptor = nil
            throw ToolError.writeFailed("cannot create \(path): \(error)")
        }
    }

    deinit {
        if let descriptor { try? descriptor.close() }
    }

    /// The header for `dataBytes` of samples, or for a data chunk running to the end of the file (nil).
    static func header(dataBytes: Int?) -> [UInt8] {
        func be32(_ value: UInt32) -> [UInt8] { withUnsafeBytes(of: value.bigEndian) { Array($0) } }
        func be64(_ value: UInt64) -> [UInt8] { withUnsafeBytes(of: value.bigEndian) { Array($0) } }
        var bytes = Array("caff".utf8) + [0, 1, 0, 0] // version 1, flags 0
        bytes += Array("desc".utf8) + be64(32)
        bytes += be64(Double(sampleRate).bitPattern)
        bytes += Array("lpcm".utf8)
        bytes += be32(2) // kCAFLinearPCMFormatFlagIsLittleEndian (integer)
        bytes += be32(UInt32(bytesPerFrame)) + be32(1) + be32(1) + be32(16)
        let size = dataBytes.map { UInt64($0 + 4) } ?? UInt64.max // -1: to the end of the file
        bytes += Array("data".utf8) + be64(size)
        bytes += be32(0) // edit count
        return bytes
    }

    /// Whole 16-bit frames, little-endian.
    func append(_ bytes: UnsafeRawBufferPointer) throws {
        guard let descriptor else { throw ToolError.internalError("CAF writer used after close") }
        do {
            try descriptor.writeAll(bytes)
        } catch {
            throw ToolError.writeFailed("cannot write \(path): \(error)")
        }
        dataBytes += bytes.count
        unsyncedBytes += bytes.count
        if unsyncedBytes >= Self.syncEveryBytes {
            unsyncedBytes = 0
            _ = fsync(descriptor.rawValue)
        }
    }

    /// Writes the real size of the data chunk and closes the file.
    func close() throws {
        guard let descriptor else { return }
        self.descriptor = nil
        do {
            let size = withUnsafeBytes(of: UInt64(dataBytes + 4).bigEndian) { Array($0) }
            try descriptor.writeAll(toAbsoluteOffset: Self.dataSizeOffset, size)
            _ = fsync(descriptor.rawValue)
            try descriptor.close()
        } catch {
            try? descriptor.close()
            throw ToolError.writeFailed("cannot finish \(path): \(error)")
        }
    }
}

/// One level line: RMS of the last 0.2 s in dBFS (`LevelMeter.silenceDB` for
/// digital silence) and the recorded length so far.
struct LevelReading: Equatable {
    var db: Double
    var durationSec: Double
}

/// RMS over windows of `windowFrames` samples (0.2 s at 24 kHz).
struct LevelMeter {
    static let windowFrames = CAFWriter.sampleRate / 5
    static let silenceDB = -160.0

    private var sumOfSquares = 0.0
    private var count = 0

    /// Adds samples; returns the dBFS of each window they complete.
    mutating func add(_ samples: UnsafeBufferPointer<Int16>) -> [Double] {
        var levels: [Double] = []
        for sample in samples {
            let value = Double(sample) / 32768
            sumOfSquares += value * value
            count += 1
            if count == Self.windowFrames {
                levels.append(Self.dB(meanSquare: sumOfSquares / Double(count)))
                sumOfSquares = 0
                count = 0
            }
        }
        return levels
    }

    static func dB(meanSquare: Double) -> Double {
        guard meanSquare > 0 else { return silenceDB }
        return max(silenceDB, 10 * log10(meanSquare))
    }
}

/// The core of `record`: takes the input's buffers in whatever format the
/// device delivers, converts them to 24 kHz mono 16-bit (channels mixed down),
/// appends them to the CAF and reports the level every 0.2 s of audio.
/// Not thread-safe (the caller serializes).
final class RecordingWriter {
    static let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: Double(CAFWriter.sampleRate), channels: 1, interleaved: true
    )!

    let caf: CAFWriter
    private let onLevel: (LevelReading) -> Void
    private var converter: AVAudioConverter?
    private var meter = LevelMeter()

    /// Level lines are held back until the command printed `started` (the audio is kept).
    var reportsLevels = true

    var frameCount: Int { caf.frameCount }
    var durationSec: Double { Double(caf.frameCount) / Double(CAFWriter.sampleRate) }

    init(caf: CAFWriter, onLevel: @escaping (LevelReading) -> Void) {
        self.caf = caf
        self.onLevel = onLevel
    }

    /// The input's format: at the start, and again when the device changes
    /// (the previous converter is flushed first, so its last samples are kept).
    func setInputFormat(_ format: AVAudioFormat) throws {
        if converter?.inputFormat == format { return }
        try flush()
        guard format.channelCount > 0, format.sampleRate > 0,
              let converter = AVAudioConverter(from: format, to: Self.outputFormat)
        else {
            throw ToolError.recordingFailed("cannot convert the input (\(format)) to 24 kHz mono PCM")
        }
        converter.downmix = true
        self.converter = converter
    }

    /// A buffer in a format other than the converter's (the device changed
    /// before the input said so) gets a new converter first.
    func append(_ buffer: AVAudioPCMBuffer) throws {
        guard buffer.frameLength > 0 else { return }
        if converter?.inputFormat != buffer.format {
            try setInputFormat(buffer.format)
        }
        guard let converter else { throw ToolError.internalError("recording writer has no input format") }
        let source = OneBuffer(buffer)
        try convert(with: converter, capacity: capacity(for: buffer.frameLength, from: converter)) { source.next($0) }
    }

    /// Flushes the converter and closes the CAF; the frames written.
    func finish() throws -> Int {
        try flush()
        try caf.close()
        return caf.frameCount
    }

    /// Drains the samples the converter still holds (the resampler's latency).
    private func flush() throws {
        guard let converter else { return }
        self.converter = nil
        try convert(with: converter, capacity: 4096) { status in
            status.pointee = .endOfStream
            return nil
        }
    }

    private func capacity(for frames: AVAudioFrameCount, from converter: AVAudioConverter) -> AVAudioFrameCount {
        let ratio = Self.outputFormat.sampleRate / converter.inputFormat.sampleRate
        return AVAudioFrameCount((Double(frames) * ratio).rounded(.up)) + 1024
    }

    private func convert(
        with converter: AVAudioConverter,
        capacity: AVAudioFrameCount,
        input: @escaping @Sendable (UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer?
    ) throws {
        guard let out = AVAudioPCMBuffer(pcmFormat: Self.outputFormat, frameCapacity: capacity) else {
            throw ToolError.internalError("cannot allocate a conversion buffer")
        }
        while true {
            out.frameLength = 0
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { _, inputStatus in input(inputStatus) }
            if status == .error {
                throw ToolError.recordingFailed("cannot convert the input: \(error.map(ErrorText.describe) ?? "unknown error")")
            }
            try write(out)
            // haveData: the output was full and the converter has more; anything else: done for now.
            guard status == .haveData, out.frameLength > 0 else { return }
        }
    }

    private func write(_ buffer: AVAudioPCMBuffer) throws {
        let frames = Int(buffer.frameLength)
        guard frames > 0, let samples = buffer.int16ChannelData?[0] else { return }
        let pointer = UnsafeBufferPointer(start: samples, count: frames)
        #if _endian(big)
        let littleEndian = pointer.map(\.littleEndian)
        try littleEndian.withUnsafeBytes { try caf.append($0) }
        #else
        try caf.append(UnsafeRawBufferPointer(pointer))
        #endif
        let before = caf.frameCount - frames
        for (index, db) in meter.add(pointer).enumerated() where reportsLevels {
            // The window ends at a multiple of 0.2 s of the whole recording.
            let end = (before / LevelMeter.windowFrames + index + 1) * LevelMeter.windowFrames
            onLevel(LevelReading(db: db, durationSec: Double(end) / Double(CAFWriter.sampleRate)))
        }
    }
}

/// The converter's input for one buffer: the buffer once, then "no data now"
/// (the converter keeps what it has not used yet for the next call).
/// The converter calls it synchronously inside `convert`.
private final class OneBuffer: @unchecked Sendable {
    private let buffer: AVAudioPCMBuffer
    private var supplied = false

    init(_ buffer: AVAudioPCMBuffer) {
        self.buffer = buffer
    }

    func next(_ status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
        guard !supplied else {
            status.pointee = .noDataNow
            return nil
        }
        supplied = true
        status.pointee = .haveData
        return buffer
    }
}

/// Exports the CAF to AAC (`.m4a`, mono 24 kHz, about 48 kbps): a temporary
/// file next to `output` (`.<name>.partial-<pid>.m4a`), moved over it when
/// complete. Returns the frames read from the CAF.
enum RecordingExporter {
    static let bitRate = 48_000
    private static let chunkFrames: AVAudioFrameCount = 96_000 // 4 s

    static func export(caf: String, to output: String) throws -> Int {
        let source: AVAudioFile
        do {
            source = try AVAudioFile(forReading: URL(fileURLWithPath: caf))
        } catch {
            throw ToolError.writeFailed("cannot read \(caf): \(ErrorText.describe(error))")
        }
        let destination = FilePath(output)
        guard let name = destination.lastComponent else {
            throw ToolError.writeFailed("--output must name a file (got '\(output)')")
        }
        let stem = name.stem
        let temporary = destination.removingLastComponent().appending(".\(stem).partial-\(getpid()).m4a").string
        unlink(temporary)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: Double(CAFWriter.sampleRate),
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: bitRate,
        ]
        var frames = 0
        do {
            let target = try AVAudioFile(
                forWriting: URL(fileURLWithPath: temporary), settings: settings,
                commonFormat: source.processingFormat.commonFormat, interleaved: source.processingFormat.isInterleaved
            )
            guard let buffer = AVAudioPCMBuffer(pcmFormat: source.processingFormat, frameCapacity: chunkFrames) else {
                throw ToolError.internalError("cannot allocate an export buffer")
            }
            while source.framePosition < source.length {
                try source.read(into: buffer, frameCount: chunkFrames)
                guard buffer.frameLength > 0 else { break }
                try target.write(from: buffer)
                frames += Int(buffer.frameLength)
            }
            target.close()
        } catch {
            unlink(temporary)
            throw error as? ToolError ?? ToolError.writeFailed("cannot export \(caf) to AAC: \(ErrorText.describe(error))")
        }
        guard rename(temporary, output) == 0 else {
            let reason = String(cString: strerror(errno))
            unlink(temporary)
            throw ToolError.writeFailed("cannot move the recording to \(output): \(reason)")
        }
        return frames
    }
}
