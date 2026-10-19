import AVFoundation
import Foundation
import XCTest
@testable import NihoOnDeviceSpeech

/// 固定モデルと合成音声を明示指定したときだけ動く、実推論の検証。
/// 認識精度のbenchmarkではなく、モデル読出し・人数指定・取消の動作を確かめる。
final class DiarizerSmokeTests: XCTestCase {
    func testPinnedModelProcessesSyntheticAudioOffline() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let audioPath = environment["NIHO_DIARIZATION_E2E_AUDIO"],
              let modelsPath = environment["NIHO_DIARIZATION_E2E_MODEL_ROOT"] else {
            throw XCTSkip("set NIHO_DIARIZATION_E2E_AUDIO and NIHO_DIARIZATION_E2E_MODEL_ROOT for real model inference")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("niho-diarization-smoke-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let repository = root.appendingPathComponent(DiarizationModelStore.repositoryFolder)
        try FileManager.default.copyItem(at: URL(fileURLWithPath: modelsPath), to: repository)
        let manifest = try DiarizationModelManifest.bundled()
        try JSONEncoder().encode(manifest).write(to: repository.appendingPathComponent(".niho-model-manifest.json"), options: .atomic)
        let store = try DiarizationModelStore(cacheRoot: root)
        let status = await store.status()
        XCTAssertEqual(status.state, .ready)

        let audioURL = URL(fileURLWithPath: audioPath)
        let file = try AVAudioFile(forReading: audioURL)
        let duration = Double(file.length) / file.processingFormat.sampleRate
        let diarizer = NihoDiarizer(modelStore: store)
        let started = Date()
        let map = try await diarizer.diarize(audioURL, duration: duration, constraint: .exactly(2))
        XCTAssertFalse(map.turns.isEmpty)
        XCTAssertEqual(Set(map.turns.map(\.id)).count, 2)
        XCTAssertEqual(map.duration, duration, accuracy: 0.02)
        var previous = 0.0
        for turn in map.turns {
            XCTAssertTrue(turn.start.isFinite && turn.end.isFinite)
            XCTAssertGreaterThanOrEqual(turn.start, previous)
            XCTAssertGreaterThan(turn.end, turn.start)
            XCTAssertLessThanOrEqual(turn.end, duration + 0.02)
            previous = turn.start
        }
        let summary: [String: Any] = [
            "source": "synthetic", "audioSeconds": duration, "requestedSpeakers": 2,
            "speakers": Set(map.turns.map(\.id)).count,
            "turns": map.turns.count, "elapsedSeconds": Date().timeIntervalSince(started),
        ]
        let data = try JSONSerialization.data(withJSONObject: summary, options: .sortedKeys)
        print("NIHO_DIARIZATION_SMOKE \(String(decoding: data, as: UTF8.self))")

        let cancelled = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await diarizer.diarize(audioURL, duration: duration)
        }
        do {
            _ = try await cancelled.value
            XCTFail("cancelled inference unexpectedly returned a result")
        } catch is CancellationError {
            // 取消を失敗へ包み直さず、そのまま返す。
        }
    }
}
