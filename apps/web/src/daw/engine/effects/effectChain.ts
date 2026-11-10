import type { EffectInsert } from "@sonora/schema";
import { createEffect } from "./registry";
import type { Effect } from "./types";

/**
 * An ordered chain of effects between two fixed nodes:
 *
 *   input ─> effect1 ─> effect2 ─> … ─> output          (empty chain: input ─> output)
 *
 * `sync()` takes the project's insert list and makes the live graph match it, doing the least work
 * possible. This runs on every manifest edit (including every knob-drag tick), so:
 *   - a parameter change calls effect.setParams() on the existing effect (no rebuild, no rewiring),
 *   - a bypass change is a smooth crossfade inside the effect,
 *   - only add / remove / reorder rewires the graph.
 * Inserts whose plugin isn't available are skipped (audio passes through) but stay in the project.
 */

interface LiveEffect {
  pluginId: string;
  effect: Effect;
  presetSignature: string;
}

export class EffectChain {
  private live = new Map<string, LiveEffect>();
  private order: string[] = [];
  private warned = new Set<string>();

  constructor(
    private context: AudioContext,
    private input: AudioNode,
    private output: AudioNode,
  ) {
    input.connect(output);
  }

  sync(inserts: EffectInsert[]) {
    let rewire = false;
    const wanted = new Set(inserts.map((i) => i.id));

    for (const [id, live] of this.live) {
      if (!wanted.has(id)) {
        live.effect.dispose();
        this.live.delete(id);
        rewire = true;
      }
    }

    for (const insert of inserts) {
      let live = this.live.get(insert.id);
      if (live && live.pluginId !== insert.pluginId) {
        live.effect.dispose();
        this.live.delete(insert.id);
        live = undefined;
        rewire = true;
      }

      const signature = JSON.stringify(insert.presetData);
      if (!live) {
        const effect = createEffect(this.context, insert.pluginId, insert.presetData);
        if (!effect) {
          if (!this.warned.has(insert.id)) {
            this.warned.add(insert.id);
            console.warn(`[engine] Effect "${insert.pluginId}" is not available; it is skipped (its settings are kept in the project).`);
          }
          continue;
        }
        effect.setBypassed(insert.bypassed);
        this.live.set(insert.id, { pluginId: insert.pluginId, effect, presetSignature: signature });
        rewire = true;
      } else {
        if (signature !== live.presetSignature) {
          live.effect.setParams(insert.presetData);
          live.presetSignature = signature;
        }
        live.effect.setBypassed(insert.bypassed);
      }
    }

    const order = inserts.filter((i) => this.live.has(i.id)).map((i) => i.id);
    if (rewire || order.length !== this.order.length || order.some((id, i) => id !== this.order[i])) {
      this.wire(order);
    }
  }

  /** All connections of `input` and of every effect output belong to this chain, so a blanket disconnect is safe. */
  private wire(order: string[]) {
    this.input.disconnect();
    for (const live of this.live.values()) live.effect.output.disconnect();

    let previous: AudioNode = this.input;
    for (const id of order) {
      const effect = this.live.get(id)!.effect;
      previous.connect(effect.input);
      previous = effect.output;
    }
    previous.connect(this.output);
    this.order = order;
  }

  get size() {
    return this.live.size;
  }

  /** Test/diagnostic hook: the live effect for an insert id */
  get(id: string): Effect | undefined {
    return this.live.get(id)?.effect;
  }

  dispose() {
    for (const live of this.live.values()) live.effect.dispose();
    this.live.clear();
    this.order = [];
    try {
      this.input.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}
