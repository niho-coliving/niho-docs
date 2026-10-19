import Foundation
import Synchronization
import XCTest
@testable import NihoSpeech

/// A fresh directory under the system temporary directory, removed after the test.
func makeTemporaryDirectory(for testCase: XCTestCase) throws -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("niho-speech-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    testCase.addTeardownBlock {
        try? FileManager.default.removeItem(at: url)
    }
    return url
}

func fixtureURL(_ name: String, _ ext: String) throws -> URL {
    if name == "ja-sample", ext == "m4a" {
        guard let path = ProcessInfo.processInfo.environment["NIHO_SPEECH_TEST_FIXTURE"],
              FileManager.default.fileExists(atPath: path) else {
            throw XCTSkip("set NIHO_SPEECH_TEST_FIXTURE to the local ja-sample.m4a to run this test")
        }
        return URL(fileURLWithPath: path)
    }
    return try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "Fixtures"))
}

func littleEndianBytes(_ samples: [Int16]) -> [UInt8] {
    samples.flatMap { sample in withUnsafeBytes(of: sample.littleEndian) { Array($0) } }
}

/// A canonical 16 kHz mono 16-bit WAV of `samples`.
func writeWAV(_ samples: [Int16], to url: URL) throws {
    let bytes = WAVFormat.header(dataBytes: samples.count * 2) + littleEndianBytes(samples)
    try Data(bytes).write(to: url)
}

/// A WAV with any `fmt ` chunk and extra chunks, for the reader's tests.
func customWAV(
    formatTag: Int = 1,
    channels: Int = 1,
    sampleRate: Int = 16000,
    bitsPerSample: Int = 16,
    subFormat: [UInt8]? = nil,
    chunksBeforeFormat: [(String, [UInt8])] = [],
    chunksBeforeData: [(String, [UInt8])] = [],
    dataSize: Int? = nil,
    samples: [UInt8]
) -> [UInt8] {
    func le16(_ value: Int) -> [UInt8] { [UInt8(value & 0xFF), UInt8(value >> 8 & 0xFF)] }
    func le32(_ value: Int) -> [UInt8] { le16(value & 0xFFFF) + le16(value >> 16 & 0xFFFF) }
    func chunk(_ id: String, _ body: [UInt8], size: Int? = nil) -> [UInt8] {
        Array(id.utf8) + le32(size ?? body.count) + body + (body.count % 2 == 1 ? [0] : [])
    }
    let blockAlign = channels * bitsPerSample / 8
    var format = le16(formatTag) + le16(channels) + le32(sampleRate) + le32(sampleRate * blockAlign)
        + le16(blockAlign) + le16(bitsPerSample)
    if let subFormat {
        format += le16(22) + le16(bitsPerSample) + le32(4) + subFormat
    }
    var body = Array("WAVE".utf8)
    for (id, bytes) in chunksBeforeFormat { body += chunk(id, bytes) }
    body += chunk("fmt ", format)
    for (id, bytes) in chunksBeforeData { body += chunk(id, bytes) }
    body += Array("data".utf8) + le32(dataSize ?? samples.count) + samples
    return Array("RIFF".utf8) + le32(body.count) + body
}

/// Lines and notes a command printed.
final class CapturedOutput: Sendable {
    private let state = Mutex<(lines: [String], notes: [String])>(([], []))

    var lines: [String] { state.withLock { $0.lines } }
    var notes: [String] { state.withLock { $0.notes } }

    var output: Output {
        Output(
            line: { line in self.state.withLock { $0.lines.append(line) } },
            note: { note in self.state.withLock { $0.notes.append(note) } }
        )
    }
}

func jsonObject(_ line: String, file: StaticString = #filePath, line number: UInt = #line) throws -> [String: Any] {
    let object = try JSONSerialization.jsonObject(with: Data(line.utf8))
    return try XCTUnwrap(object as? [String: Any], "not a JSON object: \(line)", file: file, line: number)
}

/// What a run of the built `niho-speech` printed.
struct CLIResult {
    let status: Int32
    let stdout: String
    let stderr: String

    var lines: [String] {
        stdout.split(separator: "\n").map(String.init)
    }

    func objects() throws -> [[String: Any]] {
        try lines.map { try jsonObject($0) }
    }
}

enum CLI {
    /// SwiftPM builds the executable next to the test bundle.
    static var executable: URL {
        Bundle(for: BundleToken.self).bundleURL.deletingLastPathComponent().appendingPathComponent("niho-speech")
    }

    /// Runs the executable with stdout / stderr in files of `directory` (no pipe deadlocks).
    static func run(
        _ arguments: [String],
        in directory: URL,
        executable executableURL: URL = CLI.executable,
        environment: [String: String]? = nil
    ) throws -> CLIResult {
        let stdoutURL = directory.appendingPathComponent("stdout-\(UUID().uuidString).txt")
        let stderrURL = directory.appendingPathComponent("stderr-\(UUID().uuidString).txt")
        FileManager.default.createFile(atPath: stdoutURL.path, contents: nil)
        FileManager.default.createFile(atPath: stderrURL.path, contents: nil)
        defer {
            try? FileManager.default.removeItem(at: stdoutURL)
            try? FileManager.default.removeItem(at: stderrURL)
        }
        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments
        process.currentDirectoryURL = directory
        if let environment { process.environment = environment }
        let stdoutHandle = try FileHandle(forWritingTo: stdoutURL)
        let stderrHandle = try FileHandle(forWritingTo: stderrURL)
        process.standardOutput = stdoutHandle
        process.standardError = stderrHandle
        try process.run()
        process.waitUntilExit()
        try stdoutHandle.close()
        try stderrHandle.close()
        return CLIResult(
            status: process.terminationStatus,
            stdout: try String(contentsOf: stdoutURL, encoding: .utf8),
            stderr: try String(contentsOf: stderrURL, encoding: .utf8)
        )
    }
}

private final class BundleToken {}
