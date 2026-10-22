# 非公開Docs PRから公開SDKへの切り出し状況

2026-10-22に、NIHOappで未マージのDocs関連PR 11件と、このリポジトリのmainを照合した記録です。公開PRのマージ状態と、対象ファイルのGit objectを確認しています。古いPRのファイルで現在の公開版を上書きせず、公開側に不足していた表示部品だけを追加します。

| NIHOapp PR | 公開側の対応 | NIHOapp側で引き続き必要なもの |
| --- | --- | --- |
| [#19028](https://github.com/niho-coliving/niho-app/pull/19028) 自動参考 | [#9](https://github.com/niho-coliving/niho-docs/pull/9)・[#11](https://github.com/niho-coliving/niho-docs/pull/11)でCoreとMacクライアントをマージ済み | APIでの入力確定・認可とWebホストへの接続 |
| [#19030](https://github.com/niho-coliving/niho-app/pull/19030) 保存先切替 | [#8](https://github.com/niho-coliving/niho-docs/pull/8)・[#14](https://github.com/niho-coliving/niho-docs/pull/14)でクライアントをマージ済み | 移行・削除を確定するAPIと受入 |
| [#19032](https://github.com/niho-coliving/niho-app/pull/19032) Web保存先・録音救出 | [#3](https://github.com/niho-coliving/niho-docs/pull/3)で共通語彙をマージ済み。本変更で保存先画面を `niho-docs-ui/storage-mode` に切り出し | 保存先の読取・選択、認証、利用者ごとの端末録音へのアクセスと救出 |
| [#19063](https://github.com/niho-coliving/niho-app/pull/19063) 次の工程 | [#2](https://github.com/niho-coliving/niho-docs/pull/2)で共通規則をマージ済み。本変更でPC・モバイル・メニュー・帯を `niho-docs-ui/next-steps` に切り出し | 実行の受付・照会・停止確認とWebのルーティング |
| [#19069](https://github.com/niho-coliving/niho-app/pull/19069) LOCAL書き出し | [#6](https://github.com/niho-coliving/niho-docs/pull/6)・[#7](https://github.com/niho-coliving/niho-docs/pull/7)・[#14](https://github.com/niho-coliving/niho-docs/pull/14)で選択規則とMacクライアントをマージ済み | Google接続、APIでの一時転送・確定・削除と受入 |
| [#19074](https://github.com/niho-coliving/niho-app/pull/19074) LOCAL端末配送 | [#10](https://github.com/niho-coliving/niho-docs/pull/10)・[#20](https://github.com/niho-coliving/niho-docs/pull/20)でクライアントをマージ済み | 端末配送・実行のAPIと権限・予算の管理 |
| [#19113](https://github.com/niho-coliving/niho-app/pull/19113) 文字起こしの別案 | [#5](https://github.com/niho-coliving/niho-docs/pull/5)・[#18](https://github.com/niho-coliving/niho-docs/pull/18)でMacと共通UIをマージ済み | 選択原文を扱うAPI側の実行条件と接続 |
| [#19285](https://github.com/niho-coliving/niho-app/pull/19285) 共有モック・ignore | 機能の実装差分ではなく、過去の検討資料と非公開リポのignore整備のため今回のSDK切り出し対象外 | 元PRの資料・運用変更として扱う |
| [#19337](https://github.com/niho-coliving/niho-app/pull/19337) ホーム作成 | [#24](https://github.com/niho-coliving/niho-docs/pull/24)・[#25](https://github.com/niho-coliving/niho-docs/pull/25)で共有画面・Mac・SDK基盤をマージ済み | Webホストと固定版SDKの統合 |
| [#19338](https://github.com/niho-coliving/niho-app/pull/19338) VTT | [#22](https://github.com/niho-coliving/niho-docs/pull/22)でCore・共有画面・Macをマージ済み | Web/APIでの保存・認可・実行への接続 |
| [#19339](https://github.com/niho-coliving/niho-app/pull/19339) 背景情報の伸縮 | [#23](https://github.com/niho-coliving/niho-docs/pull/23)で共通部品をマージ済み | 固定公開版の取り込みとWebホストでの受入 |

公開への切り出しだけで非公開PRを完了・closeしません。Webホストは、レビュー済み公開mainから発行した固定SDK版を検証して採用し、上表のAPI・認証・端末データの接続を維持します。公開ブランチの直接importや、非公開の複製への手編集で同期を代替しません。今回の表示部品の移植だけではSDKの発行・非公開Webへの切替・API配備は実施しません。

Macの未配備APIに依存する入口は、[配布境界](release-boundary.md)のfeature gateを維持します。新しい表示部品に本人確認・保存先選択・録音読取・実行開始の副作用を持たせず、ホストの状態と明示操作のcallbackだけを受け取ります。
