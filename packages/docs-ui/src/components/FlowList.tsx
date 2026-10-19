"use client";

import { FLOW_TEMPLATES } from "@niho/docs-core";
import type { FlowChoice } from "./FlowPicker";
import { FlowIcon } from "./icons";
import { usePopover } from "./usePopover";

/**
 * 工程設計の上のフローの一覧（P4 #18567。spec §7）: 行＝名前・「N 工程」（工程 1 を含む数）。開いているフローは aria-current。
 * 行を押すとそのフローを開く（編集中の内容はフローごとに残る）。行の ⋯ に 複製・名前の変更・削除。末尾の「＋ 追加」で
 * テンプレート（4 つ。同格）か白紙から新しいフローを足す。名前と工程の数は保存済みの値で、編集中の内容があれば「未保存」。
 */

/** 一覧の 1 行（保存済みの名前と工程の数。編集中の内容が保存と違えば unsaved）。 */
export type FlowRow = { id: string; name: string; steps: number; unsaved: boolean; readOnlyReason?: string };

function RowMenu(props: { name: string; disabled: boolean; onDuplicate: () => void; onRename: () => void; onDelete: () => void; onMove?: (delta: -1 | 1) => void; first?: boolean; last?: boolean }) {
  const menu = usePopover();
  const pick = (action: () => void) => () => {
    menu.setOpen(false);
    action();
  };
  return (
    <div ref={menu.ref} className="fmore">
      <button
        type="button"
        className="ibtn sm"
        title="その他"
        aria-label={`「${props.name}」のその他`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        disabled={props.disabled}
        onClick={menu.toggle}
      >
        ⋯
      </button>
      {menu.open && (
        <div className="pop" role="menu">
          {props.onMove && <><button type="button" className="mi" role="menuitem" disabled={props.first} onClick={pick(() => props.onMove?.(-1))}>上へ移動</button><button type="button" className="mi" role="menuitem" disabled={props.last} onClick={pick(() => props.onMove?.(1))}>下へ移動</button></>}
          <button type="button" className="mi" role="menuitem" onClick={pick(props.onDuplicate)}>
            複製
          </button>
          <button type="button" className="mi" role="menuitem" onClick={pick(props.onRename)}>
            名前の変更
          </button>
          <button type="button" className="mi danger" role="menuitem" onClick={pick(props.onDelete)}>
            削除
          </button>
        </div>
      )}
    </div>
  );
}

function AddMenu(props: { disabled: boolean; onAdd: (choice: FlowChoice) => void }) {
  const menu = usePopover();
  const pick = (choice: FlowChoice) => () => {
    menu.setOpen(false);
    props.onAdd(choice);
  };
  return (
    <div ref={menu.ref} className="fadd">
      <button type="button" className="link" aria-haspopup="menu" aria-expanded={menu.open} disabled={props.disabled} onClick={menu.toggle}>
        ＋ 追加
      </button>
      {menu.open && (
        <div className="pop" role="menu" aria-label="追加する工程">
          {FLOW_TEMPLATES.map((template) => (
            <button key={template.id} type="button" className="mi" role="menuitem" onClick={pick(template)}>
              {template.name}
              <span className="sub">{template.steps.length + 1} 工程</span>
            </button>
          ))}
          <button type="button" className="mi" role="menuitem" onClick={pick("blank")}>
            白紙から
          </button>
        </div>
      )}
    </div>
  );
}

export function FlowList(props: {
  rows: readonly FlowRow[];
  /** 工程設計で開いているフロー。 */
  currentId: string;
  /** 追加・複製・削除の途中（⋯ と「＋ 追加」を押せない）。 */
  busy: boolean;
  onOpen: (flowId: string) => void;
  onAdd: (choice: FlowChoice) => void;
  onDuplicate: (flowId: string) => void;
  onRename: (flowId: string) => void;
  onDelete: (flowId: string) => void;
  onMove?: (flowId: string, delta: -1 | 1) => void;
}) {
  return (
    <div className="flist" role="group" aria-label="工程の一覧">
      {props.rows.map((row, index) => {
        const current = row.id === props.currentId;
        return (
          <div key={row.id} className={`frow${current ? " on" : ""}`}>
            <button type="button" className="fgo" disabled={props.busy} aria-current={current ? "true" : undefined} onClick={() => props.onOpen(row.id)}>
              <FlowIcon />
              <span className="nm">{row.name}</span>
              {row.unsaved && <span className="pill mute">未保存</span>}
              {row.readOnlyReason && <span className="pill mute" title={row.readOnlyReason} aria-label={row.readOnlyReason}>編集できません</span>}
              <span className="cnt">{row.steps} 工程</span>
            </button>
            <RowMenu
              name={row.name}
              first={index === 0}
              last={index === props.rows.length - 1}
              onMove={props.onMove ? (delta) => props.onMove?.(row.id, delta) : undefined}
              disabled={props.busy || Boolean(row.readOnlyReason)}
              onDuplicate={() => props.onDuplicate(row.id)}
              onRename={() => props.onRename(row.id)}
              onDelete={() => props.onDelete(row.id)}
            />
          </div>
        );
      })}
      <div className="facts">
        <AddMenu disabled={props.busy} onAdd={props.onAdd} />
      </div>
    </div>
  );
}
