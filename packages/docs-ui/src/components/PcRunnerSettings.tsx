"use client";

import { useEffect, useState } from "react";
import { FeatureToggleSwitch } from "niho-ui/components/feature-toggle-switch";
import type { Bridge } from "../lib/bridge";
import {
  PC_RUNNER_HELP,
  PC_RUNNER_SIGNED_OUT,
  PC_RUNNER_TITLE,
  pcRunnerErrorText,
  pcRunnerStatusLine,
  type PcRunnerStatus,
} from "../lib/pc-runner";

/**
 * 設定の「この Mac で続きを受ける」（#18804 S2・design-guide-docs.md §4.1）。ON/OFF と、ON の間の状態の 1 行（メニューバーと
 * 同じ文）。NIHO アカウントでログインしていなければ ON にできない（ON のままログアウトしたら OFF にはできる）。失敗はスイッチの
 * 近くに 1 行で出す（トーストにしない・§5）。
 */
export function PcRunnerSettings(props: { bridge: Bridge; signedIn: boolean }) {
  const { bridge, signedIn } = props;
  /** null は読み込み中。 */
  const [status, setStatus] = useState<PcRunnerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    setStatus(null);
    // 先に購読してから今の状態を読む（読むまでのあいだの変化を取りこぼさない）
    bridge
      .onPcRunnerState((next) => {
        if (active) setStatus(next);
      })
      .then(
        (stop) => {
          if (active) unlisten = stop;
          else stop();
        },
        () => undefined,
      )
      .then(() => bridge.pcRunnerStatus())
      .then(
        (current) => {
          if (active) setStatus((previous) => previous ?? current);
        },
        () => {
          if (active) setStatus((previous) => previous ?? { enabled: false, state: "off", label: null, runnerId: null });
        },
      );
    return () => {
      active = false;
      unlisten?.();
    };
  }, [bridge]);

  const enabled = status?.enabled ?? false;
  const locked = busy || status === null || (!enabled && !signedIn);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await bridge.setPcRunnerEnabled(next));
    } catch (failure) {
      setError(pcRunnerErrorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card pc-runner">
      <div className="ch">
        <h2>{PC_RUNNER_TITLE}</h2>
        <div className="sp" />
        <FeatureToggleSwitch
          checked={enabled}
          disabled={locked}
          size="sm"
          onChange={(next) => void toggle(next)}
          ariaLabel={PC_RUNNER_TITLE}
          className="docs-feature-toggle-switch"
          thumbClassName="docs-feature-toggle-switch__thumb"
        />
      </div>
      <div className="cb">
        <p className="help">{PC_RUNNER_HELP}</p>
        {!enabled && !signedIn && <p className="help">{PC_RUNNER_SIGNED_OUT}</p>}
        {enabled && status && (
          <p className="help" role="status">
            {pcRunnerStatusLine(status)}
          </p>
        )}
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
