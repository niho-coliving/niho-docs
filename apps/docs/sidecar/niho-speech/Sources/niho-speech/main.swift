import Foundation
import NihoSpeech

// niho-speech — see README.md for the output contract.
// stdout: JSON lines (or the usage text). stderr: human notes only.
exit(await NihoSpeechCLI.run(Array(CommandLine.arguments.dropFirst())))
