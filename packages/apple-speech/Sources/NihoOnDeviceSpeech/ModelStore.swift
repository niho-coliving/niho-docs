import CryptoKit
import FluidAudio
import Foundation

public struct DiarizationModelManifest: Codable, Equatable, Sendable {
    public struct File: Codable, Equatable, Sendable {
        public let path: String
        public let bytes: Int64
        public let sha256: String
    }

    public let repository: String
    public let revision: String
    public let files: [File]

    public static func bundled(resourceRoots: [URL]? = nil) throws -> DiarizationModelManifest {
        let url = try NihoSpeechResources.manifestURL(searchRoots: resourceRoots)
        do {
            let manifest = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
            try manifest.validate()
            return manifest
        } catch let error as NihoSpeechError {
            throw error
        } catch {
            throw NihoSpeechError.modelCorrupt("話者分離モデルの一覧を読めません: \(error.localizedDescription)")
        }
    }

    public func validate() throws {
        guard repository == "FluidInference/speaker-diarization-coreml",
              revision == "7eab74f3463c736418d0eb10296261ae581146c9",
              files.count == 21,
              Set(files.map(\.path)).count == files.count
        else {
            throw NihoSpeechError.modelCorrupt("話者分離モデルの固定一覧が不正です。")
        }
        for file in files {
            guard Self.safeRelativePath(file.path), file.bytes > 0,
                  file.sha256.count == 64,
                  file.sha256.allSatisfy({ $0.isHexDigit && !$0.isUppercase })
            else {
                throw NihoSpeechError.modelCorrupt("話者分離モデルのファイル情報が不正です。")
            }
        }
    }

    static func safeRelativePath(_ path: String) -> Bool {
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"), !path.contains("\0") else { return false }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        return !parts.isEmpty && parts.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }
}

public enum DiarizationModelState: String, Codable, Sendable {
    case ready
    case missing
    case corrupt
}

public struct DiarizationModelStatus: Codable, Equatable, Sendable {
    public let state: DiarizationModelState
    public let detail: String?

    public init(state: DiarizationModelState, detail: String? = nil) {
        self.state = state
        self.detail = detail
    }
}

/// 固定 revision のモデルだけを準備する。FluidAudio の自動 download は使わない。
public actor DiarizationModelStore {
    public static let repositoryFolder = Repo.diarizer.folderName
    private static let readyMarker = ".niho-model-manifest.json"

    public let cacheRoot: URL
    private let manifest: DiarizationModelManifest
    private let session: URLSession
    private var preparing = false

    public init(cacheRoot: URL, session: URLSession = .shared) throws {
        ModelHub.offlineMode = true
        self.cacheRoot = cacheRoot.standardizedFileURL
        manifest = try .bundled()
        self.session = session
    }

    public static func defaultCacheRoot(applicationIdentifier: String = "life.niho.docs") throws -> URL {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw NihoSpeechError.modelMissing("話者分離モデルの保存先を用意できません。")
        }
        return support.appendingPathComponent(applicationIdentifier, isDirectory: true)
            .appendingPathComponent("SpeechModels", isDirectory: true)
    }

    public func status() -> DiarizationModelStatus {
        do {
            try Self.validateInstalled(at: cacheRoot, manifest: manifest)
            return .init(state: .ready)
        } catch let error as NihoSpeechError {
            let repo = cacheRoot.appendingPathComponent(Self.repositoryFolder, isDirectory: true)
            let exists = FileManager.default.fileExists(atPath: repo.path)
            return .init(state: exists ? .corrupt : .missing, detail: error.localizedDescription)
        } catch {
            return .init(state: .corrupt, detail: error.localizedDescription)
        }
    }

