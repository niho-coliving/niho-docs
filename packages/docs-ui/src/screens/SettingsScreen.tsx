"use client";

import { type About } from "@niho/docs-core";
import { CloudSettings } from "../components/CloudSettings";
import { type Screen } from "../components/Rail";
import { Settings } from "../components/Settings";
import type { DocsAccount as NihoAccount } from "../host/DocsAccount";
import type { ProjectEntry } from "../host/DocsHost";
import { type Bridge } from "../lib/bridge";
import type { CloudController } from "../lib/cloud";
import { type OpenProject } from "../lib/project-view";
import { type ActiveRun } from "../lib/run-state";
import { type AppSettings } from "../lib/settings";
import { type ChatController } from "../lib/use-chat";
import type { GoogleDocsController } from "../lib/use-google-docs";
import { type ToastAction } from "./workspace-model";

type Props = {
  screen: Screen;
  bridge: Bridge;
  account: NihoAccount;
  accountShown: boolean;
  googleDocs: GoogleDocsController;
  settings: AppSettings;
  docsRoot: string;
  activeRun: ActiveRun | null;
  chat: ChatController;
  changingRoot: boolean;
  about: About;
  aboutLoad: number;
  saveAbout: (next: About) => Promise<void>;
  reportAboutState: (state: { dirty: boolean; saving: boolean; }) => void;
  discardAboutRef: React.MutableRefObject<() => void>;
  flushAboutRef: React.MutableRefObject<() => Promise<boolean>>;
  changeSettings: (next: AppSettings) => void;
  changeExecution: (continuation: AppSettings["personalExecution"]["continuation"]) => void;
  accountExecution: {
    phase: "local" | "loading" | "ready" | "error";
    problem: string | null;
    /** 選んだ実行先を、保存の前の前提を満たさず受け付けなかった理由（実行先は変えていない）。 */
    notice?: string | null;
  };
  changeRoot: (root: string) => Promise<void>;
  cloud: CloudController;
  folders: OpenProject[];
  refreshProjects: (shouldApply?: () => boolean) => Promise<ProjectEntry[]>;
  showToast: (text: string, action?: ToastAction) => void;
};

/** SettingsScreen の描画。保存・実行・遷移の操作は controller から受け取る。 */
export function SettingsScreen(props: Props) {
  const {
    screen, bridge, account, accountShown,
    googleDocs, settings, docsRoot, activeRun,
    chat, changingRoot, about, aboutLoad,
    saveAbout, reportAboutState, discardAboutRef, flushAboutRef,
    changeSettings, changeExecution, changeRoot, cloud, folders, accountExecution,
    refreshProjects, showToast,
  } = props;
  return (<>
{screen === "settings" && (
          <Settings
            bridge={bridge}
            account={account}
            accountAvailable={accountShown}
            googleDocs={googleDocs}
            settings={settings}
            docsRoot={docsRoot}
            running={activeRun !== null || chat.sending || chat.live !== null}
            rootChangeDisabled={activeRun !== null || chat.sending || chat.live !== null || changingRoot}
            about={about}
            aboutKey={aboutLoad}
            onSaveAbout={saveAbout}
            onAboutStateChange={reportAboutState}
            onRegisterAboutDiscard={(discard) => {
              discardAboutRef.current = discard;
            }}
            onRegisterAboutFlush={(flush) => {
              flushAboutRef.current = flush;
            }}
            onChange={changeSettings}
            onChangeExecution={changeExecution}
            executionScope={cloud.active ? "account" : "local"}
            executionProblem={cloud.active ? accountExecution.problem : null}
            executionNotice={cloud.active ? accountExecution.notice ?? null : null}
            executionBusy={cloud.active && accountExecution.phase === "loading"}
            onChangeRoot={(root) => void changeRoot(root)}
            cloudSettings={
              <CloudSettings
                bridge={bridge}
                cloud={cloud}
                running={activeRun !== null || chat.sending || chat.live !== null}
                projectName={(projectId) => folders.find((folder) => folder.id === projectId)?.project.name ?? null}
                onProjectsChanged={() => {
                  void refreshProjects().catch(() => undefined);
                  cloud.refreshRemote();
                }}
                onNotice={showToast}
              />
            }
          />
        )}
  </>);
}
