# NIHO docs remote runner

R3 #18628 の共有文字起こしservice。Node 24 ESM、追加依存なし。実行先はmacOS 26以降 / Apple Silicon。R2の限定grant付きHTTPから録音ページを1件ずつ取得し、GCSの固定snapshotをstream downloadして既存coreで逐次認識し、APIが採番したcandidateへPUTして確定する。外部AIへの送信ではないため`dispatch`は呼ばない。

## Service runner

起動はprivateな設定ファイルとcredentialファイルだけを引数で渡す。API URL、signed URL、endpoint、command、入力pathは設定できない。`environment`からprod=`https://niho.life`、stg=`https://app-stg.niho.life`を選び、API prefixは`/api/internal/docs-runner`に固定する。

```json
{
  "environment": "stg",
  "runnerId": "shared_mac_1",
  "sidecarPath": "/opt/niho-docs/bin/niho-speech",
  "workRoot": "/var/lib/niho-docs-runner/work",
  "languages": ["ja", "en"],
  "idlePollMs": 5000,
  "heartbeatMs": 30000,
  "maxIdlePollMs": 60000
}
```

設定ファイルとcredentialは専用ユーザー所有`0600`、各親directoryと`workRoot`は`0700`、symlinkなし、macOS ACL allow ACEなしにする。credentialはR2の公式`docs-runner-credential.mjs`が作る`{runnerId,secret}`のJSONをそのまま使い、設定のrunnerIdと照合する。secretを設定JSON、環境変数、launchd plist、引数へ複製しない。未知の設定keyは拒否する。`languages`は文字起こしする言語で、`ja`・`en`の重複のない1〜2件。`maxIdlePollMs`（空きのときのclaim間隔の上限）は60秒まで。APIは最終応答から3分届かないrunnerを「止まっている」として、預ける前の本人に知らせる。

```sh
node /fixed/release/apps/docs/remote-runner/cli.mjs \
  --config /private/config/runner.json \
  --credential /private/credentials/runner.json
```

起動時はmacOS標準`/usr/bin/lockf`のkernel advisory lockを専用holder processで保持して二重起動を防ぎ、保持中のlockを再検証した後だけ、このrunnerの`attempt-XXXXXX`を回収する。Linux上のCIは固定`/usr/bin/flock -n -F`で同じkernel lock契約を検査し、macOS製品実行の`lockf`は変えない。privateなlock fileはunlink競合を避けるため終了後も残す。mainの異常終了時はholderのpipe closeでkernel lockが解放され、holder死亡時はserviceのAbort signalとして扱う。壊れた・symlink・owner/mode不一致のlock pathは削除せず運用者確認を要求する。preflightはOS/arch、sidecar version、`languages`の各言語と話者分離modelの導入済み状態を検査するだけで、自動downloadしない。どれか一つでも欠ければ`preflight_failed`で起動しない（導入はrunbookの手順で運用者が行う）。

claim後は入力配列の順を維持し、一度に1 attemptだけ処理する。各input API応答のhash/bytes/generation/期限をclaimと照合し、GCS HTTPS署名URLだけをredirectなしで取得する。音声全体をmemoryへ集めず、private `0600` fileへstreamしながらbyte上限とSHA-256を検査する。API Authorizationとgrantはblob requestへ渡さない。candidate URLもGCSだけを許し、`content-type`、generation precondition、厳密なcontent-length range以外のheaderを拒否する。

再起動後のclaimは、期限が切れた同じrunnerの候補をサーバーで先に照合する。実objectがあれば入力取得・upload・新規実行を許さない`RECOVERY` grantで、outcome確認と同じ候補のsubmitだけを行う。既存grantを再発行して古いtokenを失効させる。稼働中のleaseと本人の保存・予算待機には介入しない。候補の予約だけが残って実objectを確認できない場合は結果不明で止め、別の文字起こしを自動で始めない。通常実行・回収とも外部AI送信の`dispatch`は呼ばない。

heartbeatはdownload・認識・PUT中も継続し、提出直前にloopを停止して最後のheartbeatを確定してから、独立したlease期限監視下で1回だけsubmitする。確定したsubmit receiptを遅れてきたheartbeat失敗で覆さない。認証失効、heartbeat拒否・応答不明、grant期限切れではAbortして提出しない。API request/responseは30秒、signed download/PUTは署名期限以内の固定上限で、header待ちとbody streamの両方をAbortする。candidate POST、PUT、submit、failの結果が不明な場合はservice全体を停止し、別candidateや別jobへ進まない。2xxでもJSON破損・契約不一致・上限超過ならmutating結果不明として停止する。PUTとsubmitは自動再送せず、APIの状態確認後に運用者が再開可否を決める。HTTP error bodyは診断へ出さずboundedに破棄する。ログは固定event/code、runnerId、attemptId、generation、phase、件数だけで、本文・音声・URL・grant・credential・response bodyを出さない。

