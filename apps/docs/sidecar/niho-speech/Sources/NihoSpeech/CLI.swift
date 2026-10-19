import Foundation

struct ConvertOptions: Equatable {
    var input: String
    var output: String
}

/// Chunk planning in seconds; the defaults are the API's Gemini Flash plan
/// (15 min ± 60 s, chunks of at least 60 s).
struct SilenceOptions: Equatable {
    var input: String
    var target: Double = 900
    var window: Double = 60
    var min: Double = 60
}

/// A frame range of convert's WAV copied to its own WAV (a chunk file for an
/// engine that takes a file, such as Gemini through the Antigravity CLI).
struct SliceOptions: Equatable {
    var input: String
    var output: String
    /// Seconds of the WAV; nil = 0 / the end. Same rules as `transcribe`.
    var start: Double?
    var end: Double?
}

struct TranscribeOptions: Equatable {
    var input: String
    var language = ArgumentParser.defaultLanguage
    var hints: String?
    var speakerMap: String?
    /// Seconds of the WAV; nil = 0 / the end. Checked against the file (`invalid_range`).
    var start: Double?
    var end: Double?
}

struct DiarizeOptions: Equatable {
    var input: String
    var output: String
    var speakers: Int?
    var minimumSpeakers: Int?
}

/// A recording from the default input device to an AAC `.m4a` (spec §6.2, #18590).
struct RecordOptions: Equatable {
    var output: String
}

enum Command: Equatable {
    case probe(language: String)
    case download(language: String)
    case convert(ConvertOptions)
    case silence(SilenceOptions)
    case slice(SliceOptions)
    case transcribe(TranscribeOptions)
    case diarize(DiarizeOptions)
    case record(RecordOptions)
    case micStatus(request: Bool)
    case version
    case help
}

/// Hand-rolled parser (no ArgumentParser dependency). Options accept both
/// `--name value` and `--name=value`; no subcommand takes positional arguments.
/// The only flag (an option without a value) is `mic-status --request`.
enum ArgumentParser {
    static let defaultLanguage = "ja"

