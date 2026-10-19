import type { ReactNode } from "react";
import { DesktopShell as SharedDesktopShell } from "niho-docs-ui/components/WindowTitlebar";
import icon from "../../src-tauri/icons/128x128.png";
export { useTitlebarActionsHost, useTitlebarRailHost, useTitlebarHome } from "niho-docs-ui/components/WindowTitlebar";
export function DesktopShell(props: { children: ReactNode }) {
  return <SharedDesktopShell icon={icon}>{props.children}</SharedDesktopShell>;
}
