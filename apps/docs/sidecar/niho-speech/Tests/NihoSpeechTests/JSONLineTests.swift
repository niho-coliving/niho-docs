import XCTest
@testable import NihoSpeech

final class JSONLineTests: XCTestCase {
    func testShortestNumbers() {
        XCTAssertEqual(JSONLine.numberText(12.4), "12.4")
        XCTAssertEqual(JSONLine.numberText(1801), "1801")
        XCTAssertEqual(JSONLine.numberText(4354.2), "4354.2")
        XCTAssertEqual(JSONLine.numberText(0), "0")
        XCTAssertEqual(JSONLine.numberText(-0.0), "0")
        XCTAssertEqual(JSONLine.numberText(0.42), "0.42")
        XCTAssertEqual(JSONLine.numberText(.nan), "null")
        XCTAssertEqual(JSONLine.numberText(.infinity), "null")
    }

    func testHundredths() {
        XCTAssertEqual(JSONValue.hundredths(12.400000001).jsonText, "12.4")
        XCTAssertEqual(JSONValue.hundredths(0.1 + 0.2).jsonText, "0.3")
        XCTAssertEqual(JSONValue.hundredths(897.3049).jsonText, "897.3")
        XCTAssertEqual(JSONValue.hundredths(12.346).jsonText, "12.35")
        XCTAssertEqual(JSONValue.hundredths(12.344).jsonText, "12.34")
        XCTAssertEqual(JSONValue.hundredths(1800.999).jsonText, "1801")
        XCTAssertEqual(JSONValue.hundredths(13.3466875).jsonText, "13.35")
        XCTAssertEqual(JSONValue.hundredths(7.3604875).jsonText, "7.36")
    }

    func testLinesKeepTheReadmeKeyOrder() {
        XCTAssertEqual(
            JSONLine.encode(["type": "segment", "start": .hundredths(12.4), "end": .hundredths(15.9), "text": "鎌倉の拠点で"]),
            #"{"type":"segment","start":12.4,"end":15.9,"text":"鎌倉の拠点で"}"#
        )
        XCTAssertEqual(
            JSONLine.encode(["cuts": .array([.hundredths(897.3), .hundredths(1801)]), "durationSec": .hundredths(4354.2)]),
            #"{"cuts":[897.3,1801],"durationSec":4354.2}"#
        )
        XCTAssertEqual(JSONLine.encode(["cuts": .array([])]), #"{"cuts":[]}"#)
        XCTAssertEqual(
            JSONLine.encode(["available": false, "needsDownload": false, "engine": "SpeechAnalyzer", "locale": .null]),
            #"{"available":false,"needsDownload":false,"engine":"SpeechAnalyzer","locale":null}"#
        )
        XCTAssertEqual(
            JSONLine.encode(["type": "done", "segments": .integer(412), "durationMs": .integer(65000)]),
            #"{"type":"done","segments":412,"durationMs":65000}"#
        )
        XCTAssertEqual(ProgressTracker.line(0.42), #"{"type":"progress","ratio":0.42}"#)
    }

    func testErrorLine() throws {
        let error = ToolError.inputNotFound("input not found: /a b/録音.wav")
        XCTAssertEqual(error.jsonLine, #"{"type":"error","code":"input_not_found","message":"input not found: /a b/録音.wav"}"#)
        XCTAssertEqual(error.exitCode, 3)
    }

    func testEscapingRoundTrips() throws {
        let text = "quote \" backslash \\ slash / newline \n tab \t cr \r bell \u{07} nul \u{00} 日本語 🎙 \u{2028}"
        let line = JSONLine.encode(["text": .string(text)])
        XCTAssertFalse(line.contains("\n"))
        XCTAssertTrue(line.contains("日本語 🎙"))
        XCTAssertTrue(line.contains(" / "))
        XCTAssertTrue(line.contains(#"\u0007"#))
        XCTAssertEqual(try jsonObject(line)["text"] as? String, text)
    }
}
