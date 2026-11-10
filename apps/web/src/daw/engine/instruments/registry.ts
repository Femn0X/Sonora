import type { InstrumentRef } from "@sonora/schema";
import type { Instrument } from "./types";
import { SonoraSynth, SYNTH_PRESETS, SYNTH_DESCRIPTOR } from "./synth";
import { SonoraDrumKit, DRUM_PRESETS, DRUM_DESCRIPTOR } from "./drumKit";
import type { PluginDescriptor } from "../plugins/params";
import { Sampler, SAMPLER_DESCRIPTOR } from "./sampler";
import { Osc3, OSC3_DESCRIPTOR, OSC3_PRESETS } from "./osc3";
import { FmKeys, FM_DESCRIPTOR, FM_PRESETS } from "./fm";
import { Organ, ORGAN_DESCRIPTOR, ORGAN_PRESETS } from "./organ";
import { Bass808, BASS808_DESCRIPTOR, BASS808_PRESETS } from "./bass808";
import { Pluck, PLUCK_DESCRIPTOR, PLUCK_PRESETS } from "./pluck";
import { Vox, VOX_DESCRIPTOR, VOX_PRESETS } from "./vox";
import { defaultParams } from "../plugins/params";

/**
 * Plugin registry: pluginId -> factory. This is the seam that Phase 2/3
 * plugins (WASM instruments, native bridge) register into. Unknown ids
 * return null, and the engine treats that as a "missing instrument" — the
 * track stays in the project and its preset data is preserved untouched
 * (ARCHITECTURE §7).
 */

export const DRUM_PLUGIN_ID = "sonora.drums";
export const SYNTH_PLUGIN_ID = "sonora.synth";

export function createInstrument(context: AudioContext, pluginId: string, presetData: Record<string, unknown>): Instrument | null {
  switch (pluginId) {
    case SYNTH_PLUGIN_ID:
      return new SonoraSynth(context, presetData);
    case DRUM_PLUGIN_ID:
      return new SonoraDrumKit(context, presetData);
    case "sonora.sampler":
      return new Sampler(context, presetData);
    case "sonora.osc3":
      return new Osc3(context, presetData);
    case "sonora.fm":
      return new FmKeys(context, presetData);
    case "sonora.organ":
      return new Organ(context, presetData);
    case "sonora.bass808":
      return new Bass808(context, presetData);
    case "sonora.pluck":
      return new Pluck(context, presetData);
    case "sonora.vox":
      return new Vox(context, presetData);
    default:
      return null;
  }
}

export interface TrackTemplate {
  key: string;
  /** Heading in the "+ Track" menu */
  group?: string;
  label: string;
  trackName: string;
  color: string;
  pluginId: string;
  presetData: Record<string, unknown>;
}

/** What the "+ Track" menu offers. */
export const TRACK_TEMPLATES: TrackTemplate[] = [
  { key: "drums", label: "Drum Kit", trackName: "Drums", color: "#e08a3e", pluginId: DRUM_PLUGIN_ID, presetData: { ...DRUM_PRESETS.punchy.preset } },
  { key: "drums-808", label: "Deep 808 Kit", trackName: "808 Drums", color: "#d1563c", pluginId: DRUM_PLUGIN_ID, presetData: { ...DRUM_PRESETS.deep.preset } },
  { key: "bass", label: "Synth Bass", trackName: "Bass", color: "#5b8def", pluginId: SYNTH_PLUGIN_ID, presetData: { ...SYNTH_PRESETS.bass.preset } },
  { key: "lead", label: "Synth Lead", trackName: "Lead", color: "#b56bf2", pluginId: SYNTH_PLUGIN_ID, presetData: { ...SYNTH_PRESETS.lead.preset } },
  { key: "pad", label: "Synth Pad", trackName: "Keys", color: "#3ec7c7", pluginId: SYNTH_PLUGIN_ID, presetData: { ...SYNTH_PRESETS.pad.preset } },
  { key: "pluck", label: "Synth Pluck", trackName: "Pluck", color: "#e0c43e", pluginId: SYNTH_PLUGIN_ID, presetData: { ...SYNTH_PRESETS.pluck.preset } },
];

