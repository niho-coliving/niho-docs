// swift-tools-version: 6.2
//
// niho-speech: on-device speech-to-text sidecar for the NIHO docs desktop app
// (Epic #18380, S1-C #18403). Converts audio to a 16 kHz mono WAV, plans chunk
// cuts at silences (parity with the API's ffmpeg path) and transcribes with
// Apple's SpeechAnalyzer / SpeechTranscriber. macOS 26 or later on Apple
// Silicon only (see README.md).
import Foundation
import PackageDescription

// The executable embeds Sources/niho-speech/Info.plist (CFBundleIdentifier niho-speech) so codesign keeps the
// signing identifier "niho-speech" when the NIHO docs bundle is ad-hoc signed (S4 #18385). Without it, codesign
// names ad-hoc signed tools "<name>-<Mach-O UUID>", which changes every release, and SpeechAnalyzer keeps its
// language reservations per signing identifier (README.md "probe・download").
let embeddedInfoPlist = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("Sources/niho-speech/Info.plist")
    .path

let package = Package(
    name: "niho-speech",
    platforms: [.macOS(.v26)],
    products: [
        .executable(name: "niho-speech", targets: ["niho-speech"]),
    ],
    dependencies: [
        .package(path: "../../../../packages/apple-speech"),
    ],
    targets: [
        .target(
            name: "NihoSpeech",
            dependencies: [.product(name: "NihoOnDeviceSpeech", package: "apple-speech")],
            path: "Sources/NihoSpeech"
        ),
        .executableTarget(
            name: "niho-speech",
            dependencies: ["NihoSpeech"],
            path: "Sources/niho-speech",
            exclude: ["Info.plist"],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", embeddedInfoPlist]),
            ]
        ),
        .testTarget(
            name: "NihoSpeechTests",
            // niho-speech: the CLI tests run the built executable.
            dependencies: ["NihoSpeech", "niho-speech"],
            path: "Tests/NihoSpeechTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
