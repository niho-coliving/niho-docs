# desktop-account（NIHO アカウントでログイン）

NIHO camera（`apps/camera`）と NIHO docs（`apps/docs`）が**同じコードで**使う、NIHO アカウントでログインする土台。
Rust crate `niho_desktop_account`（package 名 `niho-desktop-account`）と、同じディレクトリの `ts/`（npm `niho-desktop-account`）。
spec: [`specs/initiatives/niho-account-desktop-login.md`](../../specs/initiatives/niho-account-desktop-login.md)「共通モジュール」、Epic #18551 の L3 #18555。

- アプリにログイン画面は無い。「NIHO でログイン」で既定のブラウザに `https://niho.life/connect/<clientId>?v=1&challenge=…&state=…` を開き、
  戻りの deep link `niho-<app>://auth?code=…&state=…` の一度きりのコードを PKCE（S256）の verifier と一緒に `POST /api/auth/app-connect/exchange` へ渡す。
- 返りの custom token は Identity Toolkit の REST（`signInWithCustomToken`）で ID token にする（Firebase SDK は同梱しない）。
  ID token は**メモリだけ**。Firebase の refresh token は捨てる。更新は NIHO の**接続 refresh token**（この Mac の app data のファイル）で
  `POST /api/auth/app-connect/refresh` → `signInWithCustomToken`（期限の 5 分前から・single-flight・一時的な失敗は 1→2→4→… 最大 5 分のバックオフ）。
- コード・verifier・custom token・接続 refresh token・ID token は、ログにも、エラーの文にも、画面にも出さない（テストが守る）。
- 接続 refresh token は `refresh` のたびに取り替わる（返りの `refreshToken`。1 つ前の token は 10 分だけ再送を受ける）。新しい token は
  `signInWithCustomToken` より**前に**保存する。保存できなかったときはメモリに持って続け、ログに `account.refresh.token_save_failed` を残す。
- **Tauri に依存しないコア**（feature 無し）と、**Tauri の層**（feature `tauri`）。コアは偽の HTTP とメモリの保存先（`MemorySecretStore`）でテストする。

## 公開 API（Rust）

| モジュール | 役割 | 主な入口 |
|---|---|---|
| `client` | client の登録表（`contracts/src/app-connect-contract.ts` と同じ値。`client_tests.rs` が照合）と環境 | `ClientId`（`Camera` / `Docs`）・`Environment::new(client, EnvKind, firebase_api_key)`・`EnvKind::from_build_env` |
| `service` | アカウントの状態と流れ | `AccountService::new(ServiceConfig)`・`begin_login`・`cancel_login`・`handle_callback`・`state`・`id_token`・`refresh_profile`・`logout`・`logout_everywhere`・`restore` / `start`・`maintain`・`subscribe` |
| `secret` | 秘密の値と保存先 | `Secret`・`SecretKind`（`RefreshToken` / `Pending`）・`AccountSecretStore`・`FileSecretStore::in_data_dir`（Tauri の層が使う）・`KeychainStore::for_client` と `keychain::{read, write, delete}`（generic password の共通 adapter。Developer ID 署名の後に戻すために残す。いまは使わない） |
| `http` | HTTP の口 | `HttpClient`・`HttpRequest`・`HttpResponse`・`ReqwestClient`（feature `reqwest`。rustls〔ring〕＋ OS の信頼する CA） |
| `pkce` | verifier / challenge / state・接続 URL・戻りの URL | `random_base64url_32`・`code_challenge`・`connect_url`・`parse_callback` |
| `api` | API の request の形と返りの読み取り・失敗の分類 | `exchange_request`・`refresh_request`・`sign_in_request`・`me_request`・`delete_connection_request`・`ApiFailure`・`CallFailure` |
| `store` | この Mac のプロフィール（`account.json`）と顔写真（`account-avatar.<ext>`。512 KB まで） | `AccountStore` |
| `error` | `AccountError { code, message }`（文は利用者向けの日本語） | `error::code::*` |
| `tauri` | Tauri の層 | `deep_link()`・`init(env)` / `init_with(env, Options)`・`AccountHandle`・`CHANGED_EVENT`・`LOGIN_FAILED_EVENT` |

### 状態（`AccountState`。JSON は `{ "kind": … }`）

| kind | 意味 | popover |
|---|---|---|
| `signedOut` | 未ログイン | 「NIHO アカウント」「NIHO でログイン」 |
| `signingIn` | pending あり（ブラウザで続行中。10 分で捨てる） | 「ブラウザで続けています…」「やめる」 |
| `signedIn` | 接続 refresh token があり、更新できている | 顔写真・名前・@handle・「マイページを開く ↗」（`onOpenMyPage` を渡したときだけ。NIHO docs は渡さない）「ログアウト」 |
| `offline` | 接続 refresh token はあるが更新できていない（ネットワーク・5xx） | 同上＋「オフライン」 |
| `expired` | 接続の失効（ほかの端末からの「ほかの端末でもログアウトする」・再利用の検知を含む）・期限（最後に使ってから 180 日）・ユーザー全体の失効。もう一度ログインが要る（プロフィールは残す） | 名前「もう一度ログイン」「ログアウト」 |

