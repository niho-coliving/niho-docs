//! 出力の上限（max_tokens）で止まった文と、その続きの結合。
//!
//! 続きを頼むと、AI は前の出力の末尾を少し繰り返してから書き始めることがある。そのままつなぐと同じ文が 2 回残るので、
//! 重なりを除いてつなぐ。規則は spec 5.4 の「最長一致・4〜400 字・空白だけの重なりは除かない」で、アプリの続きの結合
//! （docs-core の `continuationOverlap`）と同じ（S0 #18381 の 5 の実測で揃えた）。どちらかを変えるときは両方を揃える。

/// 最長で見る重なり（文字数）。これより長い繰り返しは AI の書き直しとみなして除かない。
const MAX_OVERLAP_CHARS: usize = 400;
/// 最短で見る重なり（文字数）。これより短い一致は偶然とみなして除かない。「いい天気」が「い｜い天気」で切れて続きが
/// 重なり無しで始まったとき、1 文字の一致を重なりとみなすと正しい「い」を黙って消してしまう。実測の重なりは 5 文字
/// （「45: 四十」＋「5: 四十五」）で、実際の長さの続き 3 か所は重なり 0 だった（#18381）。
const MIN_OVERLAP_CHARS: usize = 4;

/// 前の出力の末尾と続きの先頭の重なり（最長一致・4〜400 文字・空白だけは除かない）を除いてつなぐ。
/// 戻り値は (つないだ文, 除いた文字数)。
///
/// 文字（char）単位で数えるので、日本語の文字の途中では切らない。k = min(400, prev の文字数, next の文字数) から
/// 4 まで下げ、next の先頭 k 文字が空白だけでなく、prev がそれで終われば、next の先頭 k 文字を除いて足す。無ければそのまま足す。
pub fn merge_continuation(prev: &str, next: &str) -> (String, usize) {
  // next の先頭から k 文字目の終わりのバイト位置（k = 1..）。char の境目だけを候補にする
  let boundaries: Vec<usize> = next
    .char_indices()
    .map(|(index, ch)| index + ch.len_utf8())
    .take(MAX_OVERLAP_CHARS)
    .collect();
  let max_k = boundaries.len().min(prev.chars().count());
  for k in (MIN_OVERLAP_CHARS..=max_k).rev() {
    let head = &next[..boundaries[k - 1]];
    // 改行や空白だけの一致は段落の区切りなので残す（除くと「話者A: …\n」＋「\n話者B: …」の空行が消える）
    if head.trim().is_empty() {
      continue;
    }
    // UTF-8 は自己同期なので、バイトの後方一致が成り立てば prev 側の一致の始まりも char の境目になる
    if prev.ends_with(head) {
      let mut merged = String::with_capacity(prev.len() + next.len() - head.len());
      merged.push_str(prev);
      merged.push_str(&next[head.len()..]);
      return (merged, k);
    }
  }
  let mut merged = String::with_capacity(prev.len() + next.len());
  merged.push_str(prev);
  merged.push_str(next);
  (merged, 0)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn removes_the_measured_overlap_in_kanji_numbers() {
    let prev = "43: 四十三\n44: 四十四\n45: 四十";
    let next = "5: 四十五\n46: 四十六";
    assert_eq!(
      merge_continuation(prev, next),
      ("43: 四十三\n44: 四十四\n45: 四十五\n46: 四十六".to_string(), 5)
    );
  }

  #[test]
  fn appends_as_is_without_overlap() {
    assert_eq!(
      merge_continuation("前の文。", "次の文。"),
      ("前の文。次の文。".to_string(), 0)
    );
  }

  #[test]
  fn whole_next_overlapping_adds_nothing() {
    assert_eq!(
      merge_continuation("見出し\n本文の続き", "本文の続き"),
      ("見出し\n本文の続き".to_string(), 5)
    );
    assert_eq!(
      merge_continuation("同じ文の繰り返し", "同じ文の繰り返し"),
      ("同じ文の繰り返し".to_string(), 8)
    );
  }

  #[test]
  fn overlap_longer_than_400_chars_stops_at_400() {
    let prev = "あ".repeat(500);
    let next = "あ".repeat(500);
    let (merged, removed) = merge_continuation(&prev, &next);
    assert_eq!(removed, 400);
    assert_eq!(merged.chars().count(), 600);
  }

  #[test]
  fn empty_strings_are_appended_as_is() {
    assert_eq!(merge_continuation("", "続き"), ("続き".to_string(), 0));
    assert_eq!(merge_continuation("前", ""), ("前".to_string(), 0));
    assert_eq!(merge_continuation("", ""), (String::new(), 0));
  }

  #[test]
  fn short_coincidental_overlaps_are_kept() {
    // 「いい天気」が「い｜い天気」で切れて、続きが重なり無しで始まった。1 文字の一致で正しい「い」を消さない
    assert_eq!(
      merge_continuation("今日はい", "い天気ですね"),
      ("今日はいい天気ですね".to_string(), 0)
    );
    // 3 文字までの一致も偶然とみなして残す（本当の繰り返しなら重複が見えるだけで、本文は欠けない）
    assert_eq!(
      merge_continuation("前の文の末尾ABC", "ABCで始まる続き"),
      ("前の文の末尾ABCABCで始まる続き".to_string(), 0)
    );
    // 4 文字からは重なりとして除く
    assert_eq!(
      merge_continuation("話者1: そうそう", "そうそう、それで"),
      ("話者1: そうそう、それで".to_string(), 4)
    );
  }

  #[test]
  fn whitespace_only_overlaps_are_kept() {
    // 段落の区切りの空行を消さない
    assert_eq!(
      merge_continuation("話者0: はい。\n\n\n\n", "\n\n\n\n話者1: どうも。"),
      ("話者0: はい。\n\n\n\n\n\n\n\n話者1: どうも。".to_string(), 0)
    );
    // 空白を含んでも、空白だけでなければ重なりとして除く
    assert_eq!(
      merge_continuation("第1章 はじめに", " はじめに\n第2章"),
      ("第1章 はじめに\n第2章".to_string(), 5)
    );
  }

  #[test]
  fn counts_characters_not_bytes_at_japanese_boundaries() {
    // 4 文字（12 バイト）の重なり
    assert_eq!(
      merge_continuation("あいうえお", "いうえおかき"),
      ("あいうえおかき".to_string(), 4)
    );
    // 「語」の先頭バイトだけが同じでも重ならない（文字の途中では切らない）
    assert_eq!(
      merge_continuation("日本語の単語", "誤りの訂正"),
      ("日本語の単語誤りの訂正".to_string(), 0)
    );
    // 英数字と日本語が混ざっても、最長の一致を選ぶ
    assert_eq!(
      merge_continuation("第1章 はじめに", "はじめに\n第2章"),
      ("第1章 はじめに\n第2章".to_string(), 4)
    );
  }
}
