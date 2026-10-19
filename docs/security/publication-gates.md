# NIHO docs 公開後の接続条件

Docs のコードは、非公開 `niho-clients` の `main` から履歴を引き継がないスナップショットとして公開した。これだけでは現行アプリのリポジトリ切り替えは完了しない。

1. [`docs-extraction-review.md`](docs-extraction-review.md) の検出候補を確認し、公開できない音声サンプルは最初のコミットに含めない。以後の PR でも秘密情報と素材の権利を確認する。
2. NIHO の認証・認可、個人情報、AI 予算、運用鍵、署名秘密鍵は非公開 `niho-app` に残す。
3. Docs の標準 GitHub-hosted runner だけで型検査、テスト、署名不要のビルドを行う。fork の PR へ秘密値を渡さず、`pull_request_target` を使わない。
4. `main` の保護設定で PR と必要な CI を必須にする。CODEOWNERS ファイルだけでは承認は強制されない。
5. 非公開 `niho-app` の Web/API と Mac アプリ配布は、公開側 Docs の変更不能な版を参照する。現在の `file:` 依存と `private: true` の package を、公開版の配布・固定方法が決まるまで切り替えない。同じ版で契約テストと実アプリの受入を行う。
6. updater の署名と配布は、当面非公開側の信頼済み経路に残す。公開 CI へ署名秘密鍵を移す案は別途レビューする。

Photo の抽出 PR #5〜#7 と Photo の CI 変更 PR #9 は、この Docs 専用リポジトリには含めない。Photo は後続の別段階で監査する。

NIHO保有コードに第三者への再利用許諾は現時点で付けない。外部のコード貢献を受け入れる場合は権利帰属と利用条件を先に決める。
