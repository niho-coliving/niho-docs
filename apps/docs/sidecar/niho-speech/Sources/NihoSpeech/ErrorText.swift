import Foundation
import System

/// System errors as stable English text for `message`: the domain and code
/// (and the underlying error's, and the debug description when there is one),
/// never `localizedDescription`, which follows the user's language.
enum ErrorText {
    static func describe(_ error: any Error) -> String {
        if let error = error as? ToolError { return error.message }
        if let error = error as? Errno { return error.description }
        let error = error as NSError
        var text = "\(error.domain) error \(error.code)"
        if let debug = error.userInfo[NSDebugDescriptionErrorKey] as? String, !debug.isEmpty {
            text += ": \(debug)"
        }
        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
            text += " (\(underlying.domain) error \(underlying.code))"
        }
        return text
    }
}
