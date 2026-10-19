import Foundation

/// A failure reported as one JSON line on stdout
/// (`{"type":"error","code":"<code>","message":"..."}`) plus a fixed exit code.
///
/// Exit codes (README):
/// - 1 `invalid_arguments`, `write_failed`, `download_failed`,
///   `transcription_failed`, `recording_failed`, `internal_error`
/// - 2 not usable on this Mac now: `model_not_installed`, `engine_unavailable`,
///   `no_input_device`
/// - 3 bad input: `input_not_found`, `input_unreadable`, `input_empty`,
///   `input_too_large`, `input_format`, `invalid_range`, `invalid_hints`,
///   `unsupported_language`
/// - 4 `permission_denied`, `microphone_permission_denied` (only clear
///   authorization errors)
struct ToolError: Error, Equatable, CustomStringConvertible {
    let code: String
    let message: String
    let exitCode: Int32

    var description: String { "\(code): \(message)" }

    var jsonLine: String {
        JSONLine.encode(["type": "error", "code": .string(code), "message": .string(message)])
    }

    static func invalidArguments(_ message: String) -> ToolError {
        ToolError(code: "invalid_arguments", message: message, exitCode: 1)
    }

    static func writeFailed(_ message: String) -> ToolError {
        ToolError(code: "write_failed", message: message, exitCode: 1)
    }

    static func downloadFailed(_ message: String) -> ToolError {
        ToolError(code: "download_failed", message: message, exitCode: 1)
    }

    static func transcriptionFailed(_ message: String) -> ToolError {
        ToolError(code: "transcription_failed", message: message, exitCode: 1)
    }

    static func recordingFailed(_ message: String) -> ToolError {
        ToolError(code: "recording_failed", message: message, exitCode: 1)
    }

    static func internalError(_ message: String) -> ToolError {
        ToolError(code: "internal_error", message: message, exitCode: 1)
    }

    static func modelNotInstalled(_ message: String) -> ToolError {
        ToolError(code: "model_not_installed", message: message, exitCode: 2)
    }

    static func engineUnavailable(_ message: String) -> ToolError {
        ToolError(code: "engine_unavailable", message: message, exitCode: 2)
    }

    /// No input device to record from (none connected, or none with input channels).
    static func noInputDevice(_ message: String) -> ToolError {
        ToolError(code: "no_input_device", message: message, exitCode: 2)
    }

    static func inputNotFound(_ message: String) -> ToolError {
        ToolError(code: "input_not_found", message: message, exitCode: 3)
    }

    static func inputUnreadable(_ message: String) -> ToolError {
        ToolError(code: "input_unreadable", message: message, exitCode: 3)
    }

    static func inputEmpty(_ message: String) -> ToolError {
        ToolError(code: "input_empty", message: message, exitCode: 3)
    }

    static func inputTooLarge(_ message: String) -> ToolError {
        ToolError(code: "input_too_large", message: message, exitCode: 3)
    }

    static func inputFormat(_ message: String) -> ToolError {
        ToolError(code: "input_format", message: message, exitCode: 3)
    }

    static func invalidRange(_ message: String) -> ToolError {
        ToolError(code: "invalid_range", message: message, exitCode: 3)
    }

    static func invalidHints(_ message: String) -> ToolError {
        ToolError(code: "invalid_hints", message: message, exitCode: 3)
    }

    static func unsupportedLanguage(_ message: String) -> ToolError {
        ToolError(code: "unsupported_language", message: message, exitCode: 3)
    }

    static func permissionDenied(_ message: String) -> ToolError {
        ToolError(code: "permission_denied", message: message, exitCode: 4)
    }

    /// The microphone access (TCC) is denied or restricted, or the person declined the prompt.
    static func microphonePermissionDenied(_ message: String) -> ToolError {
        ToolError(code: "microphone_permission_denied", message: message, exitCode: 4)
    }
}
