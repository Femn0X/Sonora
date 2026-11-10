"use client";

import { useEffect, useRef } from "react";
import { useProjectStore } from "../../state/projectStore";

/**
 * A range input whose whole drag is ONE undo step.
 *
 * The first mouse/touch-down opens a store gesture; it closes on release. The release listener is
 * attached to `window`, so letting go outside the slider (very common while dragging a knob) still
 * closes the gesture. Keyboard changes aren't a drag, so each key press is its own undo step.
 * Double-click resets to `defaultValue`.
 */

interface Props {
  value: number;
  min: number;
  max: number;
  step?: number | "any";
  defaultValue?: number;
  label: string;
  onChange: (value: number) => void;
  style?: React.CSSProperties;
}

export function GestureSlider({ value, min, max, step = "any", defaultValue, label, onChange, style }: Props) {
  const active = useRef(false);

  const end = () => {
    if (!active.current) return;
    active.current = false;
    window.removeEventListener("mouseup", end);
    window.removeEventListener("touchend", end);
    window.removeEventListener("touchcancel", end);
    useProjectStore.getState().endGesture();
  };

  const begin = () => {
    if (active.current) return;
    active.current = true;
    useProjectStore.getState().beginGesture();
    window.addEventListener("mouseup", end);
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
  };

  // If the slider unmounts mid-drag (e.g. its effect is removed), never leave a gesture open.
  useEffect(() => end, []);

  return (
    <input
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      onMouseDown={begin}
      onTouchStart={begin}
      onChange={(e) => onChange(Number(e.target.value))}
      onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
      style={{ width: "100%", ...style }}
    />
  );
}
