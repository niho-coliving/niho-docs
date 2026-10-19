import Foundation

public enum SpeakerAlignment {
    /// 入力文字を増減させず、実時刻のある run だけを話者ターンへ対応付ける。
    public static func align(_ text: [TimedText], to map: SpeakerMap) throws -> [AlignedUtterance] {
        var utterances: [AlignedUtterance] = []
        var leadingUntimed = ""

        func append(text value: String, start: Double?, end: Double?, speaker: Int?) throws {
            guard !value.isEmpty else { return }
            if let last = utterances.last, last.speaker == speaker {
                utterances.removeLast()
                utterances.append(try AlignedUtterance(
                    text: last.text + value,
                    start: minOptional(last.start, start),
                    end: maxOptional(last.end, end),
                    speaker: speaker
                ))
            } else {
                utterances.append(try AlignedUtterance(text: value, start: start, end: end, speaker: speaker))
            }
        }

        for item in text {
            guard !item.text.isEmpty else { continue }
            // ASR は句読点にも時刻を付けることがある。声を持たない文字だけで
            // 「話者?」の段落を作らず、直前の本文へ付ける。
            if isOnlySpacingOrPunctuation(item.text) {
                if let last = utterances.popLast() {
                    var end = last.end
                    if last.start != nil, let previousEnd = last.end,
                       let punctuationStart = item.start, let punctuationEnd = item.end,
                       punctuationEnd > punctuationStart, punctuationEnd <= map.duration + 0.02 {
                        end = max(previousEnd, min(punctuationEnd, map.duration))
                    }
                    utterances.append(try AlignedUtterance(
                        text: last.text + item.text,
                        start: last.start,
                        end: end,
                        speaker: last.speaker
                    ))
                } else {
                    leadingUntimed += item.text
                }
                continue
            }
            guard let start = item.start, let end = item.end, end > start, end <= map.duration + 0.02 else {
                try append(text: leadingUntimed + item.text, start: nil, end: nil, speaker: nil)
                leadingUntimed = ""
                continue
            }

            let speaker = attributedSpeaker(text: item.text, start: start, end: end, turns: map.turns)
            try append(text: leadingUntimed + item.text, start: start, end: end, speaker: speaker)
            leadingUntimed = ""
        }
        if !leadingUntimed.isEmpty {
            try append(text: leadingUntimed, start: nil, end: nil, speaker: nil)
        }
        return utterances
    }

    /// 1 文字あたりに見る音声の長さの上限（秒）。
    static let evidenceSecondsPerCharacter = 0.3

    /// SpeechTranscriber は結果の最初の run に、前の結果の終わりからの無音を含めた時刻を付ける。
    /// その無音で支持率が下がり、ほぼ全ての発言の先頭 1 文字が「話者?」に分かれていたので、
    /// 根拠を見る範囲を run の終わりから文字数に見合う長さまでに絞る。返す時刻は変えない。
    static func evidenceStart(text: String, start: Double, end: Double) -> Double {
        let window = Double(max(1, text.count)) * evidenceSecondsPerCharacter
        return max(start, end - window)
    }

    /// run の話者。根拠を見る範囲は先頭の無音を除いて絞る（`evidenceStart`）が、絞ったことで捨てた先頭側に別の話者が
    /// 無視できない長さで重なっているなら、話者交代をまたぐ run なので末尾の話者へ全文を寄せない（元の範囲でも確かめる）。
    private static func attributedSpeaker(text: String, start: Double, end: Double, turns: [SpeakerTurn]) -> Int? {
        let narrowedStart = evidenceStart(text: text, start: start, end: end)
        guard narrowedStart > start else { return supportedSpeaker(start: start, end: end, turns: turns) }
        guard let speaker = supportedSpeaker(start: narrowedStart, end: end, turns: turns) else { return nil }
        let others = strongSpeakers(start: start, end: end, turns: turns).filter { $0.key != speaker }
        return others.isEmpty ? speaker : nil
    }

    private static func supportedSpeaker(start: Double, end: Double, turns: [SpeakerTurn]) -> Int? {
        let duration = end - start
        guard duration > 0 else { return nil }
        let strong = strongSpeakers(start: start, end: end, turns: turns).sorted { $0.value > $1.value }
        guard strong.count == 1, let only = strong.first, only.value >= duration * 0.50 else { return nil }
        return only.key
    }

    /// 範囲の中で、支持と呼べる長さ（範囲の 20%、ただし 0.05 秒以上）で重なっている話者と、その重なりの長さ。
    private static func strongSpeakers(start: Double, end: Double, turns: [SpeakerTurn]) -> [Int: Double] {
        let duration = end - start
        guard duration > 0 else { return [:] }
        var intervalsBySpeaker: [Int: [(Double, Double)]] = [:]
        for turn in turns where turn.end > start && turn.start < end {
            let lower = max(start, turn.start)
            let upper = min(end, turn.end)
            if upper > lower { intervalsBySpeaker[turn.id, default: []].append((lower, upper)) }
        }
        return intervalsBySpeaker
            .mapValues(intervalUnionDuration)
            .filter { $0.value >= max(0.05, duration * 0.20) }
    }

    /// SDKが同じ話者の重複turnを返しても、同じ音声区間を二重に支持として数えない。
    private static func intervalUnionDuration(_ intervals: [(Double, Double)]) -> Double {
        let sorted = intervals.sorted { $0.0 == $1.0 ? $0.1 < $1.1 : $0.0 < $1.0 }
        guard var current = sorted.first else { return 0 }
        var total = 0.0
        for interval in sorted.dropFirst() {
            if interval.0 <= current.1 {
                current.1 = max(current.1, interval.1)
            } else {
                total += current.1 - current.0
                current = interval
            }
        }
        return total + current.1 - current.0
    }

    private static func isOnlySpacingOrPunctuation(_ text: String) -> Bool {
        text.unicodeScalars.allSatisfy {
            CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.punctuationCharacters.contains($0)
        }
    }

    private static func minOptional(_ left: Double?, _ right: Double?) -> Double? {
        switch (left, right) {
        case let (.some(a), .some(b)): min(a, b)
        case let (.some(a), .none): a
        case let (.none, .some(b)): b
        case (.none, .none): nil
        }
    }

    private static func maxOptional(_ left: Double?, _ right: Double?) -> Double? {
        switch (left, right) {
        case let (.some(a), .some(b)): max(a, b)
        case let (.some(a), .none): a
        case let (.none, .some(b)): b
        case (.none, .none): nil
        }
    }
}
