# Attribution and license scope

This is a mixed-license-scope repository. Fluid Inference intends the included
CC-BY-4.0 license text to cover only the following exact Community-1-derived
artifacts and their uncompiled counterparts listed in `provenance.json`:

- `Segmentation.mlmodelc`
- `FBank.mlmodelc`
- `Embedding.mlmodelc`
- `PLDA.mlmodelc`
- `PldaRho.mlmodelc`
- `plda-parameters.json`
- `xvector-transform.json`

The underlying Community-1 pipeline is published by pyannote under CC-BY-4.0:
https://huggingface.co/pyannote/speaker-diarization-community-1

The PLDA parameters originate from Brno University of Technology / BUT
Speech@FIT. The rights holder explicitly licenses `plda.npz` and
`xvec_transform.npz` under CC-BY-4.0, including commercial use:
https://huggingface.co/BUT-FIT/diarizen-wavlm-large-s80-md/blob/6285693ddd5b38e8229acb93f864f3d04a82bee1/plda/LICENSE

Fluid Inference converted the PyTorch components to Core ML, introduced fixed
and enumerated input shapes, applied mixed-precision storage where recorded in
the model metadata, separated the FBank frontend from the embedding backend,
and compiled packages for Apple platforms.

Appropriate attribution should identify pyannote, WeSpeaker, BUT Speech@FIT,
and Fluid Inference, retain the citations in README.md, link CC-BY-4.0, and
indicate that the files are modified Core ML conversions.

## Legacy artifacts

`pyannote_segmentation.mlmodelc`, `wespeaker.mlmodelc`,
`wespeaker_v2.mlmodelc`, `wespeaker_int8.mlmodelc`, and their packages predate
the Community-1 artifact set and are not covered by the Community-1 scope
above. They are Core ML conversions of the pyannote/speaker-diarization-3.1
components, under their own upstream licenses:

| Artifact | Upstream checkpoint | License |
|---|---|---|
| `pyannote_segmentation` | [`pyannote/segmentation-3.0`](https://huggingface.co/pyannote/segmentation-3.0) @ `e66f3d3b` (Copyright (c) 2023 CNRS) | MIT |
| `wespeaker` (fp32) | [`pyannote/wespeaker-voxceleb-resnet34-LM`](https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM) @ `837717dd`, wrapping WeSpeaker's VoxCeleb ResNet34-LM | CC-BY-4.0 |
| `wespeaker_v2`, `wespeaker_int8` (byte-identical; 8-bit palettized weights) | same as `wespeaker` | CC-BY-4.0 |

The original conversion scripts were not preserved, so this was confirmed by
output parity on AMI ES2004a against the PyTorch checkpoints above (pyannote.audio
3.3.2, CPU): segmentation frame-level argmax agreement 99.98%; speaker
embeddings cosine 1.0000 (`wespeaker`) and >= 0.997 (`wespeaker_v2`/`wespeaker_int8`).

Fluid Inference converted these checkpoints to Core ML with fixed input shapes,
fused the fbank frontend into the embedding model, and palettized the
`wespeaker_v2`/`wespeaker_int8` weights to 8 bits. Attribution for the
embedding models should identify WeSpeaker, pyannote, and Fluid Inference,
link CC-BY-4.0, and indicate that the files are modified Core ML conversions.
The segmentation model's MIT notice is reproduced below.

```
MIT License

Copyright (c) 2023 CNRS

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Fluid Inference can grant rights only to the extent it is authorized to do so.
This notice does not restrict or replace rights granted directly by upstream
licensors.
