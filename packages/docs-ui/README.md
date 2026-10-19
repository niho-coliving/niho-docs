# niho-docs-ui

NIHO docs の Mac・Web/PWA 共通画面（Epic #18873、U1 #18876・U2 #18877）。Mac の実画面はこの package の `DocsApp` を描く。フォルダ直下に背景情報（音声を含む）、録音から作った工程ごとのページ、自分で追加したページを並べる現行構造（#18914・#18915）を保つ。

## 責任と公開口

| 公開口 | 内容 |
| --- | --- |
| `niho-docs-ui/screens/DocsApp` | 起動、レール、ホーム、背景情報、文書、録音、工程のページ、会話、設定を組み合わせる共通画面 |
| `niho-docs-ui/components/*` | 個別の画面部品・エディタ。工程設計も共通部品で、Web から使える |
| `niho-docs-ui/host/DocsHost` | 保存・実行・会話・書き出しなどの I/O 型と capability。初回は Mac の既存 Bridge の引数・結果を維持 |
| `niho-docs-ui/host/DocsAccount` | アカウントの表示状態と操作。token・OAuth・transport は受け取らない |
| `niho-docs-ui/testing/FakeHost` | 通信も OS 操作も行わないテスト用 host。未定義の操作は拒否する |
| `niho-docs-ui/lib/*` | React controller と、画面用の純粋な補助処理。保存や実行は注入した host を呼ぶ |
| `niho-docs-ui/editor/*` | Markdown の往復、検索、画像参照、文字起こしの時刻など、U1 からのエディタ基盤 |
| `niho-docs-ui/styles/*` | 画面の規則と token の別名。すべて `[data-docs-app-root]` 内だけに適用 |

package は `apps/docs`、`apps/web`、Tauri、HTTP transport を import しない。音声 URL の変換は `audioSourceUrl`、公開 URL からのお手本の安全な取得・抽出は `importSampleUrl` を host が実装する。

Mac の `apps/docs/src/App.tsx` はアカウント hook の結果を渡す。`lib/bridge.ts` は Tauri の実装を持ち、`WindowTitlebar.tsx` は Mac のアイコンを渡す。既存の components / lib import は re-export を残す。画面・保存・実行の既存テストはそのまま共通実装を通る。

## 画面と状態の構成

`DocsApp.tsx` はホストの接続、状態 hooks の組み合わせ、窓の共通部分を持つ。画面の描画と操作・副作用は次に分ける。

| 場所（`src/screens/`） | 責任 |
| --- | --- |
| `HomeScreen`・`FolderScreen`・`DocumentScreen`・`RecordingScreen`・`ArtifactScreen` | ホーム、背景情報、文書、録音、録音から作ったページの描画。`WorkScreen` が選択に対応する画面へ渡す |
| `SettingsScreen`・`FlowDesignScreen`・`WorkspaceDialogs` | 設定、工程設計、確認・比較・書き出しなどのダイアログ |
| `useWorkspaceState`・`useDocsStartup`・`useAccountAvailability` | 画面をまたぐ状態・参照、起動時の読込、接続可否と前回ページの表示 |
| `usePageNavigation`・`useFolderActions` | ページとフォルダの作成・移動・削除、並べ替え、音声の追加 |
| `useFlowActions`・`useExecutionActions`・`useRunReadiness` | 工程設計、実行・停止・受付確認、準備不足の判定 |
| `useArtifactActions`・`useWorkspaceChat`・`useWorkspacePersistence` | 本文・版・別案・会話、保存先ごとの下書き、自動保存と自動の版 |
| `useCloudWorkspace`・`useSettingsActions`・`useWorkspaceCloseGuard` | 同期と本文保護、設定と保存先変更、窓を閉じる前の確認 |
| `workspace-model.ts` | 画面の内部型、キー、名前などの純粋な補助処理 |

状態をまたぐ操作は各 hook に明示的に渡す。先に定義する操作が後の操作を呼ぶ場合は getter で参照し、実行時に初めて読む従来の順序を保つ。

## Host の契約と U3 の接続

```tsx
import { DocsApp } from "niho-docs-ui/screens/DocsApp";
import type { DocsHost } from "niho-docs-ui/host/DocsHost";
import type { DocsAccount } from "niho-docs-ui/host/DocsAccount";

function ConnectedDocs(props: { host: DocsHost; account: DocsAccount }) {
  return <DocsApp bridge={props.host} account={props.account} />;
}
```

共有の保存操作は project / recording / page の ID で対象を指す。編集を開く操作は、本文・SHA・保存先の世代を捕捉した不透明な handle を返す。その後の保存は同じ handle を渡し、古い本文への上書きをホストが拒否する。返り値の保存世代は保存表示に使う。本文、版、実行記録の確定は既存の操作単位を維持する。

