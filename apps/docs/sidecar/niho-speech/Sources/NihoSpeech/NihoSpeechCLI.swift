import Foundation

/// The command-line entry point (see README.md): stdout carries the
/// result lines or one error line, the return value is the exit status.
public enum NihoSpeechCLI {
    public static func run(_ arguments: [String]) async -> Int32 {
        await run(arguments, output: .standard)
    }

    static func run(_ arguments: [String], output: Output) async -> Int32 {
        let started = ContinuousClock.now
        do {
            switch try ArgumentParser.parse(arguments) {
            case .help:
                output.line(ArgumentParser.usage)
            case .version:
                output.json(["name": .string(Tool.name), "version": .string(Tool.version)])
            case let .probe(language):
                await ProbeCommand.run(language: language, output: output)
            case let .download(language):
                try await DownloadCommand.run(language: language, output: output)
            case let .convert(options):
                try await ConvertCommand.run(options, output: output)
            case let .silence(options):
                try SilenceCommand.run(options, output: output)
            case let .slice(options):
                try SliceCommand.run(options, output: output)
            case let .transcribe(options):
                try await TranscribeCommand.run(options, output: output, started: started)
            case let .diarize(options):
                try await DiarizeCommand.run(options, output: output)
            case let .record(options):
                try await RecordCommand.run(options, output: output)
            case let .micStatus(request):
                await MicStatusCommand.run(request: request, output: output)
            }
            return 0
        } catch {
            let toolError = error as? ToolError ?? ToolError.internalError("\(error)")
            output.line(toolError.jsonLine)
            return toolError.exitCode
        }
    }
}
