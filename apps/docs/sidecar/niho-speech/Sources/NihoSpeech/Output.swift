import Darwin
import Synchronization

/// Writes whole lines to a file descriptor under one lock: each line goes out
/// in a single `write(2)` (repeated only after a partial write), so lines
/// written from concurrent tasks never interleave.
final class LineWriter: Sendable {
    static let standardOutput = LineWriter(fileDescriptor: STDOUT_FILENO)
    static let standardError = LineWriter(fileDescriptor: STDERR_FILENO)

    private let descriptor: Mutex<Int32>

    init(fileDescriptor: Int32) {
        descriptor = Mutex(fileDescriptor)
    }

    func write(_ line: String) {
        var bytes = Array(line.utf8)
        bytes.append(0x0A)
        descriptor.withLock { fd in
            bytes.withUnsafeBytes { raw in
                var offset = 0
                while offset < raw.count {
                    let written = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
                    if written > 0 {
                        offset += written
                    } else if written < 0, errno == EINTR {
                        continue
                    } else {
                        return // Nobody reads the stream any more.
                    }
                }
            }
        }
    }
}

/// Where a command's output goes: `line` = one stdout line (JSON, or the
/// usage text), `note` = a human note on stderr. Tests capture both.
struct Output: Sendable {
    let line: @Sendable (String) -> Void
    let note: @Sendable (String) -> Void

    static let standard = Output(
        line: { LineWriter.standardOutput.write($0) },
        note: { LineWriter.standardError.write("\(Tool.name): \($0)") }
    )

    func json(_ fields: KeyValuePairs<String, JSONValue>) {
        line(JSONLine.encode(fields))
    }
}
