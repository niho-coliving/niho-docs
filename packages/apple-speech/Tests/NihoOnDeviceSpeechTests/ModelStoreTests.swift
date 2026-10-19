import Foundation
import XCTest
@testable import NihoOnDeviceSpeech

final class ModelStoreTests: XCTestCase {
    func testPinnedManifestIsCompleteAndImmutable() throws {
        let manifest = try DiarizationModelManifest.bundled()
        XCTAssertEqual(manifest.repository, "FluidInference/speaker-diarization-coreml")
        XCTAssertEqual(manifest.revision, "7eab74f3463c736418d0eb10296261ae581146c9")
        XCTAssertEqual(manifest.files.count, 21)
        XCTAssertEqual(manifest.files.reduce(Int64(0)) { $0 + $1.bytes }, 21_599_417)
        XCTAssertEqual(Set(manifest.files.map(\.path)).count, 21)
    }

    func testManifestRejectsTraversalAndSymlinkCache() async throws {
        var manifest = try DiarizationModelManifest.bundled()
        let bad = DiarizationModelManifest.File(path: "../outside", bytes: 1, sha256: String(repeating: "0", count: 64))
        manifest = DiarizationModelManifest(
            repository: manifest.repository,
            revision: manifest.revision,
            files: [bad] + Array(manifest.files.dropFirst())
        )
        XCTAssertThrowsError(try manifest.validate())

        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let target = root.appendingPathComponent("real")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        let link = root.appendingPathComponent(DiarizationModelStore.repositoryFolder)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DiarizationModelStore(cacheRoot: root)
        let status = await store.status()
        XCTAssertEqual(status.state, .corrupt)
    }

    func testMissingCacheIsNotReady() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DiarizationModelStore(cacheRoot: root)
        let status = await store.status()
        XCTAssertEqual(status.state, .missing)
    }

    func testMissingResourceIsTypedInsteadOfCrashingBundleModule() {
        XCTAssertThrowsError(try DiarizationModelManifest.bundled(resourceRoots: [])) { error in
            guard case NihoSpeechError.modelMissing = error else {
                return XCTFail("unexpected error: \(error)")
            }
        }
    }

    func testDownloadedLocalFixtureIsReadyAndCorruptionIsDetected() async throws {
        guard let path = ProcessInfo.processInfo.environment["NIHO_DIARIZATION_E2E_MODEL_ROOT"] else {
            throw XCTSkip("set NIHO_DIARIZATION_E2E_MODEL_ROOT for pinned local model validation")
        }
        let fixture = URL(fileURLWithPath: path, isDirectory: true)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let repo = root.appendingPathComponent(DiarizationModelStore.repositoryFolder)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: fixture, to: repo)
        let manifest = try DiarizationModelManifest.bundled()
        try JSONEncoder().encode(manifest).write(to: repo.appendingPathComponent(".niho-model-manifest.json"))
        defer { try? FileManager.default.removeItem(at: root) }

        let store = try DiarizationModelStore(cacheRoot: root)
        let ready = await store.status()
        XCTAssertEqual(ready.state, .ready)
        try Data("broken".utf8).write(to: repo.appendingPathComponent(manifest.files[0].path))
        let corrupt = await store.status()
        XCTAssertEqual(corrupt.state, .corrupt)
    }

    func testCancellationNeverMarksPartialCacheReady() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HangingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DiarizationModelStore(cacheRoot: root, session: session)
        let task = Task { try await store.prepare() }
        try await Task.sleep(for: .milliseconds(50))
        task.cancel()
        do {
            try await task.value
            XCTFail("cancelled preparation unexpectedly succeeded")
        } catch {
            XCTAssertTrue(error is CancellationError || (error as NSError).code == NSURLErrorCancelled)
        }
        let status = await store.status()
        XCTAssertNotEqual(status.state, .ready)
        let children = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        XCTAssertFalse(children.contains { $0.hasPrefix(".niho-staging-") })
    }

    func testConcurrentPrepareIsRejectedAndCancellationCleansTheWinner() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HangingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DiarizationModelStore(cacheRoot: root, session: session)
        let first = Task { try await store.prepare() }
        try await Task.sleep(for: .milliseconds(50))
        do {
            try await store.prepare()
            XCTFail("concurrent preparation unexpectedly succeeded")
        } catch NihoSpeechError.modelDownload(let message) {
            XCTAssertTrue(message.contains("準備中"))
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        first.cancel()
        _ = try? await first.value
        let status = await store.status()
        XCTAssertNotEqual(status.state, .ready)
        let children = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        XCTAssertFalse(children.contains { $0.hasPrefix(".niho-staging-") })
    }
}

private final class HangingURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {}
    override func stopLoading() {}
}
