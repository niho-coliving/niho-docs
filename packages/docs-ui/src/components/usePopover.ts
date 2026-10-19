"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/** 開閉する小さなメニュー。外を押す・Esc で閉じる。 */
export function usePopover<T extends HTMLElement = HTMLDivElement>(): {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  ref: RefObject<T>;
} {
  const [open, setOpen] = useState(false);
  const ref = useRef<T>(null!);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, toggle: () => setOpen((value) => !value), ref };
}
