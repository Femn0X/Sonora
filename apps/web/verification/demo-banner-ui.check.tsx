import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
const { DemoBanner } = await import("../src/daw/components/DemoBanner");
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
const show = (loadError: string | null) => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root.render(<DemoBanner loadError={loadError} />)); };

describe("DemoBanner", () => {
  it("the genuine demo route: plain, calm message, not an alert", () => {
    show(null);
    expect(host.textContent).toContain("Demo project — not saved");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("a real project that failed to load: says WHY, is an alert, and doesn't tell you to create a project you just created", () => {
    show("Not found: projects/abc/versions/def/manifest.json. The saved data for this version is missing.");
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Couldn’t load this project");
    expect(alert.textContent).toContain("The saved data for this version is missing");
    expect(alert.textContent).toContain("nothing here is saved");
    expect(host.textContent).not.toContain("Create a project from the home page");
  });
  it("an unreachable API gets an actionable message", () => {
    show("Could not reach the API. Is it running on the expected port?");
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Is it running");
  });
});
