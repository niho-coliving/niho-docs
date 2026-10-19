import { useState } from "react";
import { errorMessage, type Bridge } from "../lib/bridge";
import type { CloudController } from "../lib/cloud";
import "../styles/cloud.css";

/** 再起動後も sealed manifest と手元の内容を照合して移行を完了するまで編集を止める。 */
export function StorageReopeningPending({ bridge, cloud }: { bridge: Bridge; cloud: CloudController }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resume = async () => {
    setBusy(true);
    setError(null);
    try {
      cloud.putState(await bridge.cloudStorageReopen());
    } catch (failure) {
      setError(errorMessage(failure, "移行を確認できませんでした。もう一度お試しください。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app solo">
      <section className="empty storage-choice" aria-labelledby="storage-reopening-title" aria-busy={busy}>
        <h1 id="storage-reopening-title">保存先の変更を再開します</h1>
        <p className="msg">この Mac の内容と移行先を照合して、保存先の変更を完了します。完了するまで文書を編集できません。</p>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void resume()}>
          {busy ? "移行を確認しています…" : "移行を完了する"}
        </button>
        {error && <p className="err" role="alert">{error}</p>}
      </section>
    </div>
  );
}
