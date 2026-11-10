import type { PluginDescriptor, ParamValues } from "../plugins/params";
import { sanitizeParams } from "../plugins/params";
import { smooth } from "../plugins/audioParam";

/**
 * Effect contract. Every effect (built-in now; WASM/native plugins later) exposes an input node and
 * an output node, so the chain can wire any mix of them together without knowing what's inside.
 */
export interface Effect {
  readonly pluginId: string;
  readonly input: AudioNode;
  readonly output: AudioNode;
  /** Live parameter update. Never recreates the effect, so dragging a knob can't interrupt audio. */
  setParams(data: Record<string, unknown>): void;
  setBypassed(bypassed: boolean): void;
  dispose(): void;
}

/**
 * Shared plumbing:
 *
 *   input ─┬─ bypassPath ───────────────────────┬─> output
 *          └─ fxIn ── [subclass graph] ── fxOut ── wetGate ┘
 *
 * Bypass crossfades between the two paths (no click, no graph rewiring). Subclasses build their graph
 * between `fxIn` and `fxOut`, then call `init()`.
 */
export abstract class BaseEffect implements Effect {
  abstract readonly descriptor: PluginDescriptor;
  readonly input: GainNode;
  readonly output: GainNode;
  protected fxIn: GainNode;
  protected fxOut: GainNode;
  private bypassPath: GainNode;
  private wetGate: GainNode;
  private nodes: AudioNode[] = [];
  /** False until init() finishes, so the very first parameter values are set instantly rather than ramped from zero */
  private ready = false;
  private bypassed = false;

  constructor(protected ctx: AudioContext) {
    this.input = this.track(ctx.createGain());
    this.output = this.track(ctx.createGain());
    this.fxIn = this.track(ctx.createGain());
    this.fxOut = this.track(ctx.createGain());
    this.bypassPath = this.track(ctx.createGain());
    this.wetGate = this.track(ctx.createGain());
    this.bypassPath.gain.value = 0;
    this.input.connect(this.bypassPath);
    this.bypassPath.connect(this.output);
    this.input.connect(this.fxIn);
    this.fxOut.connect(this.wetGate);
    this.wetGate.connect(this.output);
  }

  get pluginId() {
    return this.descriptor.pluginId;
  }

  /** Register a node so dispose() can disconnect it */
  protected track<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  /** Subclass hook: apply sanitized values to its nodes using `this.set()` */
  protected abstract apply(values: ParamValues): void;

  protected init(data: Record<string, unknown>) {
    this.apply(sanitizeParams(this.descriptor.params, data));
    this.ready = true;
  }

  /** Set an AudioParam instantly during construction, smoothly afterwards */
  protected set(param: AudioParam, value: number) {
    if (this.ready) smooth(this.ctx, param, value);
    else param.value = value;
  }

  setParams(data: Record<string, unknown>) {
    this.apply(sanitizeParams(this.descriptor.params, data));
  }

  setBypassed(bypassed: boolean) {
    if (bypassed === this.bypassed) return;
    this.bypassed = bypassed;
    smooth(this.ctx, this.bypassPath.gain, bypassed ? 1 : 0);
    smooth(this.ctx, this.wetGate.gain, bypassed ? 0 : 1);
  }

  dispose() {
    for (const node of this.nodes) {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }
}
