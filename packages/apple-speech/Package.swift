// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "NihoOnDeviceSpeech",
    platforms: [
        .macOS(.v26),
        .iOS(.v26),
    ],
    products: [
        .library(name: "NihoOnDeviceSpeech", type: .static, targets: ["NihoOnDeviceSpeech"]),
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.15.6"),
    ],
    targets: [
        .target(
            name: "NihoOnDeviceSpeech",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            resources: [
                .copy("Resources/diarization-model-manifest.json"),
                .copy("Resources/Notices"),
            ]
        ),
        .testTarget(name: "NihoOnDeviceSpeechTests", dependencies: ["NihoOnDeviceSpeech"]),
    ]
)
