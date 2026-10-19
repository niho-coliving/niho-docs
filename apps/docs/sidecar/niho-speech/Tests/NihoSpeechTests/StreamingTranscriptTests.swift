import NihoOnDeviceSpeech
import XCTest
@testable import NihoSpeech

final class StreamingTranscriptTests: XCTestCase {
    private enum ExpectedFailure: Error { case stopped }

    private func result(_ text: String, start: Double, end: Double) throws -> CollectedSpeechResult {
        CollectedSpeechResult(
            text: text,
            start: start,
            end: end,
            timedText: [try TimedText(text: text, start: start, end: end)]
        )
    }

    func testSuccessEmitsEachFinalResultBeforeDone() async throws {
        let captured = CapturedOutput()
        let range = try TranscriptionRange.resolve(start: nil, end: nil, frameCount: 160_000)
        let values = try [result("一つ目", start: 1, end: 2), result("二つ目", start: 3, end: 4)]
        var completed = try await streamFinalResults(
            AsyncStream<CollectedSpeechResult>(bufferingPolicy: .unbounded) { continuation in
                for value in values {
                    continuation.yield(value)
                }
                continuation.finish()
            },
            collector: StreamingTranscriptCollector(range: range, speakerMap: nil, output: captured.output),
            transform: { $0 }
        )
        XCTAssertEqual(captured.lines.filter { $0.contains(#""type":"segment""#) }.count, 2)
        XCTAssertFalse(captured.lines.contains { $0.contains(#""type":"done""#) })
        completed.finish(durationMs: 10)
        XCTAssertTrue(captured.lines.last?.contains(#""type":"done""#) == true)
    }

    func testFailureKeepsAlreadyEmittedMappedText() async throws {
        let captured = CapturedOutput()
        let range = try TranscriptionRange.resolve(start: nil, end: nil, frameCount: 160_000)
        let map = try SpeakerMap(duration: 10, turns: [SpeakerTurn(start: 0, end: 10, id: 1)])
        let first = try result("確定済み", start: 1, end: 2)
        let stream = AsyncThrowingStream<CollectedSpeechResult, Error> { continuation in
            continuation.yield(first)
            continuation.finish(throwing: ExpectedFailure.stopped)
        }
        do {
            _ = try await streamFinalResults(
                stream,
                collector: StreamingTranscriptCollector(range: range, speakerMap: map, output: captured.output),
                transform: { $0 }
            )
            XCTFail("stream unexpectedly succeeded")
        } catch ExpectedFailure.stopped {
            XCTAssertTrue(captured.lines.contains { $0.contains("確定済み") && $0.contains(#""speaker":1"#) })
        }
    }

    func testCancellationKeepsAlreadyEmittedText() async throws {
        let captured = CapturedOutput()
        let range = try TranscriptionRange.resolve(start: nil, end: nil, frameCount: 160_000)
        let first = try result("取消前", start: 1, end: 2)
        let stream = AsyncThrowingStream<CollectedSpeechResult, Error> { continuation in
            continuation.yield(first)
        }
        let emitted = expectation(description: "first final result was written")
        let capturedOutput = captured.output
        let output = Output(
            line: { line in
                capturedOutput.line(line)
                if line.contains("取消前") { emitted.fulfill() }
            },
            note: capturedOutput.note
        )
        let task = Task {
            try await streamFinalResults(
                stream,
                collector: StreamingTranscriptCollector(range: range, speakerMap: nil, output: output),
                transform: { $0 }
            )
        }
        await fulfillment(of: [emitted], timeout: 5)
        XCTAssertTrue(captured.lines.contains { $0.contains("取消前") })
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("cancelled stream unexpectedly succeeded")
        } catch is CancellationError {
            XCTAssertTrue(captured.lines.contains { $0.contains("取消前") })
        }
    }
}