    /// URLSession downloadTask の一時ファイルを、1 MiB ずつ hash してから private staging へ置く。
    public func prepare(progress: (@Sendable (Int, Int) -> Void)? = nil) async throws {
        ModelHub.offlineMode = true
        if status().state == .ready { return }
        guard !preparing else {
            throw NihoSpeechError.modelDownload("話者分離モデルは別の処理で準備中です。完了後にもう一度お試しください。")
        }
        preparing = true
        defer { preparing = false }

        let fileManager = FileManager.default
        try fileManager.createDirectory(
            at: cacheRoot,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let stagingRoot = cacheRoot.appendingPathComponent(".niho-staging-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(
            at: stagingRoot,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        defer { try? fileManager.removeItem(at: stagingRoot) }
        let stagingRepo = stagingRoot.appendingPathComponent(Self.repositoryFolder, isDirectory: true)
        try fileManager.createDirectory(at: stagingRepo, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])

        for (index, file) in manifest.files.enumerated() {
            try Task.checkCancellation()
            guard let url = downloadURL(for: file.path) else {
                throw NihoSpeechError.modelCorrupt("話者分離モデルのURLを作れません。")
            }
            let temporary = stagingRoot.appendingPathComponent(".download-\(UUID().uuidString)")
            do {
                try await download(url, to: temporary)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                if Task.isCancelled || (error as NSError).code == NSURLErrorCancelled {
                    throw CancellationError()
                }
                throw NihoSpeechError.modelDownload("話者分離モデルを取得できません: \(error.localizedDescription)")
            }
            defer { try? fileManager.removeItem(at: temporary) }
            try Self.validateFile(at: temporary, expected: file)
            let destination = stagingRepo.appendingPathComponent(file.path, isDirectory: false)
            try fileManager.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try fileManager.moveItem(at: temporary, to: destination)
            try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
            progress?(index + 1, manifest.files.count)
        }

        let marker = stagingRepo.appendingPathComponent(Self.readyMarker)
        try JSONEncoder().encode(manifest).write(to: marker, options: [.atomic, .completeFileProtection])
        try Self.validateRepo(at: stagingRepo, manifest: manifest)
        try Task.checkCancellation()

        let installed = cacheRoot.appendingPathComponent(Self.repositoryFolder, isDirectory: true)
        if fileManager.fileExists(atPath: installed.path) {
            do {
                _ = try fileManager.replaceItemAt(installed, withItemAt: stagingRepo)
            } catch {
                throw NihoSpeechError.modelDownload("壊れた話者分離モデルを置き換えられません: \(error.localizedDescription)")
            }
        } else {
            try fileManager.moveItem(at: stagingRepo, to: installed)
        }
        try Self.validateInstalled(at: cacheRoot, manifest: manifest)
    }

    public func readyModelsRoot() throws -> URL {
        ModelHub.offlineMode = true
        try Self.validateInstalled(at: cacheRoot, manifest: manifest)
        return cacheRoot
    }

    private func downloadURL(for path: String) -> URL? {
        guard DiarizationModelManifest.safeRelativePath(path) else { return nil }
        var url = URL(string: "https://huggingface.co")!
        for component in manifest.repository.split(separator: "/") { url.appendPathComponent(String(component)) }
        url.appendPathComponent("resolve")
        url.appendPathComponent(manifest.revision)
        for component in path.split(separator: "/") { url.appendPathComponent(String(component)) }
        guard url.scheme == "https", url.host == "huggingface.co" else { return nil }
        return url
    }

    private func download(_ url: URL, to destination: URL) async throws {
        let holder = DownloadTaskHolder()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let task = session.downloadTask(with: url) { temporary, response, error in
                    if let error {
                        continuation.resume(throwing: error)
                        return
                    }
                    guard let http = response as? HTTPURLResponse, http.statusCode == 200, let temporary else {
                        continuation.resume(throwing: NihoSpeechError.modelDownload("モデルの取得先がHTTP 200を返しませんでした。"))
                        return
                    }
                    do {
                        try FileManager.default.moveItem(at: temporary, to: destination)
                        continuation.resume()
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
                holder.set(task)
                task.resume()
            }
        } onCancel: {
            holder.cancel()
        }
    }

    private static func validateInstalled(at root: URL, manifest: DiarizationModelManifest) throws {
        guard FileManager.default.fileExists(atPath: root.path) else {
            throw NihoSpeechError.modelMissing("話者分離モデルは未取得です。")
        }
        try rejectSymlink(root)
        let repo = root.appendingPathComponent(repositoryFolder, isDirectory: true)
        guard FileManager.default.fileExists(atPath: repo.path) else {
            throw NihoSpeechError.modelMissing("話者分離モデルは未取得です。")
        }
        try validateRepo(at: repo, manifest: manifest)
    }

    private static func validateRepo(at repo: URL, manifest: DiarizationModelManifest) throws {
        try rejectSymlink(repo)
        let marker = repo.appendingPathComponent(readyMarker)
        guard let markerData = try? Data(contentsOf: marker),
              let installed = try? JSONDecoder().decode(DiarizationModelManifest.self, from: markerData),
              installed == manifest
        else {
            throw NihoSpeechError.modelCorrupt("話者分離モデルの準備記録が壊れています。設定から再取得してください。")
        }
        for file in manifest.files {
            let url = repo.appendingPathComponent(file.path)
            var cursor = repo
            for component in file.path.split(separator: "/") {
                cursor.appendPathComponent(String(component))
                try rejectSymlink(cursor)
            }
            try validateFile(at: url, expected: file)
        }
    }

    private static func rejectSymlink(_ url: URL) throws {
        guard let type = try? FileManager.default.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType,
              type != .typeSymbolicLink
        else {
            throw NihoSpeechError.modelCorrupt("話者分離モデルの保存先にシンボリックリンクがあります。")
        }
    }

    private static func validateFile(at url: URL, expected: DiarizationModelManifest.File) throws {
        try rejectSymlink(url)
        guard let size = try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber,
              size.int64Value == expected.bytes
        else {
            throw NihoSpeechError.modelCorrupt("話者分離モデルの容量が一致しません（\(expected.path)）。設定から再取得してください。")
        }
        let digest: String
        do {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var hash = SHA256()
            while let data = try handle.read(upToCount: 1_048_576), !data.isEmpty { hash.update(data: data) }
            digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
        } catch {
            throw NihoSpeechError.modelCorrupt("話者分離モデルを検証できません（\(expected.path)）。")
        }
        guard digest == expected.sha256 else {
            throw NihoSpeechError.modelCorrupt("話者分離モデルが壊れています（\(expected.path)）。設定から再取得してください。")
        }
    }
}

private final class DownloadTaskHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionDownloadTask?
    private var cancelled = false

    func set(_ task: URLSessionDownloadTask) {
        lock.lock()
        self.task = task
        let shouldCancel = cancelled
        lock.unlock()
        if shouldCancel { task.cancel() }
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let task = task
        lock.unlock()
        task?.cancel()
    }
}
