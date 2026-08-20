"use client";

import { useEffect } from "react";

/**
 * Run `onEscape` while `active`. Every overlay in the app closes on Escape, and
 * each one needs the listener bound only while it is open, or a closed panel
 * still swallows the key.
 */
export function useEscapeKey(active: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onEscape]);
}
