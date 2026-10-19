@preconcurrency import AVFoundation
import CoreAudio
import Foundation
import Synchronization

/// The microphone access (TCC). Checking never prompts; `request()` prompts
/// only when not determined yet. A sidecar started by NIHO docs is attributed
/// to the app (its Info.plist's NSMicrophoneUsageDescription is the prompt's text).
enum MicrophonePermission {
    static func status() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: "authorized"
        case .denied: "denied"
        case .restricted: "restricted"
        case .notDetermined: "notDetermined"
        @unknown default: "denied"
        }
    }

    /// Asks when not determined; the status afterwards.
    static func request() async -> String {
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .audio)
        }
        return status()
    }

    /// `microphone_permission_denied` unless authorized (asking first when not determined).
    static func require() async throws {
        let status = await request()
        guard status == "authorized" else {
            throw ToolError.microphonePermissionDenied(
                "microphone access is \(status); allow it in System Settings > Privacy & Security > Microphone"
            )
        }
    }
}

/// `{"status":"authorized|denied|notDetermined|restricted"}`.
enum MicStatusCommand {
    static func run(request: Bool, output: Output) async {
        let status = request ? await MicrophonePermission.request() : MicrophonePermission.status()
        output.json(["status": .string(status)])
    }
}

/// The system's default input device (Core Audio), as AVAudioEngine's input node uses it.
enum InputDevice {
    static func defaultID() -> AudioDeviceID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var device = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        guard status == noErr, device != kAudioObjectUnknown, inputChannels(device) > 0 else { return nil }
        return device
    }

    static func name(_ device: AudioDeviceID) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var name: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &name)
        guard status == noErr, let name else { return nil }
        return name.takeRetainedValue() as String
    }

    static func inputChannels(_ device: AudioDeviceID) -> Int {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }
}

/// Where `record` gets its audio. The microphone in the app; synthesized
/// audio in the tests. `start` delivers buffers to `onBuffer` from any
/// thread (one at a time) until `stop`.
protocol RecordingInput: AnyObject, Sendable {
    /// Starts delivering; the format and the device name of the first buffers.
    func start(events: RecordingInputEvents) throws -> (format: AVAudioFormat, device: String?)
    func stop()
}

/// What an input reports while running.
struct RecordingInputEvents: Sendable {
    let onBuffer: @Sendable (AVAudioPCMBuffer) -> Void
    /// The device changed: buffers from now on are in `format`.
    let onDeviceChange: @Sendable (_ format: AVAudioFormat, _ device: String?) -> Void
    /// The input ended by itself (no input device any more, or the engine failed).
    let onEnd: @Sendable (_ reason: String) -> Void
}

/// The default input device through AVAudioEngine. When the device changes
/// (a headset unplugged, another input chosen), the engine is restarted on
/// the new default device; with no input device left, the input ends.
///
/// Two locks: `lock` only guards `events` (the tap takes it briefly), and
/// `engineLock` serializes starting and stopping the engine. The tap never
/// waits for `engineLock`, so `engine.stop()` cannot wait on a blocked tap.
final class MicrophoneInput: RecordingInput, @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private let engineLock = NSLock()
    private var events: RecordingInputEvents?
    private var observer: NSObjectProtocol?

    /// `no_input_device` when there is no default input device. Never touches TCC.
    init() throws {
        guard InputDevice.defaultID() != nil else {
            throw ToolError.noInputDevice("no input device (connect a microphone)")
        }
    }

    func start(events: RecordingInputEvents) throws -> (format: AVAudioFormat, device: String?) {
        lock.withLock { self.events = events }
        observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            self?.restart()
        }
        return try engineLock.withLock { try startEngine() }
    }

    func stop() {
        lock.withLock { events = nil }
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        engineLock.withLock {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
    }

    /// Call with `engineLock` held.
    private func startEngine() throws -> (format: AVAudioFormat, device: String?) {
        guard let device = InputDevice.defaultID() else {
            throw ToolError.noInputDevice("no input device (connect a microphone)")
        }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            throw ToolError.noInputDevice("the input device has no channels")
        }
        input.removeTap(onBus: 0)
        // About 0.1 s per buffer (the level lines come every 0.2 s of audio).
        let frames = AVAudioFrameCount(max(1024, format.sampleRate / 10))
        input.installTap(onBus: 0, bufferSize: frames, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            let events = self.lock.withLock { self.events }
            events?.onBuffer(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw ToolError.recordingFailed("cannot start the input: \(ErrorText.describe(error))")
        }
        return (format, InputDevice.name(device))
    }

    /// The engine stops itself on a configuration change; start it again on the (new) default device.
    private func restart() {
        // Recheck under engineLock: stop() clears events before waiting for this lock. If restart
        // took its snapshot first but stop() stopped the engine first, a stale snapshot must not
        // start capture again after the user has stopped recording.
        let result: Result<(format: AVAudioFormat, device: String?), Error>? = engineLock.withLock {
            guard lock.withLock({ self.events != nil }) else { return nil }
            engine.stop()
            return Result { try startEngine() }
        }
        guard let result, let events = lock.withLock({ self.events }) else { return }
        switch result {
        case let .success((format, device)):
            events.onDeviceChange(format, device)
        case let .failure(error):
            events.onEnd(ErrorText.describe(error))
        }
    }
}
