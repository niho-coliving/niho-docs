# 公開境界とゼロトラスト契約

2026-10-20 時点の公開方針。NIHO Docs と NIHO Photo の公開クライアントは、ソース・配布物・通信・API contract が攻撃者に知られ、改変できることを前提にする。公開は利用許諾を意味しない。

## 公開するもの

原則として、次は公開リポジトリで開発・検証する。

- Docs / Photo クライアント、共通 UI / Core、ローカル保存とクラウド共有のクライアント
- OAuth 2.1 / Authorization Code + PKCE のクライアント、client ID、公開 endpoint
- クラウド共有の状態機械、型、エラー分類、mock、合成データを使う contract test
- build / test / lint、secretless で fork-safe な CI、SBOM、固定 SHA 取り込み契約
- NIHO が権利を持つアイコン・画像・テンプレート等の資産

クライアントは表示や操作を制御できても、認証・認可の最終判断をしない。endpoint を隠すこと、難読化、client 側の role 判定、推測しにくい ID だけを防御として扱わない。

## 非公開に残すもの

非公開にする範囲は、秘密・実データ・最終権限・運用詳細に限定する。

- client secret、署名鍵、service account、storage credential、runtime token
- ユーザー文書・写真・共有データ・PII・実ログ・監査記録
- 認証 / 認可の最終判定、API 実装、DB、object storage、鍵管理
- 内部ネットワーク、管理者専用 route、運用上の回避経路
- 正確な abuse / rate-limit 閾値、検知ルール、未修正脆弱性、incident 詳細
- signing / notarization / deploy / production release の権限と実処理
- 権利関係を確認できない第三者資産

「非公開だから安全」とは扱わない。サーバーは公開された client と契約を前提に、毎 request で認証・認可する。

## 攻撃者モデルとサーバー要件

攻撃者は、公開ソース・配布バイナリ・endpoint・request / response を知り、正規アカウントと token を持ち、client を改変し、object ID や share ID を観測・推測・再送できる。

private API は少なくとも次を強制する。

- token の issuer / audience / expiry / signature と、user / tenant / workspace / resource の所有権・操作権限を毎 request 検証する。
- request の actor / owner / role / quota / MIME / size / object key を信用せず、object ID を知るだけではアクセスさせない。
- upload / download capability は短命・用途限定・resource 限定にする。永続 storage credential を client へ渡さない。
- MIME 宣言だけに頼らず、magic bytes・size・checksum・quota を検証する。
- idempotency と nonce または同等手段で replay と重複処理を制御する。失効済み capability や share は拒否する。
- rate limit・abuse 検知・監査・強制失効を server-side で行う。
- 管理者 API を public client contract に混ぜず、error から内部構成・他 tenant の存在・秘密を漏らさない。

公開 test は合成データだけを使う。versioned contract の test-only reference model は負例と期待 error を確認するもので、production API の実装でも server-side authorization の証明でもない。

## Docs / Photo 共通 contract

Docs / Photo 共通クラウド contract の正本と変更責任者は `niho-docs` の [`packages/niho-cloud-contract`](../../packages/niho-cloud-contract/) とする。初版は version `1`。型・操作・error code・adversarial test vector を同じ version の下で管理し、Photo 側の利用 PR はこの正本の commit SHA を固定する。

contract の更新には次を必須にする。

1. 正本側で versioned contract test を通す。
2. Photo 側にも同じ SHA を取り込む PR を用意し、その CI を通す。
3. 両方の PR に相互リンクを付け、両側の review を終えてから merge する。
4. 互換性を壊す変更は新しい major version とし、旧版の利用期間と移行条件を明記する。

contract は認証 context、resource owner / tenant / workspace、upload / download / share / revoke / list、capability の scope / expiry / 再利用条件、idempotency、content 検証、error 分類を含める。秘密、実データ、内部 topology、正確な abuse 閾値は含めない。現在の version 1 は [`cloud-contract-v1.md`](cloud-contract-v1.md) を参照する。

## CI と成果物

公開 CI は標準 GitHub-hosted runner で動かし、fork の PR に secrets を渡さない。`pull_request_target` で未信頼コードを実行しない。permissions は必要最小限にし、契約の負例を合成データで検証する。

source map、artifact、log、fixture には secret、PII、private endpoint、内部 topology を含めない。公開 SHA を private 側へ固定して取り込むときは、対象 commit と source hash を記録し、private の契約検査・受入を通す。`niho-app` の実装・Actions・PR はこの公開 repo の変更対象にしない。

## 脆弱性報告

未修正脆弱性や exploit 詳細を public issue / PR に書かない。報告者には GitHub の private vulnerability reporting を使ってもらい、利用できない場合は技術詳細を公開せず、private な連絡方法を maintainer に問い合わせてもらう。利用者向け手順は [`SECURITY.md`](../../SECURITY.md) に記載する。
