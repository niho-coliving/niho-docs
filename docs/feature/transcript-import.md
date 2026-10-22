# VTT文字起こしの取込

## 目的

既存のWebVTT文字起こしを原文として保存し、音声認識を行わずにユーザーが設計した後工程を実行できるようにする。MacとWebは同じ`docs-core`のデータ契約・検証と、`docs-ui`の入口・開始前判定を使う。

話者の再推定、話者名の置換、推定結果の承認、音声の後付け、既存テンプレートの自動変更はこの機能に含めない。

## 保存契約

工程は`Flow.transcription`に文字起こし工程の有無を保存する。

- `true`: 音声を文字起こししてから後工程へ進む。
- `false`: 取込済みVTT原文から後工程へ進み、音声認識を実行しない。
- 欠落: 旧データとの互換のため`true`として扱う。

新規作成、保存、複製、`FlowSnapshot`は真偽値を明示する。設計比較、録音へ現在の設計を反映する確認、実行前提のhashにもこの値を含める。ただし、欠落した旧データと明示的な`true`は同じ設計・同じ従来hashとして扱う。

VTT取込後のsourceは既存のtext sourceで、取込由来を次のmetadataで識別する。

```ts
{
  kind: "text",
  transcriptImport: {
    format: "vtt",
    file: "source.vtt",
    name: string,
    hash: string
  }
}
```

`hash`は原本バイト列のSHA-256、`name`はユーザーが選んだ元ファイル名である。通常の貼り付け文章はmetadataを持たず、従来どおり「文章」として扱う。取込VTTは原文ページで「文字起こし」として扱う。

録音の保存場所は次のとおりで、新しいuser/spotモデルや別保管庫は作らない。

- 原本: 録音の`inputs/source.vtt`
- 編集・後工程入力用Markdown: 従来の`transcript.md`と`versions/source/`
- 実行記録: 従来のsource保存record
- 取込metadata: 従来の`recording.json`内のsource

この配置により、既存のvault同期、録音削除、sourceVersion参照の境界に原本と派生物を含める。

## VTTの検証と変換

`packages/docs-core`の`parseVtt`を共通の解析器とする。10 MiBを上限とし、ファイル全体を検証してから保存へ進む。

解析器はUTF-8のBOM、CRLF/LF、字幕ID、開始・終了時刻、cue settings、複数行の本文、`NOTE`、`STYLE`、`REGION`、一般的な`<v 話者>`を扱う。空、発言なし、不正な時刻、終了が開始より前、不正block、上限超過は成功させない。

派生Markdownは既存の`[hh:mm:ss] 本文`にそろえ、時刻を二重表示しない。ミリ秒を含む開始・終了時刻と字幕IDは解析結果のcueと保存する原本で保持する。voice tagの注釈は表記を推定・補正せず、そのまま話者ラベルへ写す。それ以外のタグはHTMLとして解釈されない安全な文字列へ変換し、未処理HTMLをDOMへ渡さない。原本のバイト列は変換せず別途保存するため、BOM、改行、字幕ID、非発言blockを含む入力全体を保持する。

## 取込トランザクション

hostの`importTranscript`は、素材のない録音だけを対象に、同じ録音への書込みを直列化して次を一つの操作として確定する。

1. 対象が音声0件、原文なし、VTT原本なしであることを再確認する。
2. 原本を`inputs/source.vtt`へ原子的に書く。
3. 派生Markdownのsource版、最新版、保存recordを書く。
4. text sourceと`transcriptImport` metadataを`recording.json`へ確定する。

途中で失敗した場合は、この操作が作った原本、版、最新版、recordを戻す。既存の音声・本文・原本には上書きしない。同時取込の一方だけが成功し、失敗後は空の保存先へ再試行できることをhost実装のテストで保証する。

## 共通UIと実行

工程設計の「原文の準備」で「音声を文字起こしする」を明示的に保存できる。オフの場合は固定の文字起こしカードを表示せず、後工程を1番から表示する。工程一覧、複製、保存、録音snapshotも同じ値を使う。

素材のない音声欄に「VTTを取り込む」を出す。既存の空録音と、背景情報から新しい録音を作る入口の両方で共通部品を使う。取込失敗は画面内で理由を表示し、確定した録音だけを再読込する。

開始前にsourceと工程の組合せを検査する。

- 文字起こしあり工程: 音声、または互換対象の従来plain textから開始できる。VTT取込sourceは「文字起こしなし工程を選ぶ」理由を表示する。
- 文字起こしなし工程: 保存済みVTT原文からだけ開始できる。空・音声・従来plain textはVTTが必要な理由を表示する。

文字起こしなし工程の実行queueと全再実行queueにはsource stepを入れない。確定済みsourceVersionを入力として、既存の実行先設定で後工程だけを順次実行する。この経路はマイク、音声認識モデル、音声runnerの準備を要求しない。

## Web host接続契約

Webは公開`DocsHost.Bridge`の任意メソッドを実装する。

```ts
importTranscript(
  recording: RecordingRef,
  transcript: { name: string; originalBase64: string; markdown: string },
  record: RunRecord,
): Promise<void>
```

Web hostは、共通UIで解析済みの原本とMarkdownをユーザーのvaultへ上記トランザクションで保存し、保存確定後のsourceVersionを既存run受付へ渡す。サーバー境界ではサイズ、UTF-8、VTT全体、空保存先、metadata形状を再検査する。APIのrun計画は`flow.transcription === false`ならASRを実行せず、確定したVTT sourceVersionを原文入力として後工程だけを受け付ける。原文を入力として記録することと、文字起こし処理の実行は区別する。保存・実行の失敗時に、取込未確定のsourceをrunへ渡してはならない。

Web/API固有のvault transport、認可、run受付は非公開host側の責務であり、この公開リポジトリへ複製しない。

## 互換性

- `transcription`がないFlow/FlowSnapshotは従来どおり文字起こしあり。
- audio sourceと通常のtext sourceの形・保存経路は変更しない。
- 既存の貼り付け文章はVTTと見なさず、既存の実行を維持する。
- 既存の話者表示・AIラベル除去規則は変更しない。
- audio拡張子一覧へ`.vtt`を追加しない。
