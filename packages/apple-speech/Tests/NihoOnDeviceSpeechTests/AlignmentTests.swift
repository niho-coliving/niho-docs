import XCTest
@testable import NihoOnDeviceSpeech

final class AlignmentTests: XCTestCase {
    func testKeepsTextAndGroupsAdjacentSpeaker() throws {
        let map = try SpeakerMap(duration: 10, turns: [
            SpeakerTurn(start: 0, end: 4, id: 1),
            SpeakerTurn(start: 4, end: 8, id: 2),
        ])
        let input = try [
            TimedText(text: "こんにちは", start: 0.5, end: 1.5),
            TimedText(text: "。"),
            TimedText(text: "続けます", start: 2, end: 3),
            TimedText(text: "はい", start: 5, end: 6),
        ]
        let result = try SpeakerAlignment.align(input, to: map)
        XCTAssertEqual(result.map(\.text).joined(), input.map(\.text).joined())
        XCTAssertEqual(result, [
            try AlignedUtterance(text: "こんにちは。続けます", start: 0.5, end: 3, speaker: 1),
            try AlignedUtterance(text: "はい", start: 5, end: 6, speaker: 2),
        ])
    }

    func testOverlapAndUnsupportedAudioAreUnknown() throws {
        let map = try SpeakerMap(duration: 10, turns: [
            SpeakerTurn(start: 0, end: 5, id: 1),
            SpeakerTurn(start: 3, end: 7, id: 2),
        ])
        let input = try [
            TimedText(text: "重なり", start: 3.5, end: 4.5),
            TimedText(text: "無音", start: 8, end: 9),
        ]
        let result = try SpeakerAlignment.align(input, to: map)
        XCTAssertEqual(result.map(\.speaker), [nil])
        XCTAssertEqual(result.map(\.text).joined(), "重なり無音")
    }

    func testTimedPunctuationOutsideVoiceDoesNotCreateUnknownParagraph() throws {
        let map = try SpeakerMap(duration: 5, turns: [SpeakerTurn(start: 0, end: 2, id: 1)])
        let input = try [
            TimedText(text: "本文", start: 0.5, end: 1.8),
            TimedText(text: "。", start: 2, end: 2.2),
        ]
        let result = try SpeakerAlignment.align(input, to: map)
        XCTAssertEqual(result, [try AlignedUtterance(text: "本文。", start: 0.5, end: 2.2, speaker: 1)])
        let untimed = try SpeakerAlignment.align([
            TimedText(text: "時刻なし"), TimedText(text: "。", start: 2, end: 2.2),
        ], to: map)
        XCTAssertEqual(untimed, [try AlignedUtterance(text: "時刻なし。", start: nil, end: nil, speaker: nil)])
    }

    func testDuplicateTurnsForOneSpeakerDoNotInflateCoverage() throws {
        let map = try SpeakerMap(duration: 10, turns: [
            SpeakerTurn(start: 0, end: 0.3, id: 1),
            SpeakerTurn(start: 0, end: 0.3, id: 1),
        ])
        let result = try SpeakerAlignment.align(
            [TimedText(text: "三割だけ", start: 0, end: 1)],
            to: map
        )
        XCTAssertEqual(result.map(\.speaker), [nil])
    }

    /// 合成会話のベンチ（apps/docs/sidecar/speech-bench）で実際に出た時刻。結果の最初の run が前の無音を含み、
    /// 以前は「こ」「来」だけが「話者?」の段落に分かれていた。
    func testLeadingSilenceOnFirstRunDoesNotSplitOffAnUnknownCharacter() throws {
        let map = try SpeakerMap(duration: 14, turns: [
            SpeakerTurn(start: 0.526, end: 7.555, id: 1),
            SpeakerTurn(start: 7.997, end: 13.582, id: 2),
        ])
        let input = try [
            TimedText(text: "こ", start: 0, end: 0.78),
            TimedText(text: "の前話した", start: 0.78, end: 2),
            TimedText(text: "来", start: 7.5, end: 8.22),
            TimedText(text: "月の", start: 8.22, end: 9),
        ]
        let result = try SpeakerAlignment.align(input, to: map)
        XCTAssertEqual(result, [
            try AlignedUtterance(text: "この前話した", start: 0, end: 2, speaker: 1),
            try AlignedUtterance(text: "来月の", start: 7.5, end: 9, speaker: 2),
        ])
    }

    /// 根拠を見る範囲を run の終わり側に絞っても、話者交代をまたぐ run（先頭側に別の話者が長く重なる）を末尾の話者へ寄せない。
    func testRunSpanningSpeakerChangeIsNotAttributedToTheTrailingSpeakerOnly() throws {
        let map = try SpeakerMap(duration: 10, turns: [
            SpeakerTurn(start: 0, end: 7, id: 1),
            SpeakerTurn(start: 7, end: 10, id: 2),
        ])
        let input = try [TimedText(text: "あいうえおかきくけこ", start: 0, end: 10)]
        let result = try SpeakerAlignment.align(input, to: map)
        XCTAssertEqual(result.map(\.speaker), [nil])
        XCTAssertEqual(result.map(\.text), ["あいうえおかきくけこ"])
    }

    /// 話者分離が拾えなかった短い相づちが前の人の区間の終わりにかかるだけなら、前の人へ寄せない。
    func testBackchannelMissedByDiarizationStaysUnknown() throws {
        let map = try SpeakerMap(duration: 10, turns: [
            SpeakerTurn(start: 0, end: 5, id: 1),
            SpeakerTurn(start: 6.5, end: 9, id: 2),
        ])
        let result = try SpeakerAlignment.align([
            TimedText(text: "本文です", start: 3, end: 4.9),
            TimedText(text: "なるほど", start: 4.9, end: 6),
            TimedText(text: "続きです", start: 6.6, end: 8),
        ], to: map)
        XCTAssertEqual(result.map(\.speaker), [1, nil, 2])
        XCTAssertEqual(result.map(\.text), ["本文です", "なるほど", "続きです"])
    }

    func testUntimedWordsStayUnknownAndLeadingPunctuationKeepsOrder() throws {
        let map = try SpeakerMap(duration: 5, turns: [SpeakerTurn(start: 0, end: 5, id: 1)])
        let input = try [
            TimedText(text: "（"),
            TimedText(text: "注記"),
            TimedText(text: "）"),
            TimedText(text: "本文", start: 1, end: 2),
        ]
        let result = try SpeakerAlignment.align(input, to: map)
        XCTAssertEqual(result.map(\.text).joined(), "（注記）本文")
        XCTAssertEqual(result.map(\.speaker), [nil, 1])
    }

    func testRejectsNonFiniteAndUnorderedBounds() throws {
        XCTAssertThrowsError(try SpeakerTurn(start: .nan, end: 1, id: 1))
        XCTAssertThrowsError(try SpeakerMap(duration: 4, turns: [
            SpeakerTurn(start: 2, end: 3, id: 1),
            SpeakerTurn(start: 1, end: 2, id: 2),
        ]))
        XCTAssertThrowsError(try SpeakerMap(duration: 1, turns: [SpeakerTurn(start: 0, end: 2, id: 1)]))
        XCTAssertThrowsError(try JSONDecoder().decode(
            AlignedUtterance.self,
            from: Data(#"{"text":"x","start":0,"end":1,"speaker":0}"#.utf8)
        ))
    }
}
