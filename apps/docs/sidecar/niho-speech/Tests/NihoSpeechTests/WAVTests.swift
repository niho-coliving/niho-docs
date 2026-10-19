import AVFoundation
import Speech
import XCTest
@testable import NihoSpeech

final class WAVTests: XCTestCase {
    private func assertInputFormat(_ bytes: [UInt8], _ message: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let url = try makeTemporaryDirectory(for: self).appendingPathComponent("x.wav")
        try Data(bytes).write(to: url)
        XCTAssertThrowsError(try WAVReader(path: url.path), message, file: file, line: line) { error in
            XCTAssertEqual((error as? ToolError)?.code, "input_format", message, file: file, line: line)
            XCTAssertEqual((error as? ToolError)?.exitCode, 3, message, file: file, line: line)
        }
    }

    func testCanonicalHeader() {
        let header = WAVFormat.header(dataBytes: 6)
        XCTAssertEqual(header.count, 44)
        XCTAssertEqual(header, [
            0x52, 0x49, 0x46, 0x46, 42, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, // RIFF, 36 + 6, WAVE
            0x66, 0x6D, 0x74, 0x20, 16, 0, 0, 0, 1, 0, 1, 0, // fmt , 16, PCM, mono
            0x80, 0x3E, 0, 0, 0x00, 0x7D, 0, 0, 2, 0, 16, 0, // 16000 Hz, 32000 B/s, align 2, 16 bits
            0x64, 0x61, 0x74, 0x61, 6, 0, 0, 0, // data, 6
        ])
    }

    func testFrameMapping() {
        XCTAssertEqual(WAVFormat.frame(seconds: 7.36), 117_760)
        XCTAssertEqual(WAVFormat.frame(seconds: 897.3), 14_356_800)
        XCTAssertEqual(WAVFormat.frame(seconds: 0.00003), 0)
        XCTAssertEqual(WAVFormat.frame(seconds: 0.00004), 1)
        XCTAssertEqual(WAVFormat.seconds(frames: 213_536), 13.346)
    }

    func testWriterStreamsThenReplacesTheDestination() throws {
        let directory = try makeTemporaryDirectory(for: self)
        let destination = directory.appendingPathComponent("out.wav")
        try Data("old".utf8).write(to: destination)

        let writer = try WAVWriter(destination: destination.path)
        XCTAssertEqual(URL(fileURLWithPath: writer.temporaryPath).deletingLastPathComponent().path, directory.path)
        XCTAssertTrue(URL(fileURLWithPath: writer.temporaryPath).lastPathComponent.hasPrefix(".out.wav.partial-"))
        let first = littleEndianBytes([1, -2, 3])
        let second = littleEndianBytes([32767, -32768])
        try first.withUnsafeBytes { try writer.append($0) }
        // The destination is untouched until commit.
        XCTAssertEqual(try Data(contentsOf: destination), Data("old".utf8))
        try second.withUnsafeBytes { try writer.append($0) }
        XCTAssertEqual(writer.frameCount, 5)
        try writer.commit()

        let bytes = try [UInt8](Data(contentsOf: destination))
        XCTAssertEqual(bytes.count, 44 + 10)
        XCTAssertEqual(Array(bytes[0 ..< 44]), WAVFormat.header(dataBytes: 10))
        XCTAssertEqual(Array(bytes[44...]), first + second)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["out.wav"])

