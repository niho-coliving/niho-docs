# speech-bench — 合成会話による文字・話者・資源の固定ベンチ（#18641 D1）

Apple SpeechTranscriber と FluidAudio OfflineDiarizer の組み合わせを、同じ合成音声で繰り返し測る。文字の誤り、話者の誤り、相づちの扱い、実時間とメモリを**別々に**数える。合成音声（macOS `say`）なので、実会議の精度・雑音・重なりの代わりにはならない（実録音での受入は #18645）。

| ファイル | 役割 |
|---|---|
| `generate.mjs` | 固定 seed の会話台本を `say` で読み上げ、16 kHz・mono の WAV、AAC 32 kbps の m4a、正解（`*.truth.json`：話者ターン・本文・相づち）を書く |
| `score.mjs` | 正解と認識結果（sidecar の JSONL か `niho.speech-result` v1）を照らす |
| `run-mac.mjs` | `niho-speech` の `convert → diarize → transcribe --speaker-map` を段階ごとに `/usr/bin/time -l` で測り、`summary.json` にまとめる |
| `test/score.test.mjs` | 採点と生成の単体テスト（`node --test apps/docs/sidecar/speech-bench/test/*.test.mjs`） |

データセット（`generate.mjs` の `DATASETS`）: `d1m-2spk`・`d15m-2spk`・`d60m-2spk`・`d15m-3spk`・`d15m-4spk`。声は Kyoko・Reed・Flo・Grandpa の順に使う。発言の間は 0.3〜1.2 秒の無音で、約 4 回に 1 回、別の人の短い相づち（はい・ええ・なるほど など）を挟む。重なりは作らない。数字・英字は読み上げと認識の表記が揃わないので台本に入れない。

## 指標

- `cer`: 正解と認識の全文を NFKC・空白と句読点の除去・カタカナ→ひらがなに揃えた文字誤り率（漢字の表記ゆれは誤りとして残る）。
- `attribution`: 認識した文字のうち、話者が正しい（`correctCharRatio`）・取り違え（`confusedCharRatio`）・「話者?」（`unknownCharRatio`）・時刻なし（`untimedCharRatio`）の割合。仮説の話者番号は正解の話者と 1 対 1 に、重みの和が最大になるよう対応させる。
- `backchannel`: 正解の相づちを前後 1 秒の認識結果で拾えた割合（`recall`）と、そのうち話者まで合った割合。
- `diarization`: 話者分離の結果（`speaker-map.json`）だけの DER（10 ms 格子・境界の前後 0.25 秒は数えない）と miss・false alarm・confusion。

## 実行

```bash
node apps/docs/sidecar/speech-bench/generate.mjs --out <bench>
swift build -c release --package-path apps/docs/sidecar/niho-speech --scratch-path <build>
<build>/release/niho-speech download --language ja   # 固定 revision の話者分離モデル（明示操作）
node apps/docs/sidecar/speech-bench/run-mac.mjs --bin <build>/release/niho-speech --bench <bench> --out <out>
```

60 分の生成は M1 Max で約 14 分かかる。`download` はアプリと同じ `~/Library/Application Support/life.niho.docs/SpeechModels` に入れる（HOME を変えても場所は変わらない）。生成した音声・正解・結果はリポジトリに入れない。iPhone では `apps/mobile/scripts/local-speech-device-probe-harness.swift` の受入シナリオが同じ m4a を処理し、`niho.speech-result` v1 を書き出す（`ops/runbooks/mobile-native-app/local-speech-device-probe.md`）。その JSON も `score.mjs --result` で採点できる。

結果と、これを使って見つけた不具合（結果の最初の文字だけが「話者?」に分かれていた）は `specs/initiatives/niho-docs-on-device-speech.md`「品質と資源の基準線」。
