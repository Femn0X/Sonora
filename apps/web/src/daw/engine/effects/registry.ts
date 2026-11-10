import type { EffectInsert } from "@sonora/schema";
import type { PluginDescriptor } from "../plugins/params";
import { defaultParams } from "../plugins/params";
import type { Effect } from "./types";
import { Eq, EQ_DESCRIPTOR } from "./eq";
import { Compressor, COMPRESSOR_DESCRIPTOR } from "./compressor";
import { Delay, DELAY_DESCRIPTOR } from "./delay";
import { Reverb, REVERB_DESCRIPTOR } from "./reverb";
import { Distortion, DISTORTION_DESCRIPTOR } from "./distortion";

/**
 * Effect catalog: pluginId -> descriptor + factory. Same seam as the instrument registry: a future
 * WASM/native effect registers here and immediately gets storage, undo, sanitizing and a generic UI.
 * Unknown ids return null; the chain passes audio straight through and the insert (with its preset
 * data) is preserved in the project untouched.
 */

export interface EffectDefinition {
  descriptor: PluginDescriptor;
  create(ctx: AudioContext, presetData: Record<string, unknown>): Effect;
}

export const EFFECT_CATALOG: EffectDefinition[] = [
  { descriptor: EQ_DESCRIPTOR, create: (c, d) => new Eq(c, d) },
  { descriptor: COMPRESSOR_DESCRIPTOR, create: (c, d) => new Compressor(c, d) },
  { descriptor: DELAY_DESCRIPTOR, create: (c, d) => new Delay(c, d) },
  { descriptor: REVERB_DESCRIPTOR, create: (c, d) => new Reverb(c, d) },
  { descriptor: DISTORTION_DESCRIPTOR, create: (c, d) => new Distortion(c, d) },
];

const byId = new Map(EFFECT_CATALOG.map((e) => [e.descriptor.pluginId, e]));

export function getEffectDefinition(pluginId: string): EffectDefinition | undefined {
  return byId.get(pluginId);
}

export function createEffect(ctx: AudioContext, pluginId: string, presetData: Record<string, unknown>): Effect | null {
  return byId.get(pluginId)?.create(ctx, presetData) ?? null;
}

/** A fresh insert with factory defaults, ready to drop on a strip or the master. */
export function makeInsert(id: string, pluginId: string): EffectInsert | null {
  const def = byId.get(pluginId);
  if (!def) return null;
  return {
    id,
    pluginId,
    pluginType: "builtin",
    isBuiltIn: true,
    presetData: { ...defaultParams(def.descriptor.params) },
    bypassed: false,
    displayName: def.descriptor.displayName,
  };
}
