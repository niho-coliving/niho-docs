import XCTest
@testable import NihoSpeech

final class ArgumentParserTests: XCTestCase {
    func testDefaults() throws {
        XCTAssertEqual(try ArgumentParser.parse(["probe"]), .probe(language: "ja"))
        XCTAssertEqual(try ArgumentParser.parse(["download"]), .download(language: "ja"))
        XCTAssertEqual(
            try ArgumentParser.parse(["convert", "--input", "a.m4a", "--output", "a.wav"]),
            .convert(ConvertOptions(input: "a.m4a", output: "a.wav"))
        )
        let silence = try ArgumentParser.parse(["silence", "--input", "a.wav"])
        XCTAssertEqual(silence, .silence(SilenceOptions(input: "a.wav", target: 900, window: 60, min: 60)))
        XCTAssertEqual(
            try ArgumentParser.parse(["slice", "--input", "a.wav", "--output", "c.wav"]),
            .slice(SliceOptions(input: "a.wav", output: "c.wav", start: nil, end: nil))
        )
        let transcribe = try ArgumentParser.parse(["transcribe", "--input", "a.wav"])
        guard case let .transcribe(options) = transcribe else { return XCTFail("\(transcribe)") }
        XCTAssertEqual(options.input, "a.wav")
        XCTAssertEqual(options.language, "ja")
        XCTAssertNil(options.hints)
        XCTAssertNil(options.speakerMap)
        XCTAssertNil(options.start)
        XCTAssertNil(options.end)
    }

    func testHelpAndVersion() throws {
        for arguments in [[], ["help"], ["--help"], ["-h"], ["help", "transcribe"], ["probe", "--help"],
                          ["transcribe", "-h"], ["silence", "--input", "a.wav", "--help"]]
        {
            XCTAssertEqual(try ArgumentParser.parse(arguments), .help, "\(arguments)")
        }
        for arguments in [["version"], ["--version"], ["-V"]] {
            XCTAssertEqual(try ArgumentParser.parse(arguments), .version, "\(arguments)")
        }
        XCTAssertTrue(ArgumentParser.usage.hasPrefix("niho-speech \(Tool.version)"))
    }

    func testOptionsInBothForms() throws {
        XCTAssertEqual(try ArgumentParser.parse(["probe", "--language=en"]), .probe(language: "en"))
        XCTAssertEqual(try ArgumentParser.parse(["download", "--language", "ko"]), .download(language: "ko"))
        XCTAssertEqual(
            try ArgumentParser.parse(["convert", "--output=b.wav", "--input=a.mov"]),
            .convert(ConvertOptions(input: "a.mov", output: "b.wav"))
        )
        XCTAssertEqual(
            try ArgumentParser.parse(["silence", "--input=a.wav", "--target", "300", "--window=40", "--min", "2.5"]),
            .silence(SilenceOptions(input: "a.wav", target: 300, window: 40, min: 2.5))
        )
        XCTAssertEqual(
            try ArgumentParser.parse(["silence", "--input", "a.wav", "--window", "0"]),
            .silence(SilenceOptions(input: "a.wav", target: 900, window: 0, min: 60))
        )
        XCTAssertEqual(
            try ArgumentParser.parse(["slice", "--output=c.wav", "--input", "a.wav", "--start", "897.3", "--end=1801"]),
            .slice(SliceOptions(input: "a.wav", output: "c.wav", start: 897.3, end: 1801))
        )
        let command = try ArgumentParser.parse([
            "transcribe", "--input", "a.wav", "--language=en-US", "--hints", "h.json", "--start=897.3", "--end", "1801",
        ])
        guard case let .transcribe(options) = command else { return XCTFail("\(command)") }
        XCTAssertEqual(options.language, "en-US")
        XCTAssertEqual(options.hints, "h.json")
        XCTAssertEqual(options.start, 897.3)
        XCTAssertEqual(options.end, 1801)
        XCTAssertEqual(
            try ArgumentParser.parse(["diarize", "--input=a.wav", "--output", "map.json", "--speakers", "3"]),
            .diarize(DiarizeOptions(input: "a.wav", output: "map.json", speakers: 3, minimumSpeakers: nil))
        )
        XCTAssertEqual(
            try ArgumentParser.parse(["diarize", "--input", "a.wav", "--output=map.json", "--minimum-speakers=4"]),
            .diarize(DiarizeOptions(input: "a.wav", output: "map.json", speakers: nil, minimumSpeakers: 4))
        )
        let mapped = try ArgumentParser.parse(["transcribe", "--input", "a.wav", "--speaker-map", "map.json"])
        guard case let .transcribe(mappedOptions) = mapped else { return XCTFail("\(mapped)") }
        XCTAssertEqual(mappedOptions.speakerMap, "map.json")
    }

    /// Negative and non-finite --start / --end parse; the range check after
    /// the input makes them invalid_range.
    func testRangeValuesAreCheckedLater() throws {
        let command = try ArgumentParser.parse(["transcribe", "--input", "a.wav", "--start", "-5", "--end=inf"])
        guard case let .transcribe(options) = command else { return XCTFail("\(command)") }
        XCTAssertEqual(options.start, -5)
        XCTAssertEqual(options.end, .infinity)
    }