    static let usage = """
    \(Tool.name) \(Tool.version) — on-device speech to text for NIHO docs (SpeechAnalyzer, macOS 26+)

    USAGE
      niho-speech probe      [--language ja]
      niho-speech download   [--language ja]
      niho-speech convert    --input <audio-or-video> --output <file.wav>
      niho-speech silence    --input <file.wav> [--target 900] [--window 60] [--min 60]
      niho-speech slice      --input <file.wav> --output <chunk.wav> [--start <sec>] [--end <sec>]
      niho-speech transcribe --input <file.wav> [--language ja] [--hints <hints.json>]
                             [--speaker-map <map.json>] [--start <sec>] [--end <sec>]
      niho-speech diarize    --input <file.wav> --output <map.json>
                             [--speakers <count> | --minimum-speakers <count>]
      niho-speech record     --output <file.m4a>
      niho-speech mic-status [--request]
      niho-speech version
      niho-speech help

    Options take --name value or --name=value. stdout carries one JSON object per
    line; human notes go to stderr. Seconds are rounded to 0.01.

    probe       {"available","needsDownload","engine":"SpeechAnalyzer","locale"}
                (locale: the resolved identifier, e.g. ja_JP, or null). Never
                downloads or reserves anything.
    download    installs the speech model for the language: {"type":"progress",
                "ratio"} while downloading, then {"type":"done","ok":true}.
    convert     decodes any audio or video file AVFoundation reads (all audio
                tracks mixed, channels averaged like ffmpeg -ac 1) to a 16 kHz
                mono 16-bit PCM WAV, written to a temporary file and moved
                over --output: {"durationSec"}.
    silence     finds silences like ffmpeg silencedetect=noise=-35dB:d=0.35 and
                plans chunk cuts like the API (planArticleAudioChunks):
                {"cuts":[...],"durationSec","soundSec":[...]}; cuts exclude
                0 and the end; soundSec has one non-silent duration per chunk.
    slice       copies --start..--end of the WAV (transcribe's range rules) to
                its own 16 kHz mono 16-bit WAV, written to a temporary file and
                moved over --output: {"durationSec"}. A chunk file for an engine
                that takes a file (Gemini through the Antigravity CLI).
    transcribe  {"type":"segment","start","end","text"} for each final result
                (seconds of the whole WAV, within --start..--end),
                {"type":"progress","ratio"} in 0.01 steps, then
                {"type":"done","segments","durationMs"}. --end past the end of
                the audio is clamped.
    diarize     processes the whole WAV once and writes a private speaker map.
                Speaker IDs are stable within this one file only. It never downloads.
    record      records the default input device until SIGTERM (or SIGINT):
                {"type":"started","device","sampleRate":24000}, then
                {"type":"level","db","durationSec"} about every 0.2 s, then
                {"type":"done","file","durationSec","bytes"}. The audio goes
                to <name>.recording.caf next to --output while recording
                (24 kHz mono 16-bit PCM, readable after a crash) and is
                exported to AAC at --output when stopped; if the export
                fails, done names the .recording.caf instead.
    mic-status  {"status":"authorized|denied|notDetermined|restricted"} for
                the microphone. --request asks first when not determined.

    silence, slice, transcribe and diarize take a 16 kHz mono 16-bit PCM WAV (convert's output).
    --hints: [{"term":"NIHO鎌倉","reading":"にほかまくら","variants":["NIHO 鎌倉"]}, ...];
    the unique terms (at most 100) are passed as contextual strings; variants
    (known misspellings) never are.

    Errors are one JSON line on stdout: {"type":"error","code":"<code>","message":"..."}.
    Exit codes: 0 ok; 1 invalid_arguments, write_failed, download_failed,
    transcription_failed, recording_failed, internal_error;
    2 model_not_installed, engine_unavailable, no_input_device;
    3 input_not_found, input_unreadable, input_empty, input_format,
    invalid_range, invalid_hints, unsupported_language;
    4 permission_denied, microphone_permission_denied.
    """

    static func parse(_ arguments: [String]) throws -> Command {
        guard let subcommand = arguments.first else { return .help }
        let rest = Array(arguments.dropFirst())
        switch subcommand {
        case "-h", "--help", "help":
            return .help
        case "-V", "--version", "version":
            guard rest.isEmpty else {
                throw ToolError.invalidArguments("version takes no arguments")
            }
            return .version
        case "probe":
            return try parseLanguageOnly(rest, subcommand: subcommand).map { .probe(language: $0) } ?? .help
        case "download":
            return try parseLanguageOnly(rest, subcommand: subcommand).map { .download(language: $0) } ?? .help
        case "convert":
            return try parseConvert(rest)
        case "silence":
            return try parseSilence(rest)
        case "slice":
            return try parseSlice(rest)
        case "transcribe":
            return try parseTranscribe(rest)
        case "diarize":
            return try parseDiarize(rest)
        case "record":
            return try parseRecord(rest)
        case "mic-status":
            let parsed = try tokenize(rest, subcommand: subcommand, valueOptions: [], flags: ["--request"])
            return parsed.help ? .help : .micStatus(request: parsed.flags.contains("--request"))
        default:
            throw ToolError.invalidArguments("unknown subcommand '\(subcommand)' (see --help)")
        }
    }

    struct Parsed {
        var values: [String: String] = [:]
        var flags: Set<String> = []
        var help = false
    }

