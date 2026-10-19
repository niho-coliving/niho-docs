# desktop-vault

NIHO docs の案件フォルダをローカルの写しとして保ったまま、`/api/me/docs-vault` と同期する Tauri 非依存の Rust crate です。ローカル保存の境界（journal）、本人ごとの state と永続 outbox、三方向併合と競合の保護、文書と音声の転送、同期の予約、lease を持ちます。画面とアプリへの組み込みは C3 で行います。

## C3 から使う API

- 保存先 root と本人: `root_binding(app_data, root)` で rootId を得て、ログインした本人へ `bind_root(app_data, root_id, Some(&account_key(env, user_id)))` で結び付けます。`RootBinding::namespace()` が `Namespace::Account`（未ログインは `Namespace::Local`）を返します。別の本人へ結び付け直す前に `namespace_has_pending(app_data, &namespace, root_id)` で未同期が無いことを確かめてください。root が別の本人に結び付いている engine は通信しません（`NamespaceMismatch`）。
- engine: 本人ごとに `SyncEngine::new(provider, app_data, namespace, root_id, device, protection) -> Arc<SyncEngine>` を tokio runtime の中で作ります。`protection: Arc<EditProtection>` はアプリが持ち、engine を作り直しても残します。ログアウト・切替では `shutdown()` を呼びます（以後この engine は通信しません。outbox は残ります）。
- ローカル保存: 本文・版・履歴の書込みはすべて `engine.saver()`（`LocalSaver`）の `save(&target, SaveGroup { writes, kind })` を通します。戻れば「このMacに保存済み」です。通信しないので、UI のスレッドでなく blocking の文脈で呼んでください。保存 API を通らない変更（音声の写し・画像・削除）は `note_changed(&target, &paths)`、起動直後・通信より前に `recover(&target)` を呼びます。
- 対象: `ProjectTarget::new(project_id, working_copy)`。保存先ルートの `about.json` と `execution.json` は `ProjectTarget::profile(docs_root)` の限定 scope で、フォルダを歩きません。
- 同期の予約: 保存の後に `engine.schedule(target, SyncReason::LocalSave)`（最後の保存から 1.5 秒・最初の未送信の保存から最大 5 秒）。開く・前面・再接続・工程の終了・保護の解除・今すぐ同期は `SyncReason::Now`（backoff も越える）、開いている案件の 5 分ごとの確認は `SyncReason::Periodic`。予約の flight は直前に `set_flight_options(Arc<dyn FlightOptions>)` から案件名・lease・実行中を受け取ります。移行や「クラウドから開く」は `sync(&target, options)` / `sync_now(&target, options)` を直接呼べます。起動時は `projects_with_pending()` の案件を予約します。
- 編集保護: 文書を開いて編集を始めたら `protection.protect(project_id, paths)`、閉じたら `release(id)` の後に `schedule(target, SyncReason::Now)`。保護中の path の remote 更新は `staging/` に取り置き（`Deferred`）、解除後に適用します（`Applied`）。
- 状態と event: `subscribe()` で `SyncEvent`（`syncing` / `localSaved` / `committed` / `conflict` / `deferred` / `applied` / `audio` / `quota` / `offline` / `expired` / `tombstone` / `done`）を受け、画面は `project_snapshot(&target)`（通信しない）で描きます。
- 競合: `list_conflicts(&target)` と `read_conflict_copy(&target, conflict_id, ConflictSide::Local | Remote)` で双方を見せ、解決は `save` に `SaveKind::Resolution { conflict_id, remote_sha256 }` を付けて、通常 path・新しい版（`new_version_id()` と `version_path_for(path, version_id)`）・runs の行を 1 つの group で書きます。確認中に remote が変わっていれば `ConflictChanged` になるので、一覧を読み直してください。
- lease: `.run.lock` を取る前に `engine.acquire_lease(project_id, None)`（または `LeaseSession::acquire(...).with_events(engine.event_sender())`）。30 秒の心拍が 2 回続けて失敗すると `commit_lease_id()` が `None` になり、engine の channel にも `offline` が流れます。CLI は止めず、終了時は `finish()`。
- provider: `NihoProvider::new(api_base, id_token_provider)`。`api_base` は `Environment.api_base`（`https://niho.life/api`）でも origin（`https://niho.life`）でも構いません。`IdTokenProvider::id_token()` は API リクエストの直前に毎回呼ばれ、token を crate に保存しません。署名切れ・ログアウトは `VaultError::AuthRequired`、通信断は `VaultError::Offline` を返してください。`LocalProvider` は何もしない provider です。
- `load_or_create_device(app_data, name)` は `device.json` を初回だけ作ります。TypeScript の同じ境界は `ts/index.ts`（`VaultSyncEvent`・`ProjectSyncSnapshot`・`ConflictEntry` と待ち時間の定数）です。

## 契約

