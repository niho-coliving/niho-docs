import { useNihoAccount } from "niho-desktop-account/use-niho-account";
import type { AccountTransport } from "niho-desktop-account/account-bridge";
import { DocsApp } from "niho-docs-ui/screens/DocsApp";
import type { DocsHost } from "niho-docs-ui/host/DocsHost";

/** Mac のアカウント接続だけを持ち、共通の画面を描く。 */
export function App(props: { bridge: DocsHost; accountTransport?: AccountTransport }) {
  const account = useNihoAccount({ lang: "ja", transport: props.accountTransport });
  return <DocsApp bridge={props.bridge} account={account} />;
}
