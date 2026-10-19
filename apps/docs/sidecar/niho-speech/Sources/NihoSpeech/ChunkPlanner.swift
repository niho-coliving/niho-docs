/// `planArticleAudioChunks` (apps/api/src/ops/article-authoring-gemini-transcribe.ts),
/// ported line for line: cut at the silence midpoint nearest to each target
/// k × target (k = 1, 2, …, never within `min` of the end) that lies within
/// ±window and at least `min` after the previous cut, else at the target
/// itself; a last chunk shorter than `min` merges into the one before;
/// audio no longer than the target is one chunk.
enum ChunkPlanner {
    /// Bound both planner work and the number of chunks emitted for one input.
    static let maximumCuts = 10_000

    struct Chunk: Equatable {
        let index: Int
        let startSec: Double
        let endSec: Double
    }

    enum PlanError: Error, Equatable {
        /// The TS `article_transcribe_gemini_audio_failed:duration_unreadable`.
        case durationUnreadable
        case invalidParameters
        case tooManyCuts
    }

    /// Check the target count before scanning every sample for silences.
    static func validate(
        durationSec: Double,
        targetChunkSec: Double,
        searchWindowSec: Double,
        minChunkSec: Double
    ) throws {
        guard durationSec.isFinite, durationSec > 0 else {
            throw PlanError.durationUnreadable
        }
        guard targetChunkSec.isFinite, targetChunkSec > 0,
              searchWindowSec.isFinite, searchWindowSec >= 0,
              minChunkSec.isFinite, minChunkSec > 0 else {
            throw PlanError.invalidParameters
        }

        let lastAllowedTarget = durationSec - minChunkSec
        guard lastAllowedTarget > 0 else { return }
        let targetCount = (lastAllowedTarget / targetChunkSec).rounded(.up) - 1
        guard targetCount <= Double(maximumCuts) else {
            throw PlanError.tooManyCuts
        }
    }

    static func plan(
        durationSec: Double,
        silenceMidpointsSec: [Double],
        targetChunkSec: Double,
        searchWindowSec: Double,
        minChunkSec: Double
    ) throws -> [Chunk] {
        try validate(
            durationSec: durationSec,
            targetChunkSec: targetChunkSec,
            searchWindowSec: searchWindowSec,
            minChunkSec: minChunkSec
        )
        if durationSec <= targetChunkSec {
            return [Chunk(index: 0, startSec: 0, endSec: durationSec)]
        }
        let silences = silenceMidpointsSec
            .filter { $0.isFinite && $0 > 0 && $0 < durationSec }
            .sorted()
        var cuts: [Double] = []
        var previousCut = 0.0
        var k = 1
        while Double(k) * targetChunkSec < durationSec - minChunkSec {
            guard k <= maximumCuts else { throw PlanError.tooManyCuts }
            let target = Double(k) * targetChunkSec
            k += 1
            var best: Double?
            for midpoint in silences {
                if abs(midpoint - target) > searchWindowSec { continue }
                if midpoint - previousCut < minChunkSec { continue }
                if best == nil || abs(midpoint - target) < abs(best! - target) { best = midpoint }
            }
            let cut = best ?? target
            if cut - previousCut < minChunkSec { continue }
            cuts.append(cut)
            previousCut = cut
        }
        if let lastCut = cuts.last, durationSec - lastCut < minChunkSec {
            cuts.removeLast()
        }
        let boundaries = [0] + cuts + [durationSec]
        return boundaries.indices.dropLast().map {
            Chunk(index: $0, startSec: boundaries[$0], endSec: boundaries[$0 + 1])
        }
    }
}
