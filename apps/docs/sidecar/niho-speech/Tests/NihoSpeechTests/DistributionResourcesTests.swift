import NihoOnDeviceSpeech
import XCTest
@testable import NihoSpeech

final class DistributionResourcesTests: XCTestCase {
    func testRelocatedSidecarReadsOnlyAppResourcesAndMissingResourcesStayTyped() throws {
        let root = try makeTemporaryDirectory(for: self)
        let app = root.appendingPathComponent("Relocated.app", isDirectory: true)
        let macOS = app.appendingPathComponent("Contents/MacOS", isDirectory: true)
        let resources = app.appendingPathComponent("Contents/Resources", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)

        let relocated = macOS.appendingPathComponent("niho-speech")
        try FileManager.default.copyItem(at: CLI.executable, to: relocated)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: relocated.path)
        let products = CLI.executable.deletingLastPathComponent()
        for bundleName in [NihoSpeechResources.packageBundleName, NihoSpeechResources.fluidAudioBundleName] {
            try FileManager.default.copyItem(
                at: products.appendingPathComponent(bundleName, isDirectory: true),
                to: resources.appendingPathComponent(bundleName, isDirectory: true)
            )
        }

        let environment = ["HOME": home.path, "CFFIXED_USER_HOME": home.path, "PATH": "/usr/bin:/bin"]
        let bundled = try CLI.run(["probe", "--language", "xx-YY"], in: root, executable: relocated, environment: environment)
        XCTAssertEqual(bundled.status, 0, bundled.stdout)
        let bundledStatus = try jsonObject(try XCTUnwrap(bundled.lines.first))
        let bundledDiarization = try XCTUnwrap(bundledStatus["diarization"] as? [String: Any])
        XCTAssertFalse((bundledDiarization["detail"] as? String ?? "").contains("部品がアプリにありません"))
        let notices = resources
            .appendingPathComponent(NihoSpeechResources.packageBundleName, isDirectory: true)
            .appendingPathComponent("Notices", isDirectory: true)
        XCTAssertTrue(FileManager.default.isReadableFile(atPath: notices.appendingPathComponent("NIHO-ATTRIBUTION.md").path))
        XCTAssertTrue(FileManager.default.isReadableFile(atPath: notices.appendingPathComponent("model-NOTICE.md").path))
        XCTAssertTrue(FileManager.default.isReadableFile(atPath: notices.appendingPathComponent("fluidaudio-LICENSE").path))

        try FileManager.default.removeItem(at: resources)
        XCTAssertTrue(FileManager.default.fileExists(atPath: products.appendingPathComponent(NihoSpeechResources.packageBundleName).path))
        let missing = try CLI.run(["probe", "--language", "xx-YY"], in: root, executable: relocated, environment: environment)
        XCTAssertEqual(missing.status, 0, missing.stdout)
        let missingStatus = try jsonObject(try XCTUnwrap(missing.lines.first))
        let missingDiarization = try XCTUnwrap(missingStatus["diarization"] as? [String: Any])
        XCTAssertEqual(missingDiarization["state"] as? String, "missing")
        XCTAssertThrowsError(try NihoSpeechResources.packageBundleURL(searchRoots: [])) { expected in
            XCTAssertEqual(missingDiarization["detail"] as? String, expected.localizedDescription)
        }
    }
}