失敗の分岐は spec「失敗の分岐」「更新の失敗時」の表のとおり（401 `app_connection_revoked` / `session_revoked` → `expired`、403 `ACCOUNT_DELETED` /
`firebase_user_disabled` → 全部消して `signedOut`、404 `app_connect_disabled` と、API の認証の停止スイッチ（#18892）の 401 `app_connect_disabled` → 状態は変えない、ネットワーク・5xx・503・429 → `offline`）。

### 保存先

| 何 | どこ |
|---|---|
| 接続 refresh token | `data_dir/account-secrets/refresh-token`（`FileSecretStore`。ディレクトリ 0700・ファイル 0600・一時ファイル→fsync→rename の原子的な書き換え）。`refresh` のたびに書き換わる |
| pending（`{ verifier, state, client, startedAtMs }`） | `data_dir/account-secrets/pending`。成功・「やめる」・10 分・ログアウトで消す |
| プロフィール（userId・名前・handle・connectionId・顔写真のファイル名・期限切れの理由） | `data_dir/account.json`（Tauri の層では app data dir の `account/`） |
| 顔写真 | `data_dir/account-avatar.{jpg,png,webp,gif}` |
| ID token・custom token | メモリだけ（保存しない） |
| ログ | Tauri の層の既定は app log dir の `niho-account.log`（1 行 1 JSON。秘密は入らない）。`Options.log` でアプリのログへ |

保存先は spec D-16 改（2026-10-17）で、Developer ID 署名が入るまで（2027 年の予定）**Keychain ではなく app data のファイル**。ad-hoc 署名では
ビルドごとに designated requirement（`cdhash`）が変わり、Keychain の項目が版の更新ごとに確認（ログインのパスワード）を求めるため。
旧版が Keychain（service `life.niho.<app>.account`）に置いた項目は**読まない**（確認を出さない）ので、旧版でログインしていた人は 1 回ログインし直す。
同じユーザーで動く別のプログラムからは読める（NIHO Desktop の WebView に残る niho.life のログインと同じ守りの強さ。spec T-6）。
`AccountError` の code `keychain_*` は名前だけ Keychain の時代のまま（TS と同じ値を保つ）で、文言は保存先に依らない。

## アプリからの使い方（L4 camera・L5 docs）

1. `Cargo.toml`: `niho_desktop_account = { package = "niho-desktop-account", path = "../../../packages/desktop-account", features = ["tauri"] }`
2. `lib.rs`:
   ```rust
   let env = niho_desktop_account::Environment::new(
     niho_desktop_account::ClientId::Camera,
     niho_desktop_account::EnvKind::from_build_env(option_env!("NIHO_ACCOUNT_ENV")),
     env!("NIHO_FIREBASE_API_KEY"), // env ごとの Web API key（公開値）。ビルドで埋める
   );
   tauri::Builder::default()
     .plugin(niho_desktop_account::tauri::deep_link())   // tauri-plugin-deep-link（この crate が版を持つ）
     .plugin(niho_desktop_account::tauri::init(env))
   ```
   deep link の plugin は `init` より**前**に登録する（無ければ `init` が起動時に失敗して理由を出す）。
3. `tauri.conf.json`: `plugins.deep-link.desktop.schemes: ["niho-camera"]`（docs は `niho-docs`）。顔写真を出すので CSP の `img-src` に
   `asset: http://asset.localhost` を足す（外部 URL は足さない）。`bundle.macOS` の `CFBundleURLTypes` は plugin が書く。
4. `capabilities/default.json` の `permissions` に `"niho-desktop-account:default"` と、event 用の `core:event:allow-listen` / `core:event:allow-unlisten`。
5. 画面: `npm i file:../../packages/desktop-account/ts` → `useNihoAccount()`（`niho-desktop-account/use-niho-account`）を `niho-ui/components/account-popover` の
   `AccountPopover` に繋ぐ:
   ```tsx
   const account = useNihoAccount({ lang: "ja" });
   <AccountPopover state={account.state} avatarSrc={account.avatarSrc} busy={account.busy}
     onBeginLogin={account.beginLogin} onCancelLogin={account.cancelLogin} onLogout={account.logout} onOpenMyPage={account.openMyPage} />
   ```
   トーストは `account.notice`（`signedIn` / `signedOut` / `error`）で出し、`dismissNotice()` で消す。
   「ログアウト」は `niho-ui/account-logout-confirm` の `confirmAccountLogout({ allowEverywhere: state.kind === "signedIn" })` で共通の確認
   （「ほかの端末でもログアウトする」の欄つき。`appDialog` なので `AppDialogHost` を描いておく）を出し、`account.logout({ everywhere })` を呼ぶ。
   `everywhere: true` は Tauri command `account_logout` の引数 `everywhere` で Rust の `logout_everywhere()`（`POST /api/auth/sign-out-everywhere`
   が 204 か 401 `app_connection_revoked` のときだけ手元を消す。失敗は `sign_out_everywhere_failed` で、この Mac はログイン済みのまま）。