    /// Value options and `flags` (no value; `--flag=x` is an error). No positionals.
    static func tokenize(
        _ arguments: [String], subcommand: String, valueOptions: Set<String>, flags: Set<String> = []
    ) throws -> Parsed {
        var parsed = Parsed()
        var index = 0
        while index < arguments.count {
            let token = arguments[index]
            index += 1
            if token == "-h" || token == "--help" {
                parsed.help = true
                continue
            }
            guard token.hasPrefix("-"), token != "-", token != "--" else {
                throw ToolError.invalidArguments("\(subcommand) takes no positional arguments (got '\(token)')")
            }
            var name = token
            var inlineValue: String?
            if let equals = token.firstIndex(of: "=") {
                name = String(token[..<equals])
                inlineValue = String(token[token.index(after: equals)...])
            }
            if flags.contains(name) {
                guard inlineValue == nil else {
                    throw ToolError.invalidArguments("\(name) takes no value")
                }
                guard parsed.flags.insert(name).inserted else {
                    throw ToolError.invalidArguments("\(name) was given more than once")
                }
                continue
            }
            guard valueOptions.contains(name) else {
                throw ToolError.invalidArguments("unknown option \(name) for \(subcommand) (see --help)")
            }
            let value: String
            if let inlineValue {
                value = inlineValue
            } else {
                guard index < arguments.count else {
                    throw ToolError.invalidArguments("\(name) needs a value")
                }
                value = arguments[index]
                index += 1
            }
            guard parsed.values[name] == nil else {
                throw ToolError.invalidArguments("\(name) was given more than once")
            }
            guard !value.isEmpty else {
                throw ToolError.invalidArguments("\(name) needs a non-empty value")
            }
            parsed.values[name] = value
        }
        return parsed
    }

    /// `probe` / `download`: the language, or nil for `--help`.
    static func parseLanguageOnly(_ arguments: [String], subcommand: String) throws -> String? {
        let parsed = try tokenize(arguments, subcommand: subcommand, valueOptions: ["--language"])
        if parsed.help { return nil }
        return parsed.values["--language"] ?? defaultLanguage
    }

    static func parseConvert(_ arguments: [String]) throws -> Command {
        let parsed = try tokenize(arguments, subcommand: "convert", valueOptions: ["--input", "--output"])
        if parsed.help { return .help }
        let input = try required("--input", in: parsed, subcommand: "convert")
        let output = try required("--output", in: parsed, subcommand: "convert")
        guard canonicalPath(input) != canonicalPath(output) else {
            throw ToolError.invalidArguments("--output must not be the --input file")
        }
        return .convert(ConvertOptions(input: input, output: output))
    }

    static func parseSilence(_ arguments: [String]) throws -> Command {
        let parsed = try tokenize(
            arguments,
            subcommand: "silence",
            valueOptions: ["--input", "--target", "--window", "--min"]
        )
        if parsed.help { return .help }
        var options = SilenceOptions(input: try required("--input", in: parsed, subcommand: "silence"))
        if let value = parsed.values["--target"] {
            options.target = try seconds(value, option: "--target")
            guard options.target > 0 else {
                throw ToolError.invalidArguments("--target must be greater than 0 (got '\(value)')")
            }
        }
        if let value = parsed.values["--window"] {
            options.window = try seconds(value, option: "--window")
            guard options.window >= 0 else {
                throw ToolError.invalidArguments("--window must not be negative (got '\(value)')")
            }
        }
        if let value = parsed.values["--min"] {
            options.min = try seconds(value, option: "--min")
            guard options.min > 0 else {
                throw ToolError.invalidArguments("--min must be greater than 0 (got '\(value)')")
            }
        }
        return .silence(options)
    }

    static func parseSlice(_ arguments: [String]) throws -> Command {
        let parsed = try tokenize(
            arguments,
            subcommand: "slice",
            valueOptions: ["--input", "--output", "--start", "--end"]
        )
        if parsed.help { return .help }
        let input = try required("--input", in: parsed, subcommand: "slice")
        let output = try required("--output", in: parsed, subcommand: "slice")
        guard canonicalPath(input) != canonicalPath(output) else {
            throw ToolError.invalidArguments("--output must not be the --input file")
        }
        var options = SliceOptions(input: input, output: output)
        // Like transcribe: any number parses here; the range check is invalid_range.
        if let value = parsed.values["--start"] {
            options.start = try number(value, option: "--start")
        }
        if let value = parsed.values["--end"] {
            options.end = try number(value, option: "--end")
        }
        return .slice(options)
    }