/** Turn a plugin's preset table into menu entries (one per preset). */
function presetTemplates(
  group: string, keyPrefix: string, pluginId: string, color: string,
  descriptor: { params: Parameters<typeof defaultParams>[0] },
  presets: Record<string, { name: string; preset: Record<string, unknown> }>,
): TrackTemplate[] {
  return Object.entries(presets).map(([key, { name, preset }]) => ({
    key: `${keyPrefix}-${key}`,
    group,
    label: name,
    trackName: name,
    color,
    pluginId,
    presetData: { ...defaultParams(descriptor.params), ...preset },
  }));
}

TRACK_TEMPLATES.push(
  {
    key: "sampler-voice", group: "Sampler", label: "Voice / Sample (load or record)", trackName: "Sampler", color: "#f0a0c0",
    pluginId: SAMPLER_DESCRIPTOR.pluginId, presetData: { ...defaultParams(SAMPLER_DESCRIPTOR.params) },
  },
  ...presetTemplates("3xOSC", "osc3", OSC3_DESCRIPTOR.pluginId, "#e05b8d", OSC3_DESCRIPTOR, OSC3_PRESETS),
  ...presetTemplates("FM Keys", "fm", FM_DESCRIPTOR.pluginId, "#4fb6e0", FM_DESCRIPTOR, FM_PRESETS),
  ...presetTemplates("Organ", "organ", ORGAN_DESCRIPTOR.pluginId, "#c98a4b", ORGAN_DESCRIPTOR, ORGAN_PRESETS),
  ...presetTemplates("808 Bass", "bass808", BASS808_DESCRIPTOR.pluginId, "#d1563c", BASS808_DESCRIPTOR, BASS808_PRESETS),
  ...presetTemplates("Pluck", "pluck", PLUCK_DESCRIPTOR.pluginId, "#8fd14f", PLUCK_DESCRIPTOR, PLUCK_PRESETS),
  ...presetTemplates("Vox", "vox", VOX_DESCRIPTOR.pluginId, "#e0c0f0", VOX_DESCRIPTOR, VOX_PRESETS),
);

export function makeInstrumentRef(id: string, template: TrackTemplate): InstrumentRef {
  return {
    id,
    pluginId: template.pluginId,
    pluginType: "builtin",
    version: "1.0",
    isBuiltIn: true,
    presetData: structuredClone(template.presetData),
    displayName: template.label,
  };
}

export function isDrumInstrument(ref: InstrumentRef | undefined): boolean {
  return ref?.pluginId === DRUM_PLUGIN_ID;
}

/** Parameter descriptors for instruments that have an editor UI (the sampler has none yet). */
export const INSTRUMENT_DESCRIPTORS = new Map<string, PluginDescriptor>([
  [SYNTH_PLUGIN_ID, SYNTH_DESCRIPTOR],
  [DRUM_PLUGIN_ID, DRUM_DESCRIPTOR],
  [OSC3_DESCRIPTOR.pluginId, OSC3_DESCRIPTOR],
  [FM_DESCRIPTOR.pluginId, FM_DESCRIPTOR],
  [ORGAN_DESCRIPTOR.pluginId, ORGAN_DESCRIPTOR],
  [BASS808_DESCRIPTOR.pluginId, BASS808_DESCRIPTOR],
  [SAMPLER_DESCRIPTOR.pluginId, SAMPLER_DESCRIPTOR],
  [PLUCK_DESCRIPTOR.pluginId, PLUCK_DESCRIPTOR],
  [VOX_DESCRIPTOR.pluginId, VOX_DESCRIPTOR],
]);