`DocsHost` は Mac のファイル・窓・CLI・録音・本人実行・ローカル保管庫とクラウドの同期を optional にしている（一覧は `NATIVE_DOCS_OPERATIONS`）。Web は未対応操作を省略する。`cloudSync: false` の host は Mac 同期の購読・状態取得・編集保護を登録せず、同期状態が無くても起動と前回ページの表示を進める。省略時も `cloudState` を持たない host は同期なしと判断する。`capabilities` の各値はその host が実際に提供できる機能を表す。特に `flowDesign` は端末名と結び付けず、Web が提供できれば `true` にする。

package 内の `controllerHost` は、移設済み controller が使う従来の完全な `Bridge` 型への互換層。未対応 native 操作を呼ぶと `docs_host_unsupported` で拒否する。成功したふりをする既定実装は持たず、元の host の `this`・メソッドの更新・返り値・構造化エラーを保つ。省略した窓の購読や更新案内は登録しない。機能の表示可否は capability と提供された操作で判断する。

U3 は既存の Web transport（vault / runs / composer / settings / Google export）を host から呼ぶ。現在の Web は Mac と保存モデルが異なるため、接続時は操作単位を確認して必要な共通契約を明示的に拡張する。Mac の完全な Bridge を Web で埋めるための no-op / stub は追加しない。

Web の CAS、衝突の 3 択、実行・書き出しの結果不明と同じキーでの再送、下書き復元、同意は host 側が保持する。共通画面に渡すためにこれらを成功へ変換しない。Web の保存状態の表示は、U3 で Web の CAS / 送信状態を表す契約を追加して接続する。Mac の `CloudState` を偽装して渡さない。U2 は Mac の挙動を移す段階であり、Web transport の接続・切替は U3 で行う。スマホの配置は U4 で同じ部品に加える。

## スタイル

```ts
import "niho-ui/styles/tokens.css";
import "niho-docs-ui/styles/tokens.css";
import "niho-docs-ui/styles/app.css";
import "niho-docs-ui/styles/editor.css";
import "niho-docs-ui/styles/account.css";
```

`DocsApp` と窓の shell が `data-docs-app-root` と `data-docs-shared-ui` を持つ。CSS の reset と汎用クラスは両方のある root に限定し、従来 Web layout の root へ漏らさない。エディタのリンクダイアログもその内側へ描き、汎用クラスがほかの NIHO 画面へ漏れない。アニメーション名も docs 専用。ページ全体の `html/body/#root` の寸法と、アカウント部品用 Tailwind の生成・PostCSS の scope は各アプリの接続側が担う（Mac は `styles/window.css`・`styles/account.css`・`postcss.config.cjs`）。Web は既存の Tailwind を使える。

## 依存と検証

共有エディタが直接使う TipTap 8種（React の optional peer の bubble / floating menu を含む）は3者とも `3.31.3` 固定にする（Web の Puck 向け core / pm override と同じ版）。Radix と lucide の依存範囲も揃え、`shared-packages-wiring.test.ts` でずれを防ぐ。

TS / TSX のソースを `exports` する。React・TipTap・lucide・niho-ui などは peerDependencies とし、アプリの中ではそのアプリの `node_modules` を 1 つだけ読む。

- Mac: `apps/docs/vite.config.ts` の `resolve.dedupe` と `apps/docs/tsconfig.json` の型の対応
- Web: `apps/web/shared-packages.cjs`・`tsconfig.json`。`lib/shared-packages-wiring.test.ts` が対応を検査
- package 単独: `vitest.config.ts` は niho-ui の peer も同じ実体へ寄せる

```sh
npm -C packages/docs-ui ci
npm -C packages/docs-ui test
npm -C packages/docs-ui run lint
npm -C packages/docs-ui run typecheck # CI の docs-ui job
```

package 単独テストは FakeHost によるホーム起動、native の省略とエラー保持、CSS / import 分離、エディタの往復を検証する。Mac の既存テストは package を描き、保存・実行・版・背景情報とページの構造の回帰を確認する。型検査と full build は required CI を正とする。

## U3 第1スライス（Web の `?ui=next`）

既定の Web は従来の接続を使う。`ui=next` は `DocsApp` に `DocsWorkspaceHost` を渡し、同じ `Rail`・`HomeScreen`・`FolderHome`・`DocPage` を描く。`DocumentPaper`・`PageTitle`・`BlockEditor` も共通で、Web 接続に別の画面 JSX や CSS は置かない。

`DocsWorkspaceHost.scopeId` は本人・保存先を指し、Mac 同期の `cloudSync` に依存しない。Web host は本人ごとに作り、認証が変わった後の応答と保存操作を適用しない。文書 session は CAS 基準、未確認の同じ受付、保存状態、復元の確認、衝突を持つ。画面を移っても未確認の session を host 内で保持する。host を破棄する際は timer と購読を止め、既存の本人別 draft は既存の復元手順で読む。

第1スライスで露出するのはホーム／フォルダ／文書の読込と文書本文の編集。作成・削除・移動・録音・成果物・runs・composer・設定・Google 書き出しは接続前なので操作を出さない。本文の保存は既存の `saveDocsFullEdit`、固定 mutationId、`DocsPendingSave.resume()`、`resolveDocsConflict`、本人別 draft を Web host が利用する。両方の変更を比べ、選ばなかった側を保護の版に残してから確定する。

