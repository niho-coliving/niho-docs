import Darwin
import System

/// What one `convert` input may be (spec §6.2): at most 2 GiB and 6 hours of
/// audio. The app applies the same 6 hours to the sum over a project's files.
enum InputLimits {
    static let maximumFileBytes: Int64 = 2 * 1024 * 1024 * 1024
    static let maximumDurationSec = 6 * 60 * 60

    /// The frames of the 16 kHz WAV `maximumDurationSec` long.
    static var maximumFrames: Int { WAVFormat.frame(seconds: Double(maximumDurationSec)) }
}

/// Opens an input for reading and maps the failure: missing →
/// `input_not_found`, no permission → `permission_denied`, not a regular file
/// or anything else → `input_unreadable`.
enum InputFile {
    static func open(_ path: String) throws -> FileDescriptor {
        let descriptor: FileDescriptor
        do {
            descriptor = try FileDescriptor.open(FilePath(path), .readOnly, options: [.closeOnExec])
        } catch let error as Errno {
            throw toolError(error, path: path)
        }
        var info = stat()
        guard fstat(descriptor.rawValue, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
            try? descriptor.close()
            throw ToolError.inputUnreadable("\(path) is not a regular file")
        }
        return descriptor
    }

    /// For inputs another framework opens itself (convert's AVFoundation).
    static func check(_ path: String) throws {
        let descriptor = try open(path)
        try? descriptor.close()
    }

    /// The size in bytes of the regular file at `path` (the failures of `open`).
    static func byteCount(_ path: String) throws -> Int64 {
        let descriptor = try open(path)
        defer { try? descriptor.close() }
        var info = stat()
        guard fstat(descriptor.rawValue, &info) == 0 else {
            throw ToolError.inputUnreadable("cannot read the size of \(path)")
        }
        return Int64(info.st_size)
    }

    static func toolError(_ error: Errno, path: String) -> ToolError {
        switch error {
        case .noSuchFileOrDirectory, .notDirectory:
            .inputNotFound("input not found: \(path)")
        case .permissionDenied, .notPermitted:
            .permissionDenied("no permission to read \(path) (\(error))")
        default:
            .inputUnreadable("cannot open \(path): \(error)")
        }
    }
}
