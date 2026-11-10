import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createBlankManifest } from "@sonora/schema";

const SRC = "../src/daw";
const { useProjectStore } = await import(`${SRC}/state/projectStore`);
const { ExportButton } = await import(`${SRC}/components/ExportButton`);
const { TRACK_TEMPLATES } = await import(`${SRC}/engine/instruments/registry`);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement;
const downloads: { name: string; href: string }[] = [];
const revoked: string[] = [];

beforeEach(() => {
  useProjectStore.getState().loadManifest(createBlankManifest({ projectId: "p", title: "My Song!", authorId: "u" }));
  downloads.length = 0; revoked.length = 0;
  (URL as any).createObjectURL = vi.fn(() => "blob:fake-url");
  (URL as any).revokeObjectURL = vi.fn((u: string) => revoked.push(u));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloads.push({ name: this.download, href: this.href }); });
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

function mount(render?: any) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<ExportButton render={render} />));
}
const button = () => host.querySelector("button") as HTMLButtonElement;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("ExportButton", () => {
  it("renders the project and downloads it under a safe filename, then releases the blob URL", async () => {
    vi.useFakeTimers();
    const render = vi.fn(async () => new Blob(["RIFF"], { type: "audio/wav" }));
    mount(render);
    await act(async () => { button().click(); });
    await flush();
    expect(render).toHaveBeenCalledTimes(1);
    expect(downloads).toEqual([{ name: "my-song.wav", href: expect.stringContaining("blob:") }]);
    act(() => { vi.advanceTimersByTime(10_001); });
    expect(revoked).toEqual(["blob:fake-url"]);
  });

  it("shows progress and ignores extra clicks while rendering", async () => {
    let finish!: (b: Blob) => void;
    const render = vi.fn(() => new Promise<Blob>((r) => { finish = r; }));
    mount(render);
    await act(async () => { button().click(); });
    expect(button().textContent).toBe("Rendering…");
    expect(button().disabled).toBe(true);
    await act(async () => { button().click(); button().click(); });
    expect(render).toHaveBeenCalledTimes(1);
    await act(async () => { finish(new Blob(["x"])); });
    await flush();
    expect(button().textContent).toContain("Export WAV");
    expect(button().disabled).toBe(false);
    expect(downloads).toHaveLength(1);
  });

  it("exports a snapshot: edits made while rendering don't change what is rendered", async () => {
    let seen: any;
    let finish!: (b: Blob) => void;
    mount((m: any) => { seen = m; return new Promise<Blob>((r) => { finish = r; }); });
    await act(async () => { button().click(); });
    act(() => useProjectStore.getState().setTempo(77));
    expect(seen.bpm).toBe(120);
    await act(async () => { finish(new Blob(["x"])); });
  });

  it("shows the error inline, re-enables the button, and clears the error on a successful retry", async () => {
    let fail = true;
    mount(async () => { if (fail) throw new Error("Nothing to export yet: add a clip with some notes first."); return new Blob(["ok"]); });
    await act(async () => { button().click(); });
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Nothing to export yet");
    expect(button().disabled).toBe(false);
    expect(downloads).toHaveLength(0);
    fail = false;
    await act(async () => { button().click(); });
    await flush();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(downloads).toHaveLength(1);
  });

  it("non-Error rejections still produce a readable message", async () => {
    mount(async () => { throw "weird"; });
    await act(async () => { button().click(); });
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Export failed.");
  });

  it("the real exporter explains an empty project (no audio system needed)", async () => {
    mount(); // default renderer = bounceToWavBlob
    await act(async () => { button().click(); });
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/add a clip/i);
  });

  it("unmounting mid-render is safe (no state update on an unmounted component)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let finish!: (b: Blob) => void;
    mount(() => new Promise<Blob>((r) => { finish = r; }));
    await act(async () => { button().click(); });
    act(() => root.unmount());
    await act(async () => { finish(new Blob(["x"])); });
    expect(err).not.toHaveBeenCalled();
  });

  it("is disabled when there's no project loaded", () => {
    useProjectStore.setState({ manifest: null });
    mount(async () => new Blob(["x"]));
    expect(button().disabled).toBe(true);
  });
});
