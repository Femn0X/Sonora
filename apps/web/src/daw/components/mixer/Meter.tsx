"use client";

import { useEffect, useRef } from "react";

/**
 * Level meter. Polls on requestAnimationFrame and writes the bar's height straight to the DOM, so
 * metering never causes a React re-render. dB-scaled (-60..0) with a smooth fall-off.
 */
export function Meter({ read, height = 90 }: { read: () => number; height?: number }) {
  const bar = useRef<HTMLDivElement>(null);
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    if (typeof requestAnimationFrame !== "function") return;
    let raf = 0;
    let level = 0;
    const frame = () => {
      const peak = readRef.current();
      level = Math.max(peak, level * 0.9);
      const db = level > 0.0005 ? 20 * Math.log10(level) : -60;
      const pct = Math.max(0, Math.min(1, (db + 60) / 60)) * 100;
      if (bar.current) {
        bar.current.style.height = `${pct}%`;
        bar.current.style.background = db > -3 ? "#e0553e" : db > -12 ? "#e0b13e" : "#3ec78a";
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div role="meter" aria-label="Level" style={{ width: 8, height, background: "#141414", borderRadius: 2, display: "flex", alignItems: "flex-end", overflow: "hidden" }}>
      <div ref={bar} style={{ width: "100%", height: 0, background: "#3ec78a" }} />
    </div>
  );
}
