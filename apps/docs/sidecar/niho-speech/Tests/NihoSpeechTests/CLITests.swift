import XCTest
@testable import NihoSpeech

/// The built executable: exit codes, stdout lines, nothing on stderr.
/// None of these needs the speech model.
final class CLITests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = try makeTemporaryDirectory(for: self)
        let path = CLI.executable.path
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: path), "not built: \(path)")
    }

    private func assertError(
        _ arguments: [String], code: String, status: Int32,
        file: StaticString = #filePath, line: UInt = #line
    ) throws {
        let result = try CLI.run(arguments, in: directory)
        XCTAssertEqual(result.status, status, result.stdout, file: file, line: line)
        XCTAssertEqual(result.lines.count, 1, result.stdout, file: file, line: line)
        let error = try jsonObject(result.lines.first ?? "")
        XCTAssertEqual(error["type"] as? String, "error", file: file, line: line)
        XCTAssertEqual(error["code"] as? String, code, file: file, line: line)
        XCTAssertFalse((error["message"] as? String ?? "").isEmpty, file: file, line: line)
        XCTAssertEqual(result.stderr, "", file: file, line: line)
    }

    func testVersion() throws {
        let result = try CLI.run(["version"], in: directory)
        XCTAssertEqual(result.status, 0)
        // The built binary prints the version the sources declare (bumping Tool.version needs no test edit).
        XCTAssertEqual(result.stdout, #"{"name":"niho-speech","version":""# + Tool.version + #""}"# + "\n")
        XCTAssertEqual(result.stderr, "")
    }

    func testHelp() throws {
        for arguments in [["help"], ["--help"], ["-h"]] {
            let result = try CLI.run(arguments, in: directory)
            XCTAssertEqual(result.status, 0, "\(arguments)")
            XCTAssertTrue(result.stdout.hasPrefix("niho-speech \(Tool.version)"), "\(arguments)")
            XCTAssertTrue(result.stdout.contains("niho-speech transcribe --input"), "\(arguments)")
            XCTAssertEqual(result.stderr, "", "\(arguments)")
        }
    }

    func testUnknownSubcommand() throws {
        try assertError(["listen"], code: "invalid_arguments", status: 1)
        try assertError(["transcribe", "--input"], code: "invalid_arguments", status: 1)
    }

    func testTranscribeMissingInput() throws {
        try assertError(["transcribe", "--input", "missing.wav"], code: "input_not_found", status: 3)
    }

    func testSilenceRejectsNonWAV() throws {
        let input = directory.appendingPathComponent("not-wav.m4a")
        try Data([0]).write(to: input)
        try assertError(["silence", "--input", input.path], code: "input_format", status: 3)
    }

    func testConvertMissingInput() throws {
        try assertError(["convert", "--input", "missing.m4a", "--output", "out.wav"], code: "input_not_found", status: 3)
    }

    func testProbeUnsupportedLanguage() throws {
        let result = try CLI.run(["probe", "--language", "xx-YY"], in: directory)
        XCTAssertEqual(result.status, 0)
        let status = try jsonObject(result.lines.first ?? "")
        XCTAssertEqual(status["available"] as? Bool, false)
        XCTAssertEqual(status["engine"] as? String, "SpeechAnalyzer")
        XCTAssertTrue(["ready", "missing", "corrupt"].contains((status["diarization"] as? [String: Any])?["state"] as? String ?? ""))
    }

    func testSilenceOnAWAV() throws {
        // 2 s of sound, 1 s of silence, 2 s of sound: one cut in the silence.
        var samples = [Int16](repeating: 4000, count: 5 * 16000)
        for index in 32000 ..< 48000 { samples[index] = 0 }
        let url = directory.appendingPathComponent("a.wav")
        try writeWAV(samples, to: url)
        let result = try CLI.run(["silence", "--input=a.wav", "--target", "2", "--window", "1", "--min", "1"], in: directory)
        XCTAssertEqual(result.status, 0, result.stdout)
        XCTAssertEqual(result.stdout, #"{"cuts":[2.5],"durationSec":5,"soundSec":[2,2]}"# + "\n")
    }

    func testMicStatusNeverAsks() throws {
        // Without --request it only reads the status (no prompt), whatever it is on this Mac.
        let result = try CLI.run(["mic-status"], in: directory)
        XCTAssertEqual(result.status, 0, result.stdout)
        let status = try jsonObject(result.lines.first ?? "")["status"] as? String
        XCTAssertTrue(["authorized", "denied", "notDetermined", "restricted"].contains(status ?? ""), result.stdout)
    }

    func testRecordRefusesAnOutputThatIsNotM4A() throws {
        try assertError(["record", "--output", "a.wav"], code: "invalid_arguments", status: 1)
    }

    /// On a Mac with no input device (CI, a Mac Studio without a microphone), `record` stops before asking for
    /// the microphone: exit 2 `no_input_device`. Skipped where a device exists (it would prompt).
    func testRecordWithoutAnInputDevice() throws {
        guard InputDevice.defaultID() == nil else {
            throw XCTSkip("this Mac has an input device; record would ask for the microphone")
        }
        try assertError(["record", "--output", "a.m4a"], code: "no_input_device", status: 2)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("a.recording.caf").path))
    }
}