URL の `ui`・`demo`・`source` は維持し、一時 query を次の画面へ持ち越さない。進む際は push、ホームへ戻る際は既存 `DocsNavTrail` に従う。アプリ内の移動は保存の確認が必要なら止める。ブラウザの戻る／進むでも未確認 session と draft を保持する。PC の左列は 1024px 以上、AI の列はこのスライスでは全幅で非表示（1280px の並列／1024〜1279px の重なり表示は composer 接続時に行う）。

### 第2スライス: 名前・背景情報

HTTP vault の文書名・フォルダ名・背景情報を `DocsValueSession<T>` で接続する。画面は共通の `PageTitle`・`FolderHome`・`FolderInfoFields` を使う。名前は直接編集し、blur / Enter で保存、Escape で最後に確定した名前へ戻す。Mac の既定の idle 保存は変更しない。失敗時は入力と理由を残して「もう一度」、結果不明では編集を止めて「保存を確認」を出す。demo の名前・背景情報、旧形式フォルダの背景情報は読むだけ。

Web host は既存の `renameDocsPage` / `renameDocsFolder` / `saveDocsFolderInfo` を使い、投影した `OpenProject` を保存しない。フォルダ名は台帳と manifest を同一 commit で変える。背景情報は未編集欄を最新から保ち、同じ欄の競合を「この端末」「クラウド」「比べてから直す」の3択で解く。比較して編集を再開する際も、未編集の最新欄を保持する。保存中の追加入力は確定値に重ね、続けて保存する。

`DocsPendingChange.resume()` は既存 commit helper の固定 mutationId / payload の確認口。確認で明確な拒否を受けた場合だけ通常の再試行へ戻す。結果不明として受け取った要求とマージ済みの確定予定値は本人別 sessionStorage に保持し、再読込後も同じ要求を確認する。送信中にブラウザを強制終了して応答を受け取れなかった場合は入力の控えから復元し、最新の台帳を読み直して保存する。名前・背景情報の復元された入力は自動送信せず、確認して保存する。

アプリ内移動は現在の画面の本文・名前・背景情報の保存を待ち、未確認・競合・失敗が残れば止める。ブラウザの戻る／進むでは session を host に保持し、離脱前に `beforeunload` で確認する。控えの新規保存先は本人所有のタブ内一時領域であり、拠点に所属しない（`specs/policies/data-ownership.md`）。保存が確定した控えは消し、残る控えの期限はタブの sessionStorage の寿命までとする。時間による自動失効は設けない。ログアウトでは本人の控えを消し、遅延応答の適用・控えの再作成を止める。CRUD・録音・工程・composer・設定・Google 書き出しは引き続き非表示。

### 第3スライス: 文書・フォルダの作成、削除、文書の上下移動

`DocsWorkspaceHost.actions` は実装済みの操作だけを渡す。共通Railの各 callback は独立して任意、文書操作は共通PageMenu、削除確認は共通ConfirmDialogを使う。Web用の画面JSXは追加しない。文書は空の題で作って開き、題へフォーカスする。フォルダはRailの名前行でblur/Enter作成、Escape取消。確定失敗では入力を直して同じフォルダIDで再試行できる。送信中・結果不明は入力と追加操作を止める。

Webの操作controllerは固定ID・操作内容を決め、commit送信前の`onPrepared`で固定mutationId/payloadを本人別控えへ記録する。結果不明は同じ要求だけを確認する。確定した操作は先に確定済みと記録し、一覧再読込の失敗は`refresh-failed`として表示だけ再試行する。復元した操作は自動送信しない。作成元のproject/pageも保持し、確認時の場所が一致するときだけ作った文書を開く（応答待ちに別画面へ移った場合は引き戻さない）。削除確定後はhost内にも削除済みの場所を記録し、古いURLへ戻っても編集画面を復活させない。

保存先は既存`niho-docs-metadata-draft:v1:`の本人ID・scope別`workspace-operation`で、本人所有のタブ内一時データ。内容は操作種別・対象ID・作成元の場所・作成名/日時・確定段階と、送信前に準備した固定payload。本文そのもの・音声・認証情報・フォルダ全体は残さない。表示更新まで完了、または明確な失敗を取消すと控えを消し、ログアウトでは本人の控えだけを消す。期限はタブのsessionStorageの寿命まで。

文書の上下移動は最新の完全台帳から文書同士を入れ替え、非表示録音の位置・未知欄を保つ。文書削除は完全台帳を読み、非表示録音の参考ページからも外す。版・assets・会話履歴は保持する。空フォルダ削除は完全台帳・背景情報・全manifestの検査を再実行し、録音・版・画像などが残れば断る。これらの破壊操作の前には表示中と操作対象に残る編集の保存を待つ。

音声作成・フォルダ並べ替え・フォルダ間移動・runs/composer/settings/Google書き出しは引き続き非表示。Macの既存callback・作成ショートカットは保持し、Webには作成ショートカットを出さない。
