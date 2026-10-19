import XCTest
@testable import NihoSpeech

final class HintsTests: XCTestCase {
    private func parse(_ json: String) throws -> [HintEntry] {
        try Hints.parse(Data(json.utf8))
    }

    func testValidHints() throws {
        let entries = try parse("""
        [
          {"term": " NIHO鎌倉 ", "reading": "にほかまくら", "variants": ["NIHO 鎌倉", "ニホ鎌倉"]},
          {"term": "記事", "note": "other keys are ignored"},
          {"term": "拠点", "reading": null, "variants": null}
        ]
        """)
        XCTAssertEqual(entries, [
            HintEntry(term: "NIHO鎌倉", reading: "にほかまくら", variants: ["NIHO 鎌倉", "ニホ鎌倉"]),
            HintEntry(term: "記事", reading: nil, variants: []),
            HintEntry(term: "拠点", reading: nil, variants: []),
        ])
        let (strings, ignored) = Hints.contextualStrings(for: entries)
        // Terms only: never the readings or the variants (known misspellings).
        XCTAssertEqual(strings, ["NIHO鎌倉", "記事", "拠点"])
        XCTAssertEqual(ignored, 0)
        XCTAssertEqual(try parse("[]"), [])
    }

    func testDuplicatesAndTheCap() throws {
        let duplicated = try parse(#"[{"term":"a"},{"term":"b"},{"term":" a"},{"term":"A"}]"#)
        XCTAssertEqual(Hints.contextualStrings(for: duplicated).strings, ["a", "b", "A"])

        let many = (0 ..< 150).map { HintEntry(term: "term\($0 % 120)", reading: nil, variants: []) }
        let (strings, ignored) = Hints.contextualStrings(for: many)
        XCTAssertEqual(strings.count, 100)
        XCTAssertEqual(strings.first, "term0")
        XCTAssertEqual(strings.last, "term99")
        XCTAssertEqual(ignored, 20)
    }

    func testInvalidShapes() {
        let cases = [
            "",
            "not json",
            #"{"term":"a"}"#,
            #""a""#,
            "[1]",
            #"["a"]"#,
            "[null]",
            #"[{"reading":"a"}]"#,
            #"[{"term":1}]"#,
            #"[{"term":null}]"#,
            #"[{"term":"   "}]"#,
            #"[{"term":"a","reading":1}]"#,
            #"[{"term":"a","variants":"b"}]"#,
            #"[{"term":"a","variants":[1]}]"#,
            #"[{"term":"a","variants":["b",null]}]"#,
            #"[{"term":"a"},{"term":true}]"#,
        ]
        for json in cases {
            XCTAssertThrowsError(try parse(json), json) { error in
                XCTAssertEqual((error as? ToolError)?.code, "invalid_hints", json)
                XCTAssertEqual((error as? ToolError)?.exitCode, 3, json)
            }
        }
    }

    func testLoad() throws {
        let directory = try makeTemporaryDirectory(for: self)
        let url = directory.appendingPathComponent("hints.json")
        try Data(#"[{"term":"NIHO鎌倉","reading":"にほかまくら","variants":["NIHO 鎌倉"]}]"#.utf8).write(to: url)
        XCTAssertEqual(try Hints.load(path: url.path).map(\.term), ["NIHO鎌倉"])
        for path in [directory.appendingPathComponent("missing.json").path, directory.path] {
            XCTAssertThrowsError(try Hints.load(path: path), path) { error in
                XCTAssertEqual((error as? ToolError)?.code, "invalid_hints", path)
            }
        }
    }
}
