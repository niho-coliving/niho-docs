# NIHO docs

NIHO docs の公開クライアントコードです。認証・認可、個人情報、AI 予算、API・DB、署名と配布の権限は非公開の `niho-app` に置きます。公式サービスの利用には NIHO ログインが必要です。

## コードの利用条件

NIHO が著作権を持つコードに、第三者による利用・改変・再配布の許諾は付けていません。第三者が権利を持つ素材や依存ライブラリには、それぞれのライセンスが適用されます。公開前に素材と履歴を別途監査します。

公開コードと非公開サービスの接続条件は [`docs/security/publication-gates.md`](docs/security/publication-gates.md) に記録しています。Photo は別の段階で扱います。

## 現在の抽出範囲

- `packages/docs-core`: Docs の純粋な型・文書規則・会話・実行状態のロジック。
- `packages/docs-ui`: Mac・Web/PWA 共通の Docs 画面とホスト接続契約。
- `packages/ui`: Docs / Photo / Web で共通の画面部品。
- `packages/desktop-account`: 既存の NIHO 接続 API を使う Mac 側の PKCE・token 更新・状態の実装。ログイン判定を行う API / DB はこのリポジトリに含めない。
- `packages/desktop-vault`: Docs の端末内保存と本人保管庫との同期クライアント。本人・所有権の判定は API 側で行う。
- `apps/docs`: NIHO docs の Mac アプリ本体。API・DB・アカウント発行側は含めず、署名・配布 workflow はこの段階では有効化しない。
- `packages/apple-speech`: Mac の音声文字起こしに使う共有 Swift 実装。
- `packages/article-style-sample-core`: Mac と非公開 API が参照する、ネットワーク取得を含まない記事お手本の抽出ロジック。API 側の参照切り替えは統合 PR で行う。
- `apps/docs/fixtures`: Docs Core と将来の Mac 実装が共有する合成テストデータの一部。

`packages/docs-core` のテストのうち、NIHO の非公開仕様書・デザインガイドを直接読む 3 ファイルは元リポジトリに残しています。公開側の単体テストと、元リポジトリ側の仕様整合テストを両方通してから依存を切り替えます。

`packages/desktop-account` のテストのうち、非公開サーバーの登録表をソースとして読む 2 件も元リポジトリに残しています。公開側の端末テストに加え、元リポジトリ側の契約照合を依存切り替え時に維持します。

```sh
npm -C packages/docs-core ci
npm -C packages/docs-core run check
npm -C packages/ui ci
npm -C packages/ui run typecheck
npm -C packages/ui run lint
npm -C packages/ui test
npm -C packages/docs-ui ci
npm -C packages/docs-ui run typecheck
npm -C packages/docs-ui run lint
npm -C packages/docs-ui test
cargo test --manifest-path packages/desktop-account/Cargo.toml --locked
npm -C packages/desktop-account/ts ci
npm -C packages/desktop-account/ts run typecheck
npm -C packages/desktop-account/ts run lint
npm -C packages/desktop-account/ts test
cargo test --manifest-path packages/desktop-vault/Cargo.toml --locked
npm -C apps/docs ci
npm -C apps/docs run typecheck
npm -C apps/docs test
npm -C apps/docs run build
cargo test --manifest-path apps/docs/Cargo.toml --locked --workspace
swift test --package-path apps/docs/sidecar/niho-speech
swift test --package-path packages/apple-speech
```
