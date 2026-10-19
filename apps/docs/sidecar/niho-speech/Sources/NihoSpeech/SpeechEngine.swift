import Foundation
import Speech

/// SpeechTranscriber's availability and model state for a `--language`.
///
/// Only `download` may call `AssetInventory.assetInstallationRequest`: it
/// reserves the locale for this binary's signing identity (at most
/// `AssetInventory.maximumReservedLocales`). Everything here only reads.
enum SpeechEngine {
    static let name = "SpeechAnalyzer"

    static var isAvailable: Bool { SpeechTranscriber.isAvailable }

    /// The supported locale equivalent to `language` (`ja` → `ja_JP`), or nil.
    /// A bare language takes its likely region first (`en` → `en_US`,
    /// `fr` → `fr_FR`): `supportedLocale(equivalentTo:)` alone picked an
    /// arbitrary region (`en_GB`; `fr_CA` or `fr_CH` from run to run).
    static func supportedLocale(for language: String) async -> Locale? {
        let likely = Locale(identifier: Locale.Language(identifier: language).maximalIdentifier)
        if let locale = await SpeechTranscriber.supportedLocale(equivalentTo: likely) {
            return locale
        }
        return await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language))
    }

    /// Whether the model is on this Mac. `AssetInventory.status(forModules:)`
    /// says `.supported` even for an installed model, so it is not used.
    static func isInstalled(_ locale: Locale) async -> Bool {
        let installed = await SpeechTranscriber.installedLocales
        return installed.contains {
            $0.identifier == locale.identifier || $0.identifier(.bcp47) == locale.identifier(.bcp47)
        }
    }

    /// Final results only, each with its audio time range.
    static func makeTranscriber(locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
    }

    /// The engine is available and the language supported; else
    /// `engine_unavailable` / `unsupported_language`.
    static func requireSupportedLocale(language: String) async throws -> Locale {
        guard isAvailable else {
            throw ToolError.engineUnavailable("SpeechTranscriber is not available on this Mac")
        }
        guard let locale = await supportedLocale(for: language) else {
            throw ToolError.unsupportedLanguage("SpeechTranscriber does not support the language '\(language)'")
        }
        return locale
    }

    /// An analyzer failure: a missing or unallocated model is
    /// `model_not_installed`; anything else `transcription_failed`.
    static func toolError(for error: any Error, language: String) -> ToolError {
        if let error = error as? ToolError { return error }
        if let error = error as? SFSpeechError,
           [.noModel, .assetLocaleNotAllocated, .cannotAllocateUnsupportedLocale].contains(error.code)
        {
            return modelNotInstalled(language: language, detail: ErrorText.describe(error))
        }
        return ToolError.transcriptionFailed("speech analysis failed: \(ErrorText.describe(error))")
    }

    static func modelNotInstalled(language: String, detail: String? = nil) -> ToolError {
        let advice = "the speech model for '\(language)' is not installed; run `niho-speech download --language \(language)`"
        return ToolError.modelNotInstalled(detail.map { "\(advice) (\($0))" } ?? advice)
    }
}
