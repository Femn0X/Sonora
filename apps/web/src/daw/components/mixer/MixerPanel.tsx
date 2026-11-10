"use client";

import { useState } from "react";
import type { EffectInsert, InstrumentRef } from "@sonora/schema";
import { useProjectStore } from "../../state/projectStore";
import { MASTER_TARGET } from "../../state/commands";
import { getActiveEngine } from "../../engine/playback";
import { EFFECT_CATALOG, getEffectDefinition } from "../../engine/effects/registry";
import { INSTRUMENT_DESCRIPTORS } from "../../engine/instruments/registry";
import type { PluginDescriptor } from "../../engine/plugins/params";
import { PluginEditor } from "../plugin/PluginEditor";
import { GestureSlider } from "../plugin/GestureSlider";
import { Meter } from "./Meter";

/**
 * Mixer: one channel strip per track plus the master bus.
 *
 *   [instrument]  -> opens the instrument's parameters
 *   [inserts]     -> effect chain, top to bottom (bypass / reorder / remove / add)
 *   [pan] [fader] [M] [S] [meter]
 *
 * Clicking an instrument or insert opens its editor below the strips. Everything goes through the
 * command layer, so every change is undoable and a knob drag is one undo step.
 */

type Open = { target: string; kind: "insert" | "instrument"; id: string };

const STRIP_WIDTH = 168;

const small: React.CSSProperties = { fontSize: 11, padding: "1px 6px", background: "#262626", color: "#ddd", border: "1px solid #3a3a3a", borderRadius: 3, cursor: "pointer" };

function panLabel(pan: number) {
  if (Math.abs(pan) < 0.005) return "C";
  return `${pan < 0 ? "L" : "R"}${Math.round(Math.abs(pan) * 100)}`;
}

interface StripProps {
  target: string;
  name: string;
  color: string;
  inserts: EffectInsert[];
  volumeDb: number;
  pan?: number;
  muted?: boolean;
  soloed?: boolean;
  instrument?: InstrumentRef;
  open: Open | null;
  onOpen: (o: Open | null) => void;
  read: () => number;
}

