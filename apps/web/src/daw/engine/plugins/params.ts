/**
 * Parameter descriptors — the single source of truth for what a plugin exposes.
 *
 * One descriptor list drives three things, so they can never drift apart:
 *   1. sanitizing `presetData` (it comes from untrusted, forkable project JSON),
 *   2. defaults for newly created instruments/effects,
 *   3. the generic plugin editor UI (sliders/selects with correct ranges, units, log scaling).
 *
 * This is also the seam for future plugins (ARCHITECTURE: WASM now, native bridge later): a plugin
 * only has to publish a descriptor and the host can already store, sanitize, undo and render it.
 */

export interface NumberParam {
  kind?: "number";
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
  /** Slider granularity for linear params (log params use a continuous slider) */
  step?: number;
  unit?: string;
  /** "log" for frequencies/times so the slider feels musical */
  scale?: "linear" | "log";
}

export interface EnumParam {
  kind: "enum";
  key: string;
  label: string;
  options: { value: string; label: string }[];
  default: string;
}

/** A text value such as a sample id or display name. Length-limited; `hidden` keeps it out of the generic editor. */
export interface StringParam {
  kind: "string";
  key: string;
  label: string;
  default: string;
  maxLength: number;
  hidden?: boolean;
}

export type ParamDescriptor = NumberParam | EnumParam | StringParam;

export interface PluginDescriptor {
  pluginId: string;
  displayName: string;
  category: "instrument" | "effect";
  params: ParamDescriptor[];
}

export type ParamValues = Record<string, number | string>;

export function defaultParams(params: ParamDescriptor[]): ParamValues {
  const out: ParamValues = {};
  for (const p of params) out[p.key] = p.default;
  return out;
}

/** Clamp/validate untrusted data against a descriptor list. Unknown keys are dropped; bad values fall back to defaults. */
export function sanitizeParams(params: ParamDescriptor[], data: Record<string, unknown> | undefined): ParamValues {
  const out: ParamValues = {};
  for (const p of params) {
    const raw = data?.[p.key];
    if (p.kind === "enum") {
      out[p.key] = typeof raw === "string" && p.options.some((o) => o.value === raw) ? raw : p.default;
    } else if (p.kind === "string") {
      out[p.key] = typeof raw === "string" && raw.length <= p.maxLength ? raw : p.default;
    } else {
      const n = typeof raw === "number" && Number.isFinite(raw) ? raw : p.default;
      out[p.key] = Math.max(p.min, Math.min(p.max, n));
    }
  }
  return out;
}

/** value <-> 0..1 slider position, honouring log scaling. */
export function valueToNorm(p: NumberParam, value: number): number {
  const v = Math.max(p.min, Math.min(p.max, value));
  if (p.scale === "log" && p.min > 0) return Math.log(v / p.min) / Math.log(p.max / p.min);
  return (v - p.min) / (p.max - p.min);
}

export function normToValue(p: NumberParam, norm: number): number {
  const n = Math.max(0, Math.min(1, norm));
  let v = p.scale === "log" && p.min > 0 ? p.min * Math.pow(p.max / p.min, n) : p.min + n * (p.max - p.min);
  if (p.scale !== "log" && p.step) v = Math.round((v - p.min) / p.step) * p.step + p.min;
  return Math.max(p.min, Math.min(p.max, Number(v.toPrecision(6))));
}

export function formatParam(p: ParamDescriptor, value: number | string | undefined): string {
  if (p.kind === "enum") return p.options.find((o) => o.value === value)?.label ?? String(p.default);
  if (p.kind === "string") return typeof value === "string" ? value : p.default;
  const v = typeof value === "number" ? value : p.default;
  const abs = Math.abs(v);
  const text = abs >= 1000 ? (v / 1000).toFixed(abs >= 10000 ? 1 : 2) + "k" : abs >= 100 ? v.toFixed(0) : abs >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${text}${p.unit ? " " + p.unit : ""}`;
}
