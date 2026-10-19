import Foundation

/// One `--hints` entry: `{"term":"NIHO鎌倉","reading":"にほかまくら","variants":["NIHO 鎌倉"]}`.
struct HintEntry: Equatable {
    /// Trimmed, never empty.
    let term: String
    let reading: String?
    /// Known misspellings of `term`: never passed to the recognizer.
    let variants: [String]
}

enum Hints {
    /// Contextual strings passed to the analyzer at most.
    static let maximumTerms = 100

    /// `invalid_hints` for a missing or unreadable file too.
    static func load(path: String) throws -> [HintEntry] {
        let data: Data
        do {
            data = try Data(contentsOf: URL(fileURLWithPath: path))
        } catch {
            throw ToolError.invalidHints("cannot read the hints file \(path): \(ErrorText.describe(error))")
        }
        return try parse(data, source: path)
    }

    /// A JSON array of objects with a non-empty string `term`, an optional
    /// string `reading` and an optional array of strings `variants` (null
    /// counts as absent; other keys are ignored).
    static func parse(_ data: Data, source: String = "hints") throws -> [HintEntry] {
        let shape = #"[{"term": "…", "reading": "…", "variants": ["…"]}, …]"#
        guard let root = try? JSONSerialization.jsonObject(with: data), let array = root as? [Any] else {
            throw ToolError.invalidHints("\(source) must be a JSON array like \(shape)")
        }
        return try array.enumerated().map { index, element in
            guard let object = element as? [String: Any] else {
                throw ToolError.invalidHints("\(source) entry \(index) is not an object")
            }
            guard let rawTerm = object["term"] as? String else {
                throw ToolError.invalidHints("\(source) entry \(index) needs a string \"term\"")
            }
            let term = rawTerm.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !term.isEmpty else {
                throw ToolError.invalidHints("\(source) entry \(index) has an empty \"term\"")
            }
            var reading: String?
            if let value = object["reading"], !(value is NSNull) {
                guard let text = value as? String else {
                    throw ToolError.invalidHints("\(source) entry \(index): \"reading\" must be a string")
                }
                reading = text
            }
            var variants: [String] = []
            if let value = object["variants"], !(value is NSNull) {
                guard let list = value as? [Any], let texts = list as? [String], texts.count == list.count else {
                    throw ToolError.invalidHints("\(source) entry \(index): \"variants\" must be an array of strings")
                }
                variants = texts
            }
            return HintEntry(term: term, reading: reading, variants: variants)
        }
    }

    /// The unique terms in order, at most `maximumTerms`; `ignored` counts
    /// the unique terms left out. Readings and variants are never included.
    static func contextualStrings(for entries: [HintEntry]) -> (strings: [String], ignored: Int) {
        var seen = Set<String>()
        let unique = entries.map(\.term).filter { seen.insert($0).inserted }
        return (Array(unique.prefix(maximumTerms)), max(0, unique.count - maximumTerms))
    }
}
