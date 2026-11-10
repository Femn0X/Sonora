"use client";

import type { ParamDescriptor, PluginDescriptor } from "../../engine/plugins/params";
import { formatParam, normToValue, valueToNorm } from "../../engine/plugins/params";
import { GestureSlider } from "./GestureSlider";

/**
 * Generic plugin editor: renders ANY plugin from its parameter descriptors (built-in instruments and
 * effects today; third-party/WASM plugins later, with no new UI code). Values come from the project's
 * `presetData`, and every change flows through the command layer, so it's undoable.
 */

const SLIDER_RESOLUTION = 1000;

interface ControlProps {
  param: ParamDescriptor;
  value: number | string | undefined;
  onChange: (value: number | string) => void;
}

export function ParamControl({ param, value, onChange }: ControlProps) {
  const row: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 130 };
  const labelStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", fontSize: 11, color: "#9a9a9a" };

  if (param.kind === "string") {
    if (param.hidden) return null;
    return (
      <div style={row}>
        <span style={labelStyle}>{param.label}</span>
        <span style={{ color: "#cfcfcf", fontSize: 12 }}>{typeof value === "string" && value ? value : "(none)"}</span>
      </div>
    );
  }

  if (param.kind === "enum") {
    return (
      <label style={row}>
        <span style={labelStyle}>{param.label}</span>
        <select
          aria-label={param.label}
          value={typeof value === "string" ? value : param.default}
          onChange={(e) => onChange(e.target.value)}
          style={{ background: "#1e1e1e", color: "#eee", border: "1px solid #333", borderRadius: 4, padding: "2px 4px" }}
        >
          {param.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
    );
  }

  const current = typeof value === "number" ? value : param.default;
  return (
    <div style={row}>
      <span style={labelStyle}>
        <span>{param.label}</span>
        <span style={{ color: "#cfcfcf" }}>{formatParam(param, current)}</span>
      </span>
      <GestureSlider
        label={param.label}
        min={0}
        max={SLIDER_RESOLUTION}
        step={1}
        value={Math.round(valueToNorm(param, current) * SLIDER_RESOLUTION)}
        defaultValue={Math.round(valueToNorm(param, param.default) * SLIDER_RESOLUTION)}
        onChange={(n) => onChange(normToValue(param, n / SLIDER_RESOLUTION))}
      />
    </div>
  );
}

export function PluginEditor({
  descriptor,
  values,
  onChange,
}: {
  descriptor: PluginDescriptor;
  values: Record<string, unknown>;
  onChange: (key: string, value: number | string) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 18px", padding: 10 }}>
      {descriptor.params.map((p) => (
        <ParamControl key={p.key} param={p} value={values[p.key] as number | string | undefined} onChange={(v) => onChange(p.key, v)} />
      ))}
    </div>
  );
}