claimの`IDLE`と`WAITING_CAPACITY`、および既知409 reasonの`attempt_held` / `vault_lease_held`はAbort可能なbackoffへ進む。`RESULT_UNKNOWN` / `FAILED` / `INPUT_CHANGED` / `INPUT_EXPIRED`はserverで既に終端化された通知として次のpollへ進む。それ以外の未知status・未知409 reason・不正responseは許容しない。

`SIGTERM`/`SIGINT`は現在のdownloadとsidecar process groupをAbortし、private stagingを削除してlockを解放してから終了する。強制`SIGKILL`や停電では次回起動時回収に委ねる。

claimの本文で、preflightを通った`languages`を毎回申告する（`{"languages":["ja","en"]}`）。APIはこれを`DocsRunner.speechLanguages`に記録し、このrunnerにはその言語の録音だけを割り当てる。読めない言語の録音は、読めるrunnerが別にいれば残し、どのrunnerも読めなければ`speech_language_unsupported`で失敗にする。受付（`POST /api/me/docs-runs`）も、どのrunnerも申告していない言語を断る。claim本文を受け付けない旧APIへ先にrunnerを上げると`claim`が400で止まるので、APIを先に配備する。

claimは受付時に固定した`language`と、0始まりで連続する各inputの`ordinal`を返す。runnerはordinal順をそのまま録音順として使い、欠番・重複・並び替えを拒否する。server指定languageがprivate設定の`languages`に無ければsidecar起動前に拒否し、別言語として推測・変換しない。

## ローカル文字起こし core

既にdownloadされた**ユーザー所有**の音声を処理するcoreも同じdirectoryに置く。録音ページ単位の逐次集約は`transcribeRecording`が担当し、HTTPとservice lifecycleは上のrunnerが担当する。

```js
import { preflightSpeech, transcribeAudio } from './engine.mjs';

const options = {
  sidecarPath: '/absolute/path/to/niho-speech',
  workRoot: '/absolute/private/runner-work', // 呼出元所有の0700ディレクトリ
  language: 'ja',
  signal: abortController.signal,
};
const readiness = await preflightSpeech(options);
const result = await transcribeAudio({ ...options, inputPath: '/absolute/private/audio' });
```

`preflightSpeech` は OS/arch、`version`、`probe --language` の型と値を検査し、話者分離モデルが `ready` であることも要求する。成功時は `{ platform:{os,arch,release}, engine:{name,sidecar,version}, language,locale,available,needsDownload }`。モデルは取得しない。どのサービス実行モードで起動されたかの証明にはならず、呼出元が実際の実行ユーザー・サービス状態とともにrunbookへ記録する。

`transcribeAudio` は `{ source:{sha256,bytes,format}, engine:{name:'SpeechAnalyzer',sidecar:'niho-speech',version}, durationSec,processingMs,segments:[{start,end,text,speaker?}],markdown }` を返す。SHA-256は実際にコピーして復号に渡したバイト列から計算する。`processingMs` は各 `done.durationMs` の合計で、音声の長さではない。区切りの時刻は元の音声の絶対秒。`speakerMode` が `none` なら `[hh:mm:ss] 本文`、それ以外なら `[hh:mm:ss] 話者1: 本文`（不明は `話者?:`）の段落にする。全区間で空白以外の本文が得られなかった場合は `silent_audio` で失敗する。


## 録音ページの集約とsnapshot照合

```js
import { transcribeRecording } from './recording.mjs';

const result = await transcribeRecording({
  ...options,
  audio: [
    { inputPath: '/absolute/private/first.m4a', snapshot: { sha256: '<64 lowercase hex>', bytes: 12345 } },
    { inputPath: '/absolute/private/second.m4a', snapshot: { sha256: '<64 lowercase hex>', bytes: 23456, durationSec: 120 } },
  ],
});
```

`audio` は録音ページの順序通りに渡す。ローカルのprivate絶対パスだけを受け付け、HTTP URLやfile URLは拒否する。R1 PR #18655 の `DocsRunFileRefSchema` は `{path, sha256, bytes}` で、R2 が固定 locator から取得したprivate音声の `sha256` と `bytes` をここへ渡す。`durationSec` は R1 snapshot にないため省略可能。既知durationの合計だけでも6時間を超える場合は開始前に拒否し、各ファイルの実convert durationを残り時間に対して検査する。後続ファイルの時刻には、前ファイルまでの**実duration**を加算する。申告durationと実durationの推定差だけを理由には拒否しない。

