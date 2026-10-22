"use client";

import { flowHasTranscription, type Flow } from "@niho/docs-core";
import { FlowDesign } from "../components/FlowDesign";
import { FlowList } from "../components/FlowList";
import { FlowPickerPanel, type FlowChoice } from "../components/FlowPicker";
import { type Screen } from "../components/Rail";
import { type Bridge } from "../lib/bridge";
import { type AppSettings } from "../lib/settings";
import { type FlowOrigin } from "./workspace-model";

type Props = {
  screen: Screen;
  designFlow: Flow | null;
  busy: boolean;
  flowOrigin: FlowOrigin | null;
  chooseFlow: (choice: FlowChoice) => Promise<void>;
  flowDrafts: Record<string, Flow>;
  settings: AppSettings;
  bridge: Bridge;
  deletingFlow: { flow: Flow; usage: number; samples: boolean; } | null;
  flowImporting: boolean;
  onFlowImportingChange: (importing: boolean) => void;
  flows: Flow[];
  flowsBusy: boolean;
  openFlow: (flowId: string) => void;
  addFlow: (choice: FlowChoice) => Promise<void>;
  duplicateFlowOf: (flowId: string) => Promise<void>;
  renameFlow: (flowId: string) => void;
  askDeleteFlow: (flowId: string) => Promise<void> | undefined;
  focusFlowName: boolean;
  setFocusFlowName: React.Dispatch<React.SetStateAction<boolean>>;
  putFlowEdit: (flowId: string, edit: Flow | null) => void;
  saveFlow: (edited: Flow) => Promise<void>;
  markNavigation: () => void;
  applyScreen: (next: Screen) => void;
};

/** FlowDesignScreen の描画。保存・実行・遷移の操作は controller から受け取る。 */
export function FlowDesignScreen(props: Props) {
  const {
    screen, designFlow, busy, flowOrigin,
    chooseFlow, flowDrafts, settings, bridge,
    deletingFlow, flowImporting, onFlowImportingChange, flows,
    flowsBusy, openFlow, addFlow, duplicateFlowOf,
    renameFlow, askDeleteFlow, focusFlowName, setFocusFlowName,
    putFlowEdit, saveFlow, markNavigation, applyScreen,
  } = props;
  return (<>
{screen === "flow" && !designFlow && (
          <FlowPickerPanel
            busy={busy}
            note={flowOrigin
              ? flowOrigin.rec.projectId !== null
                ? `テンプレートを選ぶと「${flowOrigin.title}」の工程にして、背景情報のページへ戻ります。白紙から作るときは、工程を足して保存してから背景情報のページの「工程」で選びます。`
                : `テンプレートを選ぶと「${flowOrigin.title}」の工程にして、録音のページへ戻ります。白紙から作るときは、工程を足して保存してから録音のページの「工程」で選びます。`
              : undefined}
            onChoose={(choice) => void chooseFlow(choice)}
          />
        )}
        {screen === "flow" && designFlow && (
          <FlowDesign
            key={designFlow.id}
            flow={designFlow}
            draft={flowDrafts[designFlow.id] ?? designFlow}
            settings={settings}
            bridge={bridge}
            dropEnabled={deletingFlow === null}
            importingSamples={flowImporting}
            onImportingChange={onFlowImportingChange}
            list={
              <FlowList
                rows={flows.map((candidate) => ({
                  id: candidate.id,
                  name: candidate.name,
                  steps: candidate.steps.length + (flowHasTranscription(candidate) ? 1 : 0),
                  unsaved: candidate.id in flowDrafts,
                }))}
                currentId={designFlow.id}
                busy={flowsBusy || flowImporting}
                onOpen={openFlow}
                onAdd={(choice) => void addFlow(choice)}
                onDuplicate={(flowId) => void duplicateFlowOf(flowId)}
                onRename={renameFlow}
                onDelete={(flowId) => void askDeleteFlow(flowId)}
              />
            }
            focusName={focusFlowName}
            onNameFocused={() => setFocusFlowName(false)}
            onChange={(next) => putFlowEdit(designFlow.id, next)}
            onSave={saveFlow}
            onOpenSettings={() => {
              markNavigation();
              applyScreen("settings");
            }}
          />
        )}
  </>);
}
