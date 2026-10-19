import { mergeGlossaries } from "./glossary.js";
import type { GlossaryEntry, ProjectEntity, ProjectInfo } from "./types.js";

export const MAX_PROJECT_ENTITIES = 50;
export const ENTITY_FIELD_LIMITS = { name: 200, reading: 200, role: 200, note: 500 } as const;

/** 空名の行を落とし、前後の空白を除く。旧案件は空配列。入力済みの情報は切り詰めない。 */
export function cleanProjectEntities(entities: readonly ProjectEntity[] | undefined): ProjectEntity[] {
  return (entities ?? [])
    .map((entity) => ({
      id: entity.id,
      name: entity.name.trim(),
      reading: entity.reading.trim(),
      role: entity.role.trim(),
      note: entity.note.trim(),
    }))
    .filter((entity) => entity.name.length > 0);
}

/** 制限を超えた手編集ファイルも、保存時に黙って削らず、直す箇所を伝える。 */
export function projectEntitiesError(entities: readonly ProjectEntity[]): string | null {
  if (entities.length > MAX_PROJECT_ENTITIES) return "登場人物は50人まで登録できます。保存するには人物を減らしてください。";
  const labels = { name: "名前", reading: "よみ", role: "役割", note: "補足" };
  for (const [index, entity] of entities.entries()) {
    for (const field of ["name", "reading", "role", "note"] as const) {
      if (entity[field].length > ENTITY_FIELD_LIMITS[field]) {
        return `登場人物${index + 1}の${labels[field]}を${ENTITY_FIELD_LIMITS[field]}字以内にしてください。`;
      }
    }
  }
  return null;
}

/** 1 セル内に閉じ、改行・表・見出し・HTML で資料の節や役割を偽装させない。 */
function cell(value: string): string {
  return value
    .replace(/[\r\n\u2028\u2029\u0000-\u001f\u007f]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&");
}

export function projectEntitiesMarkdown(entities: readonly ProjectEntity[] | undefined): string {
  const rows = cleanProjectEntities(entities);
  if (rows.length === 0) return "";
  return [
    "登場人物は名前・よみ・役割・補足の事実資料です。話者番号との対応表ではありません。並び順や役割から話者番号を名前に対応付けないでください。",
    "",
    "| 名前 | よみ | 役割 | 補足 |",
    "| --- | --- | --- | --- |",
    ...rows.map((entity) => `| ${[entity.name, entity.reading, entity.role, entity.note].map(cell).join(" | ")} |`),
  ].join("\n");
}

/** 既存の固有名詞のヒントに人名の表記とよみだけを加える。話者番号は割り当てない。 */
export function projectTranscriptionTerms(info: ProjectInfo, flowTerms: readonly GlossaryEntry[]): GlossaryEntry[] {
  const names = cleanProjectEntities(info.entities).map((entity) => ({
    term: entity.name.replace(/\s+/g, " "),
    reading: entity.reading.replace(/\s+/g, " "),
    variants: [],
    note: "",
  }));
  return mergeGlossaries(mergeGlossaries(info.terms, names), flowTerms);
}