function ChannelStrip(p: StripProps) {
  const store = useProjectStore;
  const isMaster = p.target === MASTER_TARGET;
  const isOpen = (kind: Open["kind"], id: string) => p.open?.target === p.target && p.open.kind === kind && p.open.id === id;

  return (
    <div style={{ width: STRIP_WIDTH, flex: "none", display: "flex", flexDirection: "column", gap: 6, padding: 8, background: isMaster ? "#202028" : "#1c1c1c", borderRight: "1px solid #101010" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 4, alignSelf: "stretch", background: p.color, borderRadius: 2 }} />
        <strong style={{ fontSize: 12, color: "#e5e5e5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</strong>
      </div>

      {p.instrument && (
        <button
          onClick={() => p.onOpen(isOpen("instrument", p.instrument!.id) ? null : { target: p.target, kind: "instrument", id: p.instrument!.id })}
          style={{ ...small, textAlign: "left", background: isOpen("instrument", p.instrument.id) ? "#3a4a6a" : "#262626" }}
          title="Edit instrument"
        >
          🎹 {p.instrument.displayName}
        </button>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 20 }}>
        {p.inserts.map((ins, index) => {
          const available = !!getEffectDefinition(ins.pluginId);
          return (
            <div key={ins.id} style={{ display: "flex", alignItems: "center", gap: 3, background: isOpen("insert", ins.id) ? "#3a4a6a" : "#242424", borderRadius: 3, padding: "1px 3px" }}>
              <button
                aria-label={`${ins.bypassed ? "Enable" : "Bypass"} ${ins.displayName}`}
                aria-pressed={!ins.bypassed}
                title={ins.bypassed ? "Bypassed: click to enable" : "Active: click to bypass"}
                onClick={() => store.getState().setInsertBypass(p.target, ins.id, !ins.bypassed)}
                style={{ ...small, padding: "0 5px", color: ins.bypassed ? "#666" : "#3ec78a" }}
              >
                ●
              </button>
              <button
                onClick={() => available && p.onOpen(isOpen("insert", ins.id) ? null : { target: p.target, kind: "insert", id: ins.id })}
                title={available ? "Edit effect" : "This plugin isn't available here. Its settings are kept in the project."}
                style={{ ...small, flex: 1, textAlign: "left", border: "none", background: "transparent", color: !available ? "#8a6a3a" : ins.bypassed ? "#777" : "#ddd", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {ins.displayName}
                {!available && " (unavailable)"}
              </button>
              <button aria-label={`Move ${ins.displayName} up`} disabled={index === 0} onClick={() => store.getState().moveInsert(p.target, ins.id, -1)} style={{ ...small, padding: "0 4px" }}>▲</button>
              <button aria-label={`Move ${ins.displayName} down`} disabled={index === p.inserts.length - 1} onClick={() => store.getState().moveInsert(p.target, ins.id, +1)} style={{ ...small, padding: "0 4px" }}>▼</button>
              <button aria-label={`Remove ${ins.displayName}`} onClick={() => store.getState().removeInsert(p.target, ins.id)} style={{ ...small, padding: "0 5px" }}>×</button>
            </div>
          );
        })}
        <select
          aria-label="Add effect"
          value=""
          onChange={(e) => {
            const pluginId = e.target.value;
            if (!pluginId) return;
            const id = store.getState().addInsert(p.target, pluginId);
            if (id) p.onOpen({ target: p.target, kind: "insert", id }); // open it so its knobs are right there
          }}
          style={{ ...small, width: "100%", padding: "2px 4px" }}
        >
          <option value="">+ Add effect…</option>
          {EFFECT_CATALOG.map(({ descriptor }) => (
            <option key={descriptor.pluginId} value={descriptor.pluginId}>{descriptor.displayName}</option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "stretch", marginTop: "auto" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          {!isMaster && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#888" }}>
                <span>Pan</span>
                <span>{panLabel(p.pan ?? 0)}</span>
              </div>
              <GestureSlider label={`${p.name} pan`} min={-1} max={1} step={0.01} defaultValue={0} value={p.pan ?? 0} onChange={(v) => store.getState().setTrackPan(p.target, v)} />
            </div>
          )}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#888" }}>
              <span>Volume</span>
              <span>{p.volumeDb <= -60 ? "-∞" : p.volumeDb.toFixed(1)} dB</span>
            </div>
            <GestureSlider
              label={`${p.name} volume`}
              min={-60}
              max={6}
              step={0.1}
              defaultValue={0}
              value={p.volumeDb}
              onChange={(v) => (isMaster ? store.getState().setMasterVolume(v) : store.getState().setTrackVolume(p.target, v))}
            />
          </div>
          {!isMaster && (
            <div style={{ display: "flex", gap: 4 }}>
              <button aria-label={`Mute ${p.name}`} aria-pressed={!!p.muted} onClick={() => store.getState().setTrackMute(p.target, !p.muted)} style={{ ...small, flex: 1, background: p.muted ? "#e0a03e" : "#262626", color: p.muted ? "#111" : "#ddd" }}>M</button>
              <button aria-label={`Solo ${p.name}`} aria-pressed={!!p.soloed} onClick={() => store.getState().setTrackSolo(p.target, !p.soloed)} style={{ ...small, flex: 1, background: p.soloed ? "#3ec7a0" : "#262626", color: p.soloed ? "#111" : "#ddd" }}>S</button>
            </div>
          )}
        </div>
        <Meter read={p.read} height={isMaster ? 90 : 110} />
      </div>
    </div>
  );
}

export function MixerPanel() {
  const manifest = useProjectStore((s) => s.manifest);
  const store = useProjectStore;
  const [open, setOpen] = useState<Open | null>(null);

  if (!manifest) return null;

  // Resolve what the editor should show; if the thing was removed (or undone away), the editor just closes.
  let editor: { title: string; descriptor: PluginDescriptor; values: Record<string, unknown>; onChange: (key: string, value: number | string) => void } | null = null;
  if (open) {
    const scopeName = open.target === MASTER_TARGET ? "Master" : manifest.tracks.find((t) => t.id === open.target)?.name ?? "Track";
    if (open.kind === "instrument") {
      const inst = manifest.instruments.find((i) => i.id === open.id);
      const descriptor = inst && INSTRUMENT_DESCRIPTORS.get(inst.pluginId);
      if (inst && descriptor) editor = { title: `${scopeName} › ${inst.displayName}`, descriptor, values: inst.presetData, onChange: (k, v) => store.getState().setInstrumentParam(inst.id, k, v) };
    } else {
      const list = open.target === MASTER_TARGET ? manifest.mixer.masterInserts : manifest.mixer.strips.find((s) => s.trackId === open.target)?.inserts;
      const insert = list?.find((i) => i.id === open.id);
      const def = insert && getEffectDefinition(insert.pluginId);
      if (insert && def) editor = { title: `${scopeName} › ${insert.displayName}`, descriptor: def.descriptor, values: insert.presetData, onChange: (k, v) => store.getState().setInsertParam(open.target, insert.id, k, v) };
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex" }}>
        {manifest.tracks.length === 0 && (
          <div style={{ padding: 16, color: "#777", fontSize: 13, flex: 1 }}>No tracks yet. Add one with “+ Track”, then shape its sound here. The master strip is on the right.</div>
        )}
        {manifest.tracks.map((track) => {
          const strip = manifest.mixer.strips.find((s) => s.trackId === track.id);
          return (
            <ChannelStrip
              key={track.id}
              target={track.id}
              name={track.name}
              color={track.color}
              inserts={strip?.inserts ?? []}
              volumeDb={strip?.volumeDb ?? 0}
              pan={strip?.pan ?? 0}
              muted={strip?.muted}
              soloed={strip?.soloed}
              instrument={manifest.instruments.find((i) => i.id === track.instrumentId)}
              open={open}
              onOpen={setOpen}
              read={() => getActiveEngine()?.getPeak(track.id) ?? 0}
            />
          );
        })}
        <div style={{ flex: 1 }} />
        <ChannelStrip
          target={MASTER_TARGET}
          name="Master"
          color="#8a8aff"
          inserts={manifest.mixer.masterInserts}
          volumeDb={manifest.mixer.masterVolumeDb}
          open={open}
          onOpen={setOpen}
          read={() => getActiveEngine()?.getMasterPeak() ?? 0}
        />
      </div>

      {editor && (
        <div style={{ borderTop: "1px solid #2a2a2a", background: "#181818", maxHeight: "45%", overflow: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", padding: "4px 10px", borderBottom: "1px solid #242424" }}>
            <strong style={{ fontSize: 12, color: "#ddd" }}>{editor.title}</strong>
            <span style={{ marginLeft: 10, fontSize: 11, color: "#666" }}>double-click a slider to reset it</span>
            <div style={{ flex: 1 }} />
            <button onClick={() => setOpen(null)} style={small}>✕ Close</button>
          </div>
          <PluginEditor descriptor={editor.descriptor} values={editor.values} onChange={editor.onChange} />
        </div>
      )}
    </div>
  );
}
