import XCTest
@testable import NihoSpeech

/// `slice`: a chunk file holds exactly the frames `transcribe --start --end` reads.
final class SliceTests: XCTestCase {
    /// 2.5 s of a ramp so every frame is distinguishable.
    private let samples: [Int16] = (0 ..< 40_000).map { Int16(truncatingIfNeeded: $0 * 7 - 30_000) }

    private func slice(_ arguments: [String]) async -> (status: Int32, lines: [String]) {
        let captured = CapturedOutput()
        let status = await NihoSpeechCLI.run(["slice"] + arguments, output: captured.output)
        return (status, captured.lines)
    }

    func testCopiesTheRangeToACanonicalWAV() async throws {
        let directory = try makeTemporaryDirectory(for: self)
        let input = directory.appendingPathComponent("a.wav")
        let output = directory.appendingPathComponent("chunk.wav")
        try writeWAV(samples, to: input)

        let result = await slice(["--input", input.path, "--output", output.path, "--start", "0.5", "--end=1.25"])
        XCTAssertEqual(result.status, 0, "\(result.lines)")
        XCTAssertEqual(result.lines, [#"{"durationSec":0.75}"#])

        let data = try Data(contentsOf: output)
        XCTAssertEqual(Array(data.prefix(WAVFormat.headerSize)), WAVFormat.header(dataBytes: 12_000 * 2))
        XCTAssertEqual(Array(data.dropFirst(WAVFormat.headerSize)), littleEndianBytes(Array(samples[8_000 ..< 20_000])))
        // Nothing but the chunk is left next to it.
        XCTAssertEqual(
            Set(try FileManager.default.contentsOfDirectory(atPath: directory.path)),
            ["a.wav", "chunk.wav"]
        )
    }

    func testDefaultsAndThePrintedDurationCopyToTheLastFrame() async throws {
        let directory = try makeTemporaryDirectory(for: self)
        let input = directory.appendingPathComponent("a.wav")
        let whole = directory.appendingPathComponent("whole.wav")
        let tail = directory.appendingPathComponent("tail.wav")
        // 40 003 frames = 2.5001875 s, printed as 2.5: the end at 2.5 still reads the last 3 frames.
        let odd = samples + [1, 2, 3]
        try writeWAV(odd, to: input)

        let wholeResult = await slice(["--input", input.path, "--output", whole.path])
        XCTAssertEqual(wholeResult.status, 0, "\(wholeResult.lines)")
        XCTAssertEqual(try Data(contentsOf: whole), try Data(contentsOf: input))

        let tailResult = await slice(["--input", input.path, "--output", tail.path, "--start", "2", "--end", "2.5"])
        XCTAssertEqual(tailResult.status, 0, "\(tailResult.lines)")
        XCTAssertEqual(try WAVReader(path: tail.path).frameCount, 40_003 - 32_000)
    }

    /// Adjacent chunks sliced at the same cut add up to the whole file.
    func testAdjacentChunksAreContiguous() async throws {
        let directory = try makeTemporaryDirectory(for: self)
        let input = directory.appendingPathComponent("a.wav")
        try writeWAV(samples, to: input)
        let cuts = [0, 0.73, 1.61, 2.5]
        var joined: [UInt8] = []
        for (index, (start, end)) in zip(cuts, cuts.dropFirst()).enumerated() {
            let chunk = directory.appendingPathComponent("chunk-\(index).wav")
            let result = await slice(["--input", input.path, "--output", chunk.path, "--start", "\(start)", "--end", "\(end)"])
            XCTAssertEqual(result.status, 0, "\(result.lines)")
            joined += Array(try Data(contentsOf: chunk).dropFirst(WAVFormat.headerSize))
        }
        XCTAssertEqual(joined, littleEndianBytes(samples))
    }

    func testErrors() async throws {
        let directory = try makeTemporaryDirectory(for: self)
        let input = directory.appendingPathComponent("a.wav")
        let output = directory.appendingPathComponent("chunk.wav")
        try writeWAV(samples, to: input)
        let notWAV = directory.appendingPathComponent("note.txt")
        try Data("hello".utf8).write(to: notWAV)

        let cases: [([String], String, Int32)] = [
            (["--input", directory.appendingPathComponent("missing.wav").path, "--output", output.path], "input_not_found", 3),
            (["--input", notWAV.path, "--output", output.path], "input_format", 3),
            (["--input", input.path, "--output", output.path, "--start", "3"], "invalid_range", 3),
            (["--input", input.path, "--output", output.path, "--start", "1", "--end", "1"], "invalid_range", 3),
            (["--input", input.path, "--output", output.path, "--start", "-1"], "invalid_range", 3),
            (["--input", input.path, "--output", directory.appendingPathComponent("no/such/dir/c.wav").path], "write_failed", 1),
        ]
        for (arguments, code, exitCode) in cases {
            let result = await slice(arguments)
            XCTAssertEqual(result.status, exitCode, "\(arguments)")
            XCTAssertEqual(result.lines.count, 1, "\(arguments)")
            let line = try jsonObject(result.lines[0])
            XCTAssertEqual(line["code"] as? String, code, "\(arguments)")
        }
        // No chunk and no temporary file are left behind.
        XCTAssertEqual(
            Set(try FileManager.default.contentsOfDirectory(atPath: directory.path)),
            ["a.wav", "note.txt"]
        )
    }
}