        let reader = try WAVReader(path: destination.path)
        XCTAssertEqual(reader.frameCount, 5)
        XCTAssertEqual(reader.dataOffset, 44)
    }

    func testWriterDiscardLeavesNothing() throws {
        let directory = try makeTemporaryDirectory(for: self)
        let destination = directory.appendingPathComponent("out.wav")
        let writer = try WAVWriter(destination: destination.path)
        try littleEndianBytes([1, 2]).withUnsafeBytes { try writer.append($0) }
        writer.discard()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }

    func testWriterFailures() throws {
        let directory = try makeTemporaryDirectory(for: self)
        for destination in [directory.appendingPathComponent("missing/out.wav").path, directory.path + "/"] {
            XCTAssertThrowsError(try WAVWriter(destination: destination), destination) { error in
                XCTAssertEqual((error as? ToolError)?.code, "write_failed", destination)
                XCTAssertEqual((error as? ToolError)?.exitCode, 1, destination)
            }
        }
        // A directory in the way of the final rename.
        let blocked = directory.appendingPathComponent("blocked.wav")
        try FileManager.default.createDirectory(at: blocked, withIntermediateDirectories: false)
        try FileManager.default.createDirectory(
            at: blocked.appendingPathComponent("child"), withIntermediateDirectories: false
        )
        let writer = try WAVWriter(destination: blocked.path)
        try littleEndianBytes([1]).withUnsafeBytes { try writer.append($0) }
        XCTAssertThrowsError(try writer.commit()) { error in
            XCTAssertEqual((error as? ToolError)?.code, "write_failed")
        }
        writer.discard()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["blocked.wav"])
    }

    func testReaderReadsFrameRanges() throws {
        let url = try makeTemporaryDirectory(for: self).appendingPathComponent("a.wav")
        let samples: [Int16] = [0, 1, -1, 300, -300, 32767, -32768, 42]
        try writeWAV(samples, to: url)
        let reader = try WAVReader(path: url.path)
        XCTAssertEqual(reader.frameCount, 8)
        XCTAssertEqual(reader.durationSec, 0.0005)
        var buffer = [Int16](repeating: 9, count: 4)
        XCTAssertEqual(try buffer.withUnsafeMutableBufferPointer { try reader.readFrames(at: 3, into: $0) }, 4)
        XCTAssertEqual(buffer, [300, -300, 32767, -32768])
        XCTAssertEqual(try buffer.withUnsafeMutableBufferPointer { try reader.readFrames(at: 6, into: $0) }, 2)
        XCTAssertEqual(Array(buffer[0 ..< 2]), [-32768, 42])
        XCTAssertEqual(try buffer.withUnsafeMutableBufferPointer { try reader.readFrames(at: 8, into: $0) }, 0)
    }

    func testReaderAcceptsExtensibleOddChunksAndShortData() throws {
        let directory = try makeTemporaryDirectory(for: self)
        let samples = littleEndianBytes([5, 6, 7])
        let pcm: [UInt8] = [1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71]
        let variants: [(String, [UInt8], Int)] = [
            ("extensible", customWAV(formatTag: 0xFFFE, subFormat: pcm, samples: samples), 3),
            ("odd chunks", customWAV(
                chunksBeforeFormat: [("LIST", [1, 2, 3])],
                chunksBeforeData: [("junk", [9]), ("fact", [0, 0, 0, 0])],
                samples: samples
            ), 3),
            // A placeholder data size larger than the file (a streaming writer's).
            ("long data size", customWAV(dataSize: 0x7FFF_FFF0, samples: samples), 3),
            ("odd data size", customWAV(dataSize: 5, samples: samples), 2),
        ]
        for (name, bytes, frames) in variants {
            let url = directory.appendingPathComponent("\(name).wav")
            try Data(bytes).write(to: url)
            let reader = try WAVReader(path: url.path)
            XCTAssertEqual(reader.frameCount, frames, name)
            var buffer = [Int16](repeating: 0, count: frames)
            _ = try buffer.withUnsafeMutableBufferPointer { try reader.readFrames(at: 0, into: $0) }
            XCTAssertEqual(buffer, Array([5, 6, 7][0 ..< frames]), name)
        }
    }

    func testReaderRejectsOtherFormats() throws {
        let samples = littleEndianBytes([1, 2])
        let float: [UInt8] = [3, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71]
        try assertInputFormat(customWAV(sampleRate: 44100, samples: samples), "44.1 kHz")
        try assertInputFormat(customWAV(sampleRate: 8000, samples: samples), "8 kHz")
        try assertInputFormat(customWAV(channels: 2, samples: samples), "stereo")
        try assertInputFormat(customWAV(bitsPerSample: 24, samples: [0, 0, 0]), "24-bit")
        try assertInputFormat(customWAV(formatTag: 3, bitsPerSample: 32, samples: [0, 0, 0, 0]), "float")
        try assertInputFormat(customWAV(formatTag: 0xFFFE, subFormat: float, samples: samples), "extensible float")
        try assertInputFormat(Array("not a wav file at all".utf8), "text")
        try assertInputFormat([], "empty file")
        try assertInputFormat(Array("RIFF".utf8), "truncated")
        try assertInputFormat(Array("RIFF\u{4}\0\0\0WAVE".utf8), "no chunks")
        let noData = Array(customWAV(samples: []).dropLast(8))
        try assertInputFormat(noData, "no data chunk")
    }

    func testReaderInputErrors() throws {
        let directory = try makeTemporaryDirectory(for: self)
        XCTAssertThrowsError(try WAVReader(path: directory.appendingPathComponent("missing.wav").path)) { error in
            XCTAssertEqual((error as? ToolError)?.code, "input_not_found")
            XCTAssertEqual((error as? ToolError)?.exitCode, 3)
        }
        XCTAssertThrowsError(try WAVReader(path: directory.path)) { error in
            XCTAssertEqual((error as? ToolError)?.code, "input_unreadable")
        }
    }

    /// The analyzer's input: the requested frames, one-second buffers, each at
    /// its absolute time in the WAV.
    func testAnalyzerInputReadsTheRangeWithAbsoluteTimes() async throws {
        let url = try makeTemporaryDirectory(for: self).appendingPathComponent("a.wav")
        let samples = (0 ..< 40_000).map { Int16(truncatingIfNeeded: $0) }
        try writeWAV(samples, to: url)
        let input = WAVAnalyzerInput(reader: try WAVReader(path: url.path), frames: 8000 ..< 39_000)
        var starts: [Double] = []
        var lengths: [Int] = []
        var read: [Int16] = []
        for try await element in input {
            starts.append(try XCTUnwrap(element.bufferStartTime).seconds)
            // `AnalyzerInput.buffer` returns a new wrapper on every access and
            // its channel pointers live only as long as that wrapper.
            let buffer = element.buffer
            try withExtendedLifetime(buffer) {
                lengths.append(Int(buffer.frameLength))
                XCTAssertEqual(buffer.format.sampleRate, 16000)
                XCTAssertEqual(buffer.format.channelCount, 1)
                XCTAssertEqual(buffer.format.commonFormat, .pcmFormatInt16)
                let channel = try XCTUnwrap(buffer.int16ChannelData?[0])
                read += UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength))
            }
        }
        XCTAssertEqual(starts, [0.5, 1.5])
        XCTAssertEqual(lengths, [16000, 15000])
        XCTAssertEqual(read, Array(samples[8000 ..< 39_000]))
    }
}