    func testRejectsInvalidArguments() {
        let cases: [[String]] = [
            ["bogus"],
            ["--bogus"],
            ["version", "extra"],
            ["probe", "extra"],
            ["probe", "--input", "a.wav"],
            ["probe", "--language"],
            ["probe", "--language="],
            ["probe", "--language", "ja", "--language", "en"],
            ["download", "-x"],
            ["download", "--"],
            ["convert"],
            ["convert", "--input", "a.m4a"],
            ["convert", "--output", "a.wav"],
            ["convert", "--input", "a.wav", "--output", "./a.wav"],
            ["convert", "--input", "a.m4a", "--output", "a.wav", "--target", "1"],
            ["convert", "--input", "a.m4a", "--input=b.m4a", "--output", "a.wav"],
            ["silence"],
            ["silence", "a.wav"],
            ["silence", "--input", "a.wav", "--target", "0"],
            ["silence", "--input", "a.wav", "--target", "-1"],
            ["silence", "--input", "a.wav", "--target", "abc"],
            ["silence", "--input", "a.wav", "--target", "inf"],
            ["silence", "--input", "a.wav", "--target", "nan"],
            ["silence", "--input", "a.wav", "--min", "0"],
            ["silence", "--input", "a.wav", "--min", "-60"],
            ["silence", "--input", "a.wav", "--window", "-1"],
            ["silence", "--input", "a.wav", "--window", "1m"],
            ["silence", "--input", "a.wav", "--target", "900", "--target", "300"],
            ["slice"],
            ["slice", "--input", "a.wav"],
            ["slice", "--output", "c.wav"],
            ["slice", "--input", "a.wav", "--output", "./a.wav"],
            ["slice", "--input", "a.wav", "--output", "c.wav", "--start", "abc"],
            ["slice", "--input", "a.wav", "--output", "c.wav", "--language", "ja"],
            ["slice", "--input", "a.wav", "--output", "c.wav", "--end", "1", "--end", "2"],
            ["transcribe"],
            ["transcribe", "--language", "ja"],
            ["transcribe", "--input", "a.wav", "--start", "abc"],
            ["transcribe", "--input", "a.wav", "--end", "1s"],
            ["transcribe", "--input", "a.wav", "--start", ""],
            ["transcribe", "--input", "a.wav", "--hints"],
            ["transcribe", "--input", "a.wav", "--speaker", "1"],
            ["transcribe", "--input", "a.wav", "--start", "1", "--start", "2"],
            ["diarize"],
            ["diarize", "--input", "a.wav"],
            ["diarize", "--input", "a.wav", "--output", "./a.wav"],
            ["diarize", "--input", "a.wav", "--output", "map.json", "--speakers", "1"],
            ["diarize", "--input", "a.wav", "--output", "map.json", "--speakers", "2", "--minimum-speakers", "4"],
        ]
        for arguments in cases {
            XCTAssertThrowsError(try ArgumentParser.parse(arguments), "\(arguments)") { error in
                XCTAssertEqual((error as? ToolError)?.code, "invalid_arguments", "\(arguments)")
                XCTAssertEqual((error as? ToolError)?.exitCode, 1, "\(arguments)")
            }
        }
    }

    func testRunReportsParseErrorsAsOneJSONLine() async throws {
        let captured = CapturedOutput()
        let status = await NihoSpeechCLI.run(["silence", "--input", "a.wav", "--min", "0"], output: captured.output)
        XCTAssertEqual(status, 1)
        XCTAssertEqual(captured.lines.count, 1)
        let line = try jsonObject(captured.lines[0])
        XCTAssertEqual(line["type"] as? String, "error")
        XCTAssertEqual(line["code"] as? String, "invalid_arguments")
        XCTAssertNotNil(line["message"] as? String)
    }

    func testRecordAndMicStatus() throws {
        XCTAssertEqual(try ArgumentParser.parse(["record", "--output", "a.m4a"]), .record(RecordOptions(output: "a.m4a")))
        XCTAssertEqual(try ArgumentParser.parse(["record", "--output=/tmp/B.M4A"]), .record(RecordOptions(output: "/tmp/B.M4A")))
        XCTAssertEqual(try ArgumentParser.parse(["record", "--help"]), .help)
        XCTAssertEqual(try ArgumentParser.parse(["mic-status"]), .micStatus(request: false))
        XCTAssertEqual(try ArgumentParser.parse(["mic-status", "--request"]), .micStatus(request: true))
        XCTAssertEqual(try ArgumentParser.parse(["mic-status", "-h"]), .help)
        for arguments in [
            ["record"], ["record", "--output", "a.wav"], ["record", "--output", "a"], ["record", "--input", "a.m4a"],
            ["record", "--output", "a.m4a", "--output", "b.m4a"], ["mic-status", "--request=yes"],
            ["mic-status", "--request", "--request"], ["mic-status", "--language", "ja"], ["mic-status", "now"],
        ] {
            XCTAssertThrowsError(try ArgumentParser.parse(arguments), "\(arguments)") { error in
                XCTAssertEqual((error as? ToolError)?.code, "invalid_arguments", "\(arguments)")
            }
        }
    }
}
