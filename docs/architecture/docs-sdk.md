# NIHO docs 公開 SDK 境界

公開 SDK は `@niho/docs-core`、`niho-docs-ui`、`niho-docs-sdk-ui` の同一版 release set です。`DocsApp` と既存の `DocsHost` / `DocsWorkspaceHost` port、純粋な docs-core、画面に必要な CSS と共通 UI だけを配布します。認証判断、token、DB/API adapter、実データ、production 設定、署名は private NIHO host が所有します。SDK は Next.js、Tauri、Firebase、desktop account client を import しません。Mac client はこの repository に残り、browser SDK には含めません。

workspace の `niho-ui` は private 側の正本です。公開用 pack の一時領域だけで package 名と import を `niho-docs-sdk-ui` に変更し、逆同期はしません。`DocsApp` は内部で同じ dialog host を描画するため、`DocsApp` consumer が別の `DocsSdkDialogHost` を追加してはいけません。`appDialog` を使う単独 SDK component / flow を `DocsApp` 外で組み立てる場合だけ、dialog store の instance を揃えるため `niho-docs-ui/sdk-dialog-host` の `DocsSdkDialogHost` を1つ描画します。host 側の `niho-ui` dialog host で代用しません。React と ReactDOM は peer dependency のままです。

生成と検査は Node 24 で行います。

```sh
node scripts/sdk/pack-release-set.mjs --source-sha <40桁SHA> --output <空の出力先>
node scripts/sdk/verify-release-set.mjs --manifest <manifest.json>
node scripts/sdk/smoke-consumer.mjs --manifest <manifest.json>
```

pack は指定 commit の Git object だけから allowlist 済み source を読み、core の `./server` を JavaScript と `.d.ts` に compile します。release pack は、実行中の生成・検証スクリプトと選択 commit が一致し、`apps/docs/package.json` と `package-lock.json` も手元の build tooling と一致する場合だけ実行でき、manifest に両者の SHA-256 と実際の TypeScript compiler version を記録します。未 commit の新しい tooling をローカル確認するときだけ `--tooling-worktree` を付けられます。この preview manifest は release verifier が拒否するため公開には使えません。tarball の install script は持たず、consumer smoke も `--ignore-scripts --offline` で実行します。

配布用の verifier には `--expected-source <40桁SHA> --expected-version <版> --source-repository <Gitリポジトリの絶対パス>` も渡します。manifest の自己申告だけでなく、選択した Git object の tree・ソース一覧・build lock と照合します。これだけでは配布コードとsourceの一致までは証明できないため、release workflowは独立したread-onlyの `verify-source` jobも必須にしています。workflow起動時の信頼済みmain SHAをcheckoutし、同じ選択Git sourceから再生成したmanifestを `--reproduced-manifest <再生成manifest>` に渡し、変換後のpackage.json・README・JS・宣言・CSS等を含む全package entryの集合とbytesを比較します。受領artifactのコードは実行しません。生成器またはbuild lockが現在の信頼済みtoolingと異なる過去commitは公開せず、現行mainで新しい版を作ります。

write権限を持つpublish jobは再生成jobが確認したmanifest SHA-256を `--expected-manifest-sha256` で固定し、全tarballのhashとGit provenanceを再検証します。publish jobではnpm installや配布コードの実行を行いません。3 jobの信頼済みcheckoutは同じworkflow起動SHAに固定し、build jobの自己申告hashだけを公開根拠にしません。同梱READMEのpackage名もstaging時に `niho-docs-sdk-ui` へ置換します。

UI の組み込みでは `niho-docs-sdk-ui/styles/tokens.css` と `niho-docs-ui/styles/{tokens,app,sharing,editor,account}.css` を読み込みます。アカウント・共通ダイアログの Tailwind utilities は接続側で生成し、`node_modules/niho-docs-sdk-ui/src/**/*.tsx` と `node_modules/niho-docs-ui/src/**/*.tsx` を走査対象にします。従来の `packages/ui` へのパスを SDK の設定へ持ち込まないでください。画面 root の寸法、Tailwind の scope、実ブラウザでの受入はホストの責務です。consumer smoke は型・bundle・Node 実行の検査であり、視覚的な受入を代替しません。

「次の工程」は `niho-docs-ui/next-steps` から利用できます。ホストは `DocsNextStepsView` として工程の行・残り・実行中／確認中・理由・エラー・場所・帯などの表示状態を渡し、`start`・`stop`・`closeBand`・`open` と設定画面を開く callback を実装します。Mac アプリ案内が必要な場合は `DocsNextStepsSection` / `DocsNextStepsEnd` の `macAppHref` を渡します。受付判定、実行 lifecycle、停止確認、routing はホストの責務です。

保存先モード画面は `niho-docs-ui/storage-mode` から利用できます。ホストは `mode`・選択中／エラー状態とクラウド選択・再読込 callback を渡し、アカウント領域を `accountContent`、端末録音の救出領域を `recordingRescue` slot に渡します。`UNSET` のときは `onSelectCloud` が必須で、JavaScriptから欠落した場合も主ボタンを無効にします。認証・保存先判定・storage／permission・録音アクセスはホストの責務で、SDKはmount時に選択処理を開始しません。

private repository との統合単位は release manifest と SHA-256/SRI で固定された versioned tarball です。private 側から未レビューの public branch や可変な `main` を直接 import しません。desktop 署名で native source snapshot が必要な場合も一時入力に限定し、認証・production secret・署名処理を SDK に移しません。

現在の private `file:` 依存と native source snapshot は、初回 SDK 発行と固定版の統合受入まで維持します。この PR だけで本番の依存・配布承認は変更しません。オーナーが公開 PR をマージした後、信頼された main から手動発行し、版・公開 SHA・manifest hash と各 tarball の SRI を統合 PR に記録します。tag を確保した後に発行が失敗した場合も、その版を再利用せず新しい版を発行します。

`Docs SDK CI` の `docs-sdk` check は全PRで発行します。初回の公開PRをmainへ取り込んだ後、既存のrequired CIを維持したまま `docs-sdk` もrequired status checkへ追加してください。親PR #24にこのcheckは存在しないため、そのマージを待たずに設定して親を停止させないようにします。