単体APIにも `transcribeAudio({ ...options, inputPath, expectedSource: snapshot })` を追加した。snapshotがある場合、隔離コピーの実byte数とSHA-256を `version` を含むsidecar起動前に照合し、不一致は `snapshot_mismatch`、不正なsnapshotは `snapshot_invalid`。集約APIは各ファイルにこの検査を必須で適用する。後続ファイルが途中で差し替わった場合も、そのファイルを認識する前に拒否する。`snapshot.mjs` の `validateAudioSnapshot` / `verifyAudioSnapshot` は同じ純粋な検証を公開する。

集約結果は `{ files:[{source,engine,durationSec,offsetSec,processingMs}], durationSec,processingMs,segments,markdown,candidate:{bytes,sha256} }`。`segments` は録音ページ全体の絶対時刻で、候補のbyte数/hashはUTF-8のMarkdownから計算する。返り値にローカルpathやURLは含めない。R1 の `prepareCandidate` は API 採番の候補と `text/markdown` の署名付き PUT を払い出し、`finalizeAttempt` が実bytes/hash/object generationを検証して原子的に確定する。coreが返すメモリ上の候補を、serviceがR2のgrant付きHTTPで提出する。

`RECORDING_LIMITS` は最大12ファイル・復号後合計6時間・候補本文8MiB・全体10万segment。`recordingLimits` でこれらを下げられる。既存 `limits` のduration/候補byte数/segment数を下げた場合も、その低い値を録音ページ全体に適用する。各ファイルcoreには集約の残りduration/segment予算を渡す。入力byte数などは各ファイルの上限。8MiBは文字数ではなくUTF-8 byte数で判定し、単体coreにも同じ上限を適用する。上限超過は `candidate_limit` / `output_limit`、ファイル数は `recording_file_limit`。失敗や取消で部分結果を返さず、完了済みファイルと失敗したファイルのattemptをすべて削除する。元入力は呼出元が保持する。

## 処理と上限

- 入力は通常ファイル・現ユーザー所有・他ユーザーから読めない権限（0600相当）で、macOS ACL に allow ACE が無いことも必須。共有 workRoot も allow ACE が無い専用0700ディレクトリを使う。新規 attempt は親から継承した ACL を除去してから使う。symlinkやFIFOは拒否する。元ファイルの削除・権限変更はしない。
- C1の1ファイル2GiB（2,147,483,648 byteを含む）、長さ6時間を上限とする。録音ページの合算は `transcribeRecording` が検査し、利用者間の受付枠や公平性はAPIのadmissionで扱う。downloadはstreamし、2GiB全体をメモリへ載せない。
- MIMEと拡張子に頼らずM4A / MP3 / WAV / AAC ADTS / AIFC / CAF / Ogg Vorbis・Opus / FLACを検査する。IFFは`FORM`/`AIFC`だけを`.aifc`として許可し、`FORM`/`AIFF`は拒否する。M4Aは `M4A ` brandと音声handlerだけを持つトラックが必要。MP4/MOVのbrand、動画handler、未知・曖昧・壊れたコンテナは復号前に拒否する。汎用MP4 brandの音声ファイルも安全側で拒否する。Oggのページ走査は入力byte上限で制限し、固定ページ数上限で6時間以内の有効な音声を拒否しない。
- AACはADTSの全フレームの同期・長さ・sample rate/channel設定を検査し、`.aac`へコピーする。FLACは必須STREAMINFO・metadataの境界・先頭音声フレームを検査して`.flac`にする。Oggは全ページのCRC・順序・継続packet・EOSと全logical streamのヘッダーを検査する。Vorbis/Opusだけを許可して`.ogg`にし、Theora・未知codec・未知の追加stream・壊れたページを拒否する。Opusのchannel mappingは既知のfamily 0/1を対象とする。codecヘッダーpacketは1MiBまで、logical streamは32本まで。これらはコンテナの事前検査で、圧縮音声フレーム自体の復号可否はsidecarでも検査する。
- `version → convert → diarize（speakerMode が none 以外のとき元 WAV 全体で一度）→ silence（900/60/60秒）→ 同じ speaker map で区切りごとに transcribe`。JSONは各コマンドの期待する型・範囲・個数を検査する。JSONLはUTF-8・改行終端が必要で、未知イベント、不正区間、範囲外の進捗、欠落/重複/不一致のdoneを拒否する。各区間のdone後にイベントが来ても失敗する。話者分離・map・protocol に失敗したら無ラベルへ戻さず attempt を失敗にする。
- `DEFAULT_LIMITS` は変更不可。`limits` オプションで上限を下げられる（空き容量の下限は上げる方向のみ）。出力全体16MiB、1行1MiB、候補本文8MiB、話者map16MiB、10万segment、1000区間、試行全体6時間。中間WAVは6時間分の16kHz mono PCM（691,200,044バイト）以下。
- コピー前に、入力コピー＋最長PCM＋話者map最大16MiB＋512MiBの空き容量を確保できるか検査する。試行中は100msごとと各段階で総一時ファイルサイズ・ファイル権限・512MiBの残容量を検査し、超過したら停止する。これはファイルシステムのhard quotaではなく、監視間隔と終了猶予中の増加分は生じうる。専用volumeのquota/予約は配備時の責務。