6. 自分で API を呼ぶとき（将来のクラウド保存など）は Rust 側で `tauri::State<AccountHandle>` の `service().id_token().await`（ID token は画面へ渡さない）。

macOS の deep link は**バンドルした `.app`** でしか OS に登録されない（`tauri dev` では届かない）。開発は `tauri build --debug` の `.app` を一度起動して登録する。

## 環境

`Environment::new(client, EnvKind::Prod | Stg, firebase_api_key)`。prod は `https://niho.life`、stg は `https://app-stg.niho.life`（`/api` もその下）。
`EnvKind::from_build_env(option_env!("NIHO_ACCOUNT_ENV"))` で `stg` のときだけ stg、ほかは prod。Firebase の Web API key は env ごとの値をアプリのビルドで埋める。

## テスト

```bash
cargo test                       # コア（Tauri 無し）。偽の HTTP とメモリの保存先
cargo test --all-features        # Tauri の層も compile
cargo clippy --all-features --all-targets -- -D warnings
cargo test keychain_round_trip -- --ignored   # 本物の Keychain（テスト用の service 名 life.niho.camera.account.test）
npm -C ts ci && npm -C ts run typecheck && npm -C ts run lint && npm -C ts test
```

テストが確かめること（spec「テスト」）: RFC 7636 付録 B のベクタ、`state` の不一致、同じ `state` の 2 回目、pending の期限（10 分）、再起動後の pending の継続、
`exchange` の各エラー、保存先への書込失敗時のロールバック（接続の `DELETE`）、更新の各失敗（期限切れ・全部消す・一時的＋バックオフ）、取り替えた
接続 refresh token の保存の順序（`signInWithCustomToken` より前）と保存失敗時の続行、`FileSecretStore` の権限（0700 / 0600）・原子的な書き換え・
無いとき・冪等な削除、ログアウト、`logout_everywhere` の成功／401／失敗／オフライン、起動時の復元、ログ・エラー・状態の JSON に秘密が出ないこと。
CI は `.github/workflows/desktop-account-ci.yml`。

## spec との差分（実装で決めたこと）

- `state()` は同期（`async` にする理由が無い）。`id_token()` は `Secret` を返す。
- deep link の plugin はアプリが `tauri::deep_link()` で登録する（別の plugin の setup の中から plugin を足せないため。アプリ側は 2 行）。
- 利用者に見せる deep link の失敗（コードの期限切れなど）は event `niho-account://login-failed`（`AccountError`）で画面へ。`state` 不一致・2 回目はログだけ。
- 一時的な失敗で更新できないときも、期限内の ID token があればそれを返す（API は呼べる。状態は `offline`）。
- `exchange` のあと `signInWithCustomToken` に失敗したときは、手元に何も残さず始めからやり直してもらう。API 側の接続は（ID token が無いので `DELETE` できず）
  サーバーに残る。使われないので最後に使ってから 180 日で切れる（「ほかの端末でもログアウトする」でも消える）。
- 有効な pending がある間の `begin_login` は `busy`（先に開いたブラウザの戻りを無効にしない。やり直しは「やめる」から）。
- 交換の途中で「やめる」・ログアウトが入ったら、その結果は捨てて作った接続を解除する（`callback_cancelled`。画面には出さない）。交換を始めた印
  （`consumed`）は保存先の pending に残し、途中でアプリが終わっても次の起動で同じコードを API に再提示しない（再利用と見なされて失効するため）。
- プロフィール・顔写真の書き込みとログアウトの wipe は直列化し、書く前にまだ同じ接続でログイン済みかを確かめる（ログアウト中の取り直しで復活しない）。
- `Pending`・`Callback`・`HttpRequest`・`HttpResponse` の `Debug` は秘密（verifier・code・header の値・本文）を出さない。
- `refresh` の返りに `refreshToken` が無いとき（取り替えない旧サーバー）は、今の token を使い続ける（L6 の API の配備前後の版のずれ）。
- 取り替えた token の保存の前に、更新を始めたときの接続のまま（ログアウト・期限切れ・別のログインになっていない）かを確かめ、変わっていたら
  書かずに結果を捨てる（`account.refresh.rotated_token_dropped`）。
- `logout_everywhere()` はオフライン（`offline`）では通信せずに `sign_out_everywhere_failed`、期限切れ・未ログインでは `expired` / `signed_out`。
  ID token の更新で期限切れ・退会がわかったときはその失敗を返す。403 `ACCOUNT_DELETED` / `firebase_user_disabled` は全部消して `account_unavailable`。
- 保存先は spec D-16 改のとおり app data のファイル。Keychain の adapter（`KeychainStore`）は public のまま残す。
