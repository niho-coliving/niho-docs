import Foundation

/// A value in one output line.
enum JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral {
    case string(String)
    /// Printed as the shortest decimal; `null` when not finite.
    case number(Double)
    case integer(Int)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object(KeyValuePairs<String, JSONValue>)

    init(stringLiteral value: String) {
        self = .string(value)
    }

    init(booleanLiteral value: Bool) {
        self = .bool(value)
    }

    /// Seconds and ratios are reported to 0.01 (`(x · 100).rounded() / 100`).
    static func hundredths(_ value: Double) -> JSONValue {
        .number((value * 100).rounded() / 100)
    }

    var jsonText: String {
        switch self {
        case let .string(value): JSONLine.quoted(value)
        case let .number(value): JSONLine.numberText(value)
        case let .integer(value): String(value)
        case let .bool(value): value ? "true" : "false"
        case .null: "null"
        case let .array(values): "[" + values.map(\.jsonText).joined(separator: ",") + "]"
        case let .object(fields): JSONLine.encode(fields)
        }
    }
}

/// One JSON object per stdout line: UTF-8, keys in the README's order
/// (`{"type":"segment","start":…}`), `/` and non-ASCII text not escaped.
enum JSONLine {
    static func encode(_ fields: KeyValuePairs<String, JSONValue>) -> String {
        "{" + fields.map { quoted($0.key) + ":" + $0.value.jsonText }.joined(separator: ",") + "}"
    }

    /// A JSON string literal. Only `"`, `\` and control characters are escaped.
    static func quoted(_ text: String) -> String {
        var out = "\""
        out.reserveCapacity(text.utf8.count + 2)
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case _ where scalar.value < 0x20: out += String(format: "\\u%04x", scalar.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        out += "\""
        return out
    }

    /// The shortest decimal that reads back as `value` (Swift's round-trip
    /// `description`, the text the precedent gets from NSDecimalNumber: 12.4,
    /// not 12.4000000000000004) with no `.0` on whole numbers (1801); `null`
    /// when not finite.
    static func numberText(_ value: Double) -> String {
        guard value.isFinite else { return "null" }
        if value.rounded() == value, abs(value) < 1e15 {
            return String(Int64(value))
        }
        return value.description
    }
}
