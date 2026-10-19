"use client";

import { ENTITY_FIELD_LIMITS, MAX_PROJECT_ENTITIES, type ProjectEntity } from "@niho/docs-core";
import { newId } from "../lib/format";

/** 案件の登場人物。話者番号の割り当ては録音・本文側で行う。 */
export function ProjectEntities(props: { entries: readonly ProjectEntity[]; onChange: (entries: ProjectEntity[]) => void }) {
  const change = (id: string, field: "name" | "reading" | "role" | "note", value: string) =>
    props.onChange(props.entries.map((entry) => (entry.id === id ? { ...entry, [field]: value } : entry)));
  const fields = [
    ["name", "名前"],
    ["reading", "よみ"],
    ["role", "役割"],
    ["note", "補足"],
  ] as const;
  return (
    <div className="gl" role="group" aria-label="登場人物">
      <div className="glh" aria-hidden="true">
        {fields.map(([field, label]) => <span key={field}>{label}</span>)}
        <span />
      </div>
      {props.entries.map((entry, index) => (
        <div className="glr" key={entry.id}>
          {fields.map(([field, label]) => (
            <input
              key={field}
              aria-label={`登場人物${index + 1}の${label}`}
              value={entry[field]}
              maxLength={ENTITY_FIELD_LIMITS[field]}
              onChange={(event) => change(entry.id, field, event.target.value)}
            />
          ))}
          <button
            type="button"
            className="ibtn sm danger"
            title="削除"
            aria-label={`登場人物${index + 1}を削除`}
            onClick={() => props.onChange(props.entries.filter((candidate) => candidate.id !== entry.id))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="link"
        disabled={props.entries.length >= MAX_PROJECT_ENTITIES}
        title={props.entries.length >= MAX_PROJECT_ENTITIES ? "登場人物は50人まで登録できます。" : undefined}
        onClick={() => props.onChange([...props.entries, { id: newId("person"), name: "", reading: "", role: "", note: "" }])}
      >
        ＋ 登場人物を追加
      </button>
    </div>
  );
}