- Rust の JSON はすべて camelCase です。API の route・request・response は `apps/api/src/routes/me-docs-vault.ts` と一致します（commit は `mutationId` 必須、設定は deviceId ごと、一覧の `reserved` / `deleted` は `1` のときだけ付けます）。
- state・journal・snapshot・outbox・staging は案件フォルダでなく app data の `vault/<accountKey>/<projectId>/`（未ログインは `vault/local/<rootId>/<projectId>/`）に置き、`accountKey = SHA-256(environment + "\n" + userId)` で本人と環境を分けます。書込みは一時ファイル → fsync → rename → 親 directory の fsync です。旧形式の `vault/<projectId>.json` は所有者が分からないため同期に使わず、消しもしません（C3 の初回移行で扱います）。
- ローカル保存は snapshot → journal（prepared）→ 写し → state → journal（localCommitted）→ journal の削除の順です。`recover` は prepared を snapshot から roll forward し、previous／next のどちらとも違う path は上書きせず両方を保護して競合（origin `recovery`）にします。
- commit は送る前に `mutationId` と payload を outbox に固定し、結果が分からない（通信断・5xx・429）ときは同じものを再送します。明確な 409 revision・lease・400 は破棄して新しい mutation で再計画し、`DOCS_VAULT_MUTATION_MISMATCH` は残して止めます。ack では送った世代と同じ dirty だけを消すので、送信中の保存は未同期のまま残ります。依存 group（同じ保存で書いた本文・版・runs）は 2,000 件・1 MiB の batch の途中で切りません。
- 併合は sha256 だけで比べ、時刻や端末で勝者を決めません。両方で変えた・削除と変更・同名新規は競合として、双方を `.conflicts/<SHA-256(path)>/<versionId>.<拡張子>` と `.conflicts/index.json` に残し、版を immutable な `versions/` path（`<録音prefix>versions/<stepId>/…`・`versions/source/…`・`versions/files/<SHA-256(path)>/…`）に書いてクラウドにも上げます。通常 path は手元の内容のまま、解決まで上げ下げしません。`profile` は版のファイルを書かず写しだけです。音声と 8 MiB を超えるファイルは写しを作らず、remote の版を blob の参照で残します。
- `versions/**` と `recordings/<id>/versions/**` は削除も別の内容への上書きもしません。`runs/**`・`conversations/**` は削除を伝えません。どの階層の `runs.jsonl` も行の和集合です（競合にしません）。
- 編集保護・未同期・結果不明・未解決競合の path には remote を適用しません。`.run.lock` がある間は押すだけで、適用しなかった path の base は進めません。base は実際に適用／確定した path だけが進みます。
- 文書は flight の中で上げ、音声は背景の queue（engine ごとに 1 本、5 秒・30 秒・2 分の再試行）で上げ下げします。complete が済んだ音声だけを commit に入れ、文書の commit は音声を待ちません。容量で止まった音声は次の保存か「今すぐ同期」まで上げ直しません。
- 同期しない path: どの階層でも `.run.lock`・`.DS_Store`・`.conflicts`・`*.tmp`・アプリの一時ファイル（`.` で始まり `.tmp` を含む名前）。`settings.json`・`device.json`・`vault`・`codex-home` は送らず blocked（`privatePath`）にします。上限（text・json は 8 MiB、音声は 2 GiB（含む）、それ以外は 1 GiB（含む））を超えるファイルは `tooLarge`、空の音声は `emptyAudio` として blocked にし、他のファイルの同期は続けます。0 byte の文書は inline の空文字列で上げます。
- `.aifc` は `audio/aifc` として扱います。8 MiB を超える blob（2 GiB の音声を含む）の upload・download はファイル全体をメモリへ載せません。resumable upload は最大 8 MiB の chunk と `u64` offset で送り、失敗時はサーバーの `Range` から再開します。download は generation 付き signed URL をそのまま使い、対象と同じ directory の一時ファイルへ逐次書きながら byte 数と SHA-256 を照合し、gate の中で再確認してから rename します。失敗時は一時ファイルを消します（#18653）。
- revision の 409 は 3 回まで再計画し、その後 1、2、4 分の retry 時刻を state に記録します。`available: false` の音声は失敗にせず下ろしません。手元に同じ内容があれば上げ直します。
- tombstone は自動で上げ下げしません。未同期があれば restore／手元退避の選択を求め、clean なら写しを `.conflicts/deleted-projects/<projectId>/`、state と outbox を `vault/<accountKey>/.deleted/<projectId>-<ms>/` へ移します。回収済み（410）は `purged` です。

## 検証

```sh
cargo fmt --manifest-path packages/desktop-vault/Cargo.toml --check
CARGO_BUILD_JOBS=2 cargo check --manifest-path packages/desktop-vault/Cargo.toml --offline --locked --all-targets
CARGO_BUILD_JOBS=2 cargo test --manifest-path packages/desktop-vault/Cargo.toml --offline --locked
packages/docs-core/node_modules/.bin/tsc -p packages/desktop-vault/tsconfig.json
```

HTTP 結合テスト `--test provider_http` は `127.0.0.1:0` の独立した偽サーバーを使い、bind 失敗を自動 skip しません。loopback bind を許可した実行環境で走らせてください。
