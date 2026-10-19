import XCTest
@testable import NihoSpeech

/// The TS cases of `planArticleAudioChunks` (apps/api) plus edge cases.
final class ChunkPlannerTests: XCTestCase {
    private func plan(
        _ durationSec: Double,
        _ silences: [Double],
        target: Double = 900,
        window: Double = 60,
        min: Double = 60
    ) throws -> [[Double]] {
        try ChunkPlanner.plan(
            durationSec: durationSec,
            silenceMidpointsSec: silences,
            targetChunkSec: target,
            searchWindowSec: window,
            minChunkSec: min
        ).map { [$0.startSec, $0.endSec] }
    }

    func testFlashParityCases() throws {
        XCTAssertEqual(try plan(600, [100]), [[0, 600]])
        XCTAssertEqual(try plan(900, []), [[0, 900]])
        XCTAssertEqual(try plan(2000, [100, 850, 890, 945, 1830]), [[0, 890], [890, 1830], [1830, 2000]])
        XCTAssertEqual(try plan(2000, [700, 1200]), [[0, 900], [900, 1800], [1800, 2000]])
        XCTAssertEqual(try plan(1830, []), [[0, 900], [900, 1830]])
        XCTAssertEqual(try plan(1870, [1830]), [[0, 900], [900, 1870]])
    }

    func testProParityCase() throws {
        XCTAssertEqual(try plan(700, [270, 610], target: 300, window: 40, min: 60), [[0, 270], [270, 610], [610, 700]])
    }

    func testRejectsUnreadableDuration() {
        for duration in [0, -1, .nan, .infinity] {
            XCTAssertThrowsError(try plan(duration, []), "\(duration)") { error in
                XCTAssertEqual(error as? ChunkPlanner.PlanError, .durationUnreadable)
            }
        }
    }

    func testPlannerRejectsTooManyCutsImmediately() {
        XCTAssertThrowsError(
            try ChunkPlanner.plan(
                durationSec: 3_600,
                silenceMidpointsSec: [],
                targetChunkSec: 1e-9,
                searchWindowSec: 60,
                minChunkSec: 60
            )
        ) { error in
            XCTAssertEqual(error as? ChunkPlanner.PlanError, .tooManyCuts)
        }
    }

    func testIndexesAndContiguousChunks() throws {
        let chunks = try ChunkPlanner.plan(
            durationSec: 2000, silenceMidpointsSec: [890, 1830],
            targetChunkSec: 900, searchWindowSec: 60, minChunkSec: 60
        )
        XCTAssertEqual(chunks.map(\.index), [0, 1, 2])
        XCTAssertEqual(zip(chunks, chunks.dropFirst()).map { $0.endSec == $1.startSec }, [true, true])
    }

    func testEdgeCases() throws {
        // Unsorted, duplicated and out-of-range silences are sorted and filtered.
        XCTAssertEqual(try plan(2000, [1830, .nan, 890, -5, 0, 2000, 3000, 890]), [[0, 890], [890, 1830], [1830, 2000]])
        // Equally near silences: the earlier one wins (strict <).
        XCTAssertEqual(try plan(2000, [920, 880]), [[0, 880], [880, 1800], [1800, 2000]])
        // No target before duration - min: one chunk even past the target.
        XCTAssertEqual(try plan(950, []), [[0, 950]])
        XCTAssertEqual(try plan(1000, []), [[0, 900], [900, 1000]])
        // A silence closer than min to the previous cut (or to 0) is not a candidate.
        XCTAssertEqual(
            try plan(400, [50, 140, 160], target: 100, window: 50, min: 60),
            [[0, 140], [140, 200], [200, 300], [300, 400]]
        )
        // A target closer than min to the previous cut is skipped.
        XCTAssertEqual(try plan(400, [190], target: 100, window: 95, min: 60), [[0, 190], [190, 300], [300, 400]])
        // Window 0: only a silence exactly on the target.
        XCTAssertEqual(try plan(2000, [899, 1800], window: 0), [[0, 900], [900, 1800], [1800, 2000]])
        // The fixture's plan (E2E): one cut in the pause.
        XCTAssertEqual(try plan(13.35, [7.3605, 13.16], target: 6, window: 3, min: 2), [[0, 7.3605], [7.3605, 13.35]])
    }
}
