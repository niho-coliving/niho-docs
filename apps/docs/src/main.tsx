import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DesktopShell } from "./components/WindowTitlebar";
import { tauriBridge } from "./lib/bridge";
// token が先（web の globals.css の写しの semantic token と NIHO Sans → NIHO docs の面の別名。#18876）、部品の CSS が後
import "niho-ui/styles/tokens.css";
import "niho-docs-ui/styles/tokens.css";
import "niho-docs-ui/styles/app.css";
import "niho-docs-ui/styles/sharing.css";
import "niho-docs-ui/styles/editor.css";
import "./styles/account.css";
import "./styles/window.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <DesktopShell>
        <App bridge={tauriBridge} />
      </DesktopShell>
    </StrictMode>,
  );
}
