"use client";

import { folderName } from "@niho/docs-core";
import { leaseLabel } from "../lib/cloud";
import type { RemoteProject } from "../lib/cloud-types";
import { CloudIcon } from "./icons";
import "../styles/cloud.css";

/**
 * レールのクラウドにだけあるフォルダ（この Mac のフォルダの後ろ。淡く、雲の印と「クラウド」を添える）。押すと文書から下ろして開く
 * （音声は後ろで取得する）。別の Mac が実行中なら行の下に「〈名前〉で実行中」。
 */
export function RemoteProjectRows(props: {
  projects: readonly RemoteProject[];
  /** 開いている途中のフォルダ（その行にスピナー。ほかの行は押せない）。 */
  opening: string | null;
  onOpen: (projectId: string) => void;
}) {
  return (
    <>
      {props.projects.map((project) => {
        const name = folderName(project);
        const opening = props.opening === project.projectId;
        return (
          <div className="case remote" key={project.projectId}>
            <div className="trow">
              <span className="tw none" />
              <button
                type="button"
                className="ti case dim"
                disabled={props.opening !== null}
                aria-busy={opening || undefined}
                onClick={() => props.onOpen(project.projectId)}
              >
                <span className="t">{name}</span>
                <span className="st">
                  {opening ? (
                    <>
                      <span className="spin" aria-hidden="true" />
                      開いています
                    </>
                  ) : (
                    <>
                      <CloudIcon />
                      クラウド
                    </>
                  )}
                </span>
              </button>
            </div>
            {project.lease && !project.lease.mine && <p className="rlease">{leaseLabel(project.lease.deviceName)}</p>}
          </div>
        );
      })}
    </>
  );
}
