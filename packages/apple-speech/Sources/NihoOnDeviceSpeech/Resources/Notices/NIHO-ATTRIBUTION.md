# On-device speaker diarization attribution

NIHO bundles FluidAudio 0.15.6 and the `FluidInference/speaker-diarization-coreml`
model snapshot at immutable revision
`7eab74f3463c736418d0eb10296261ae581146c9` for on-device speaker diarization.

The model artifacts are modified Core ML conversions. Attribution belongs to
pyannote, WeSpeaker, BUT Speech@FIT, and Fluid Inference. The bundled
`model-NOTICE.md`, `model-LICENSE`, and `model-README.md` retain the precise
license scope, upstream links, conversion notes, and citations for speaker
segmentation, embedding, and VBx clustering. FluidAudio and its relevant
third-party notices are retained beside them.

NIHO does not redistribute the model binaries in the application. The pinned
files are downloaded only after an explicit preparation action and verified
against the bundled manifest before local installation.