## 一時データと停止

`workRoot` の直下にランダムな0700のattemptフォルダを作り、入力のコピーは0600で作る。ファイル名はバイト検査で確定した形式から `input.m4a` 等を選び、AVFoundationにも正しい形式を渡す。sidecarは専用Node子プロセスでumask 0077を設定してから起動するので、sidecarの変換途中のファイルも初めから非公開になる。親プロセスのumaskは変更しない。完了、失敗、中断、timeoutのいずれでも、このattemptだけを削除してから返す。

シェルは使わない。sidecarを絶対パスで指定し、子環境は固定PATH / locale、モデル読取に必要なHOME、attempt内TMPDIRだけを渡す。標準エラーは保存せず排出する。本文・URL・引数・パス・環境変数をログ出力する処理はない。

中断・timeoutでは専用プロセスグループへSIGTERMを送り、既定1秒後にSIGKILLする。通常終了時にも同グループの残存子孫を停止する。終了・stdout排出を待つ間にtimeoutや取消が発生しても、先に確定したsidecarエラーの固定コードを保持する。呼出元プロセス自体がSIGKILL・停電で終了した場合の回収はこの関数のfinallyでは保証できず、次の明示的な起動時清掃で回収する。

失敗は本文やOSのエラー原文を含まない `TranscriptionError` の固定 `code` / `message`。代表例は `input_format` / `input_not_private` / `input_invalid` / `input_limit` / `duration_limit` / `silent_audio` / `sidecar_protocol` / `model_missing` / `engine_unavailable` / `language_unsupported` / `resource_unavailable` / `disk_limit` / `workspace_limit` / `output_limit` / `cancelled` / `timeout`。未知のsidecarエラーは `sidecar_failed` にする。ログに出せるのはこの固定コードと、呼出元が管理する不透明な試行IDだけ。

`cleanupStaleAttempts({workRoot,singleInstanceConfirmed:true})`（`cleanup.mjs`）は、呼出元がOS側で単一instanceを保証した**起動時だけ**呼ぶ。flag自体は排他ロックではない。現ユーザー所有・0700・ACL allow ACEなし・非symlinkのrootを検査し、直下の `attempt-` と英数字6桁の専用フォルダだけを対象にする。内部も所有者・0700ディレクトリ/0600通常ファイルを確認し、symlink・不正な権限・対象外の名前は保存する。認識のsupervisorは子を起動する前に空の `.active-child-<PID>` を置く。親とのpipeが閉じた場合は自身のprocess groupをTERM→KILLし、生存中のPID markerがあるattemptは清掃しない。返り値は `{removedAttempts,skippedEntries,activeAttempts?}` の件数だけ。serviceはactive attemptがあれば起動を止める。処理中の定期清掃には使わない。

形式の構造は [Ogg framing](https://xiph.org/ogg/doc/framing.html)、[Vorbis仕様](https://xiph.org/vorbis/doc/Vorbis_I_spec.html)、[Ogg Opus RFC 7845](https://www.rfc-editor.org/rfc/rfc7845.html)、[FLAC RFC 9639](https://www.rfc-editor.org/rfc/rfc9639.html) に従う。

## 対象限定テスト

```sh
npm -C apps/docs/remote-runner test
```

実sidecarと導入済み日本語モデルがあるMacでは、次で固定音声の変換・認識も検証する。モデルの取得は行わない。`NIHO_SPEECH_TEST_BINARY` は絶対パスで指定し、省略時は同worktreeのreleaseビルドを使う。

```sh
NIHO_SPEECH_E2E=1 NIHO_SPEECH_TEST_BINARY=/absolute/path/to/niho-speech node --test --test-name-pattern='real sidecar' apps/docs/remote-runner/test/engine.test.mjs
```

テスト専用sidecarでlimits・private権限・JSONL異常・空音声・cancel/timeout・停止を無視する子孫プロセス・後始末・入力hash/時刻/版・preflight・入力コンテナを確認する。HTTP/serviceテストは注入fetchと短いprivate fixtureを使い、2音声の順序、PUT/submit、heartbeat、hash/bytes/generation、redirect、header allowlist、401/403、不明結果、停止、lock/cleanup、ログ秘匿を検査する。AAC/FLAC/Oggの構造fixtureはNodeのBufferだけで合成し、通常テストにffmpegは不要。実音声の認識品質やサービス配備の受入とは別の検証。