    static func parseTranscribe(_ arguments: [String]) throws -> Command {
        let parsed = try tokenize(
            arguments,
            subcommand: "transcribe",
            valueOptions: ["--input", "--language", "--hints", "--speaker-map", "--start", "--end"]
        )
        if parsed.help { return .help }
        var options = TranscribeOptions(input: try required("--input", in: parsed, subcommand: "transcribe"))
        options.language = parsed.values["--language"] ?? defaultLanguage
        options.hints = parsed.values["--hints"]
        options.speakerMap = parsed.values["--speaker-map"]
        // Any number parses here; a negative or non-finite one is invalid_range
        // (checked after the input, like every other range problem).
        if let value = parsed.values["--start"] {
            options.start = try number(value, option: "--start")
        }
        if let value = parsed.values["--end"] {
            options.end = try number(value, option: "--end")
        }
        return .transcribe(options)
    }

    static func parseDiarize(_ arguments: [String]) throws -> Command {
        let parsed = try tokenize(
            arguments,
            subcommand: "diarize",
            valueOptions: ["--input", "--output", "--speakers", "--minimum-speakers"]
        )
        if parsed.help { return .help }
        let input = try required("--input", in: parsed, subcommand: "diarize")
        let output = try required("--output", in: parsed, subcommand: "diarize")
        guard canonicalPath(input) != canonicalPath(output) else {
            throw ToolError.invalidArguments("--output must not be the --input file")
        }
        guard parsed.values["--speakers"] == nil || parsed.values["--minimum-speakers"] == nil else {
            throw ToolError.invalidArguments("--speakers and --minimum-speakers cannot be used together")
        }
        func speakerCount(_ option: String) throws -> Int? {
            guard let value = parsed.values[option] else { return nil }
            guard let count = Int(value), (2 ... 20).contains(count) else {
                throw ToolError.invalidArguments("\(option) must be an integer from 2 through 20")
            }
            return count
        }
        return .diarize(DiarizeOptions(
            input: input,
            output: output,
            speakers: try speakerCount("--speakers"),
            minimumSpeakers: try speakerCount("--minimum-speakers")
        ))
    }

    static func parseRecord(_ arguments: [String]) throws -> Command {
        let parsed = try tokenize(arguments, subcommand: "record", valueOptions: ["--output"])
        if parsed.help { return .help }
        let output = try required("--output", in: parsed, subcommand: "record")
        // The export's file type comes from the extension (AVAudioFile).
        guard URL(fileURLWithPath: output).pathExtension.lowercased() == "m4a" else {
            throw ToolError.invalidArguments("--output must be a .m4a file (got '\(output)')")
        }
        return .record(RecordOptions(output: output))
    }

    static func required(_ option: String, in parsed: Parsed, subcommand: String) throws -> String {
        guard let value = parsed.values[option] else {
            throw ToolError.invalidArguments("\(subcommand) needs \(option) <path>")
        }
        return value
    }

    static func number(_ value: String, option: String) throws -> Double {
        guard let number = Double(value) else {
            throw ToolError.invalidArguments("\(option) must be a number of seconds (got '\(value)')")
        }
        return number
    }

    /// A finite number of seconds.
    static func seconds(_ value: String, option: String) throws -> Double {
        let number = try number(value, option: option)
        guard number.isFinite else {
            throw ToolError.invalidArguments("\(option) must be a finite number of seconds (got '\(value)')")
        }
        return number
    }

    /// Absolute, standardized and with symlinks resolved, so `a.wav` and
    /// `./a.wav` are the same file.
    static func canonicalPath(_ path: String) -> String {
        URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
    }
}
