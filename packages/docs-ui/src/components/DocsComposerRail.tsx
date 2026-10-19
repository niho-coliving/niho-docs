"use client";

import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import { accountProfileOf, type DocsAccount } from "../host/DocsAccount";
import { useDocsComposerRailWidth } from "../lib/use-docs-composer-rail-width";

const DocsComposerRailUser = createContext("signed-out");

export function DocsComposerRailProvider({ account, children }: { account: DocsAccount; children: ReactNode }) {
  return <DocsComposerRailUser.Provider value={accountProfileOf(account.state)?.userId ?? "signed-out"}>{children}</DocsComposerRailUser.Provider>;
}

export function DocsComposerRailHandle({ rail, className, gripClassName = "docs-composer-rail-grip", controls }: {
  rail: ReturnType<typeof useDocsComposerRailWidth>;
  className: string;
  gripClassName?: string;
  controls?: string;
}) {
  return <div
    role="separator"
    tabIndex={0}
    aria-orientation="vertical"
    aria-label="AIと作るの幅を変更"
    aria-controls={controls}
    aria-description="左右キーで幅を変更、Enterで既定の幅に戻す"
    title="左右キーで幅を変更、Enterで既定の幅に戻す"
    aria-valuemin={rail.limits.min}
    aria-valuemax={rail.limits.max}
    aria-valuenow={rail.actualWidth}
    onPointerDown={rail.onPointerDown}
    onKeyDown={rail.onKeyDown}
    onDoubleClick={rail.reset}
    className={className}
  ><span aria-hidden="true" className={gripClassName} /></div>;
}

/** Mac の各ページと Web で同じ幅変更操作を使う。Mac の本文最小幅は窓と左レールを考慮する。 */
export function DocsWorkLayout({ chatOpen, children }: { chatOpen: boolean; children: ReactNode }) {
  const userId = useContext(DocsComposerRailUser);
  const rail = useDocsComposerRailWidth(userId, chatOpen, 400, 14, "clamp(300px,30vw,356px)");
  return <div
    ref={rail.gridRef}
    className={`work${chatOpen ? "" : " noai"}`}
    style={{ "--docs-composer-width": rail.widthCss } as CSSProperties}
  >
    {children}
    {chatOpen && <DocsComposerRailHandle rail={rail} className="docs-work-resize-handle" />}
  </div>;
}
