//! store_flows.rs のテスト。工程の形の検査（`flow_shape_ok`）は docs-core の `isFlowShape`（packages/docs-core/src/shape.ts）と
//! 同じ結果になる。見本は apps/docs/fixtures/flow-shape/cases.json で、docs-core の shape.test.ts も同じものを読む
//! （片方だけ直すと、もう片方のテストが落ちる）。

use super::*;

#[test]
fn flow_shape_matches_the_shared_fixture() {
  let cases: Vec<Value> = serde_json::from_str(include_str!("../../fixtures/flow-shape/cases.json")).unwrap();
  assert!(cases.len() >= 30, "the shared fixture is missing cases");
  for case in &cases {
    let name = case["name"].as_str().unwrap();
    let flow = &case["flow"];
    // flows/<id>.json を読むときの判定: 中身の id が文字列で、flow_shape_ok を通る（flow_id_of が見る欄）。
    let actual = flow.get("id").is_some_and(Value::is_string) && flow_shape_ok(flow);
    assert_eq!(actual, case["valid"].as_bool().unwrap(), "{name}");
  }
}
