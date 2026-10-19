import { useState } from "react";
import { errorMessage, type Bridge } from "../lib/bridge";
import type { CloudController } from "../lib/cloud";
import "../styles/cloud.css";

/** 最初のログイン後、本文を送る前に本人がユーザー単位の保存先を選ぶ。 */
export function StorageChoice({ bridge, cloud }: { bridge: Bridge; cloud: CloudController }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (mode: "CLOUD" | "LOCAL") => {
    setBusy(true);
    setError(null);
    try {
      cloud.putState(await bridge.cloudStorageSelect(mode));
    } catch (failure) {
      setError(errorMessage(failure, "保存先を確認できませんでした。もう一度お試しください。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app solo">
      <section className="empty storage-choice" aria-labelledby="storage-choice-title">
        <h1 id="storage-choice-title">ページと音声の保存先を選ぶ</h1>
        <p className="msg">選ぶまでページや音声は NIHO に送りません。後から設定で変更できます。</p>
        <div className="storage-choice-options">
          <div className="storage-choice-option">
            <h2>NIHO クラウド</h2>
            <p>この Mac のページと音声を同期し、ほかの Mac やスマホからも開けます。クラウドの音声は 30 日で消え、この Mac には残ります。</p>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void choose("CLOUD")}>NIHO クラウドを選ぶ</button>
          </div>
          <div className="storage-choice-option">
            <h2>この Mac だけ</h2>
            <p>ページと音声をこの Mac に保存します。Web やほかの Mac では開けません。</p>
            <button type="button" className="btn outline" disabled={busy} onClick={() => void choose("LOCAL")}>この Mac だけを選ぶ</button>
          </div>
        </div>
        <p className="help">ログイン情報などの運用記録は NIHO に残ります。書き出しや AI を使うときは、選んだ内容が一時的に NIHO を通ります。</p>
        {error && <p className="err" role="alert">{error}</p>}
      </section>
    </div>
  );
}
