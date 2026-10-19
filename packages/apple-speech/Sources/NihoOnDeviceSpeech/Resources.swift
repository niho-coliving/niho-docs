import Foundation

/// SwiftPM・iOS app・Tauri sidecarで共通の配布resource探索。
/// SwiftPMが生成する`Bundle.module`はbuild時の絶対pathへfallbackしてfatalErrorになり得るため使わない。
public enum NihoSpeechResources {
    public static let packageBundleName = "NihoOnDeviceSpeech_NihoOnDeviceSpeech.bundle"
    public static let fluidAudioBundleName = "FluidAudio_FluidAudio.bundle"
    public static let fluidAudioVersion = "0.15.6"
    public static let modelRevision = "7eab74f3463c736418d0eb10296261ae581146c9"

    public static func packageBundleURL(searchRoots: [URL]? = nil) throws -> URL {
        let roots = searchRoots ?? defaultSearchRoots()
        for root in roots {
            let candidate = root.lastPathComponent == packageBundleName
                ? root
                : root.appendingPathComponent(packageBundleName, isDirectory: true)
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory), isDirectory.boolValue {
                return candidate.standardizedFileURL
            }
        }
        throw NihoSpeechError.modelMissing("話者分離の部品がアプリにありません。アプリを更新して、もう一度お試しください。")
    }

    public static func manifestURL(searchRoots: [URL]? = nil) throws -> URL {
        let url = try packageBundleURL(searchRoots: searchRoots)
            .appendingPathComponent("diarization-model-manifest.json", isDirectory: false)
        guard FileManager.default.isReadableFile(atPath: url.path) else {
            throw NihoSpeechError.modelMissing("話者分離モデルの一覧がアプリにありません。アプリを更新して、もう一度お試しください。")
        }
        return url
    }

    public static func noticesURL(searchRoots: [URL]? = nil) throws -> URL {
        let url = try packageBundleURL(searchRoots: searchRoots).appendingPathComponent("Notices", isDirectory: true)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw NihoSpeechError.modelMissing("音声認識のライセンス表示がアプリにありません。アプリを更新して、もう一度お試しください。")
        }
        return url
    }

    static func defaultSearchRoots() -> [URL] {
        var roots: [URL] = []
        let codeBundle = Bundle(for: NihoSpeechResourceAnchor.self)
        if let resource = codeBundle.resourceURL { roots.append(resource) }
        roots.append(codeBundle.bundleURL)
        roots.append(codeBundle.bundleURL.deletingLastPathComponent())
        if let resource = Bundle.main.resourceURL { roots.append(resource) }
        roots.append(Bundle.main.bundleURL)
        if let executable = Bundle.main.executableURL ?? executableFromArguments() {
            let directory = executable.deletingLastPathComponent()
            roots.append(directory)
            roots.append(directory.deletingLastPathComponent().appendingPathComponent("Resources", isDirectory: true))
            var ancestor = directory
            for _ in 0 ..< 4 {
                if ancestor.pathExtension == "xctest" {
                    roots.append(ancestor.deletingLastPathComponent())
                    break
                }
                ancestor.deleteLastPathComponent()
            }
        }
        var seen = Set<String>()
        return roots.map(\.standardizedFileURL).filter { seen.insert($0.path).inserted }
    }

    private static func executableFromArguments() -> URL? {
        guard let argument = CommandLine.arguments.first, !argument.isEmpty else { return nil }
        return URL(fileURLWithPath: argument).standardizedFileURL
    }
}

private final class NihoSpeechResourceAnchor: NSObject {}
