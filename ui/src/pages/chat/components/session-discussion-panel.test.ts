/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { mount, resetDiscussionPanelTestState } from "./session-discussion-panel.test-support.ts";

afterEach(resetDiscussionPanelTestState);

function setTheme(mode: "light" | "dark", surface: string) {
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.style.setProperty("--bg", surface);
}

function mountOpen(embedUrl: string, openUrl?: string, presentation?: "desktop") {
  return mount({
    presentation,
    loadInfo: vi.fn().mockResolvedValue({ state: "open", embedUrl, openUrl }),
    openDiscussion: vi.fn(),
  });
}

async function findFrame(panel: HTMLElement) {
  return vi.waitFor(() => {
    const frame = panel.querySelector<HTMLIFrameElement>("iframe");
    expect(frame).not.toBeNull();
    return frame!;
  });
}

it("preserves signed provider URLs even when their routes resemble ClickClack", async () => {
  const signedUrl =
    "https://discussion.example/embed/channel/a/b?signature=abc%2B123&expires=1785200000#thread";
  setTheme("light", "#faf9f7");
  const frame = await findFrame(mountOpen(signedUrl));
  expect(frame.src).toBe(signedUrl);
  expect(frame.getAttribute("sandbox")).toBe(
    "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
  );
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

  frame.dispatchEvent(new Event("load"));

  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "openclaw:widget-theme",
      tokens: expect.objectContaining({ surface: "#faf9f7" }),
    }),
    "https://discussion.example",
  );
});

it.each([
  { change: "theme mode", mode: "light", before: "#faf9f7", after: "#0e1015" },
  { change: "custom palette only", mode: "dark", before: "#171229", after: "#211a36" },
] as const)("updates an existing frame for a $change change", async ({ mode, before, after }) => {
  setTheme(mode, before);
  const frame = await findFrame(
    mountOpen("https://discussion.example/embed/channel/T1/C1?openclawHostTheme=1"),
  );
  const originalUrl = frame.src;
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

  if (mode === "light") {
    document.documentElement.dataset.themeMode = "dark";
  }
  document.documentElement.style.setProperty("--bg", after);

  await vi.waitFor(() => {
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "openclaw:widget-theme",
        mode: "dark",
        tokens: expect.objectContaining({ surface: after }),
      }),
      "https://discussion.example",
    );
  });
  expect(frame.src).toBe(originalUrl);
});

it("offers the valid open URL when a same-origin embed is rejected", async () => {
  const openUrl = "https://discussion.example/thread";
  const panel = mountOpen(
    new URL("/embed/thread", window.location.origin).href,
    openUrl,
    "desktop",
  );

  const empty = await vi.waitFor(() => {
    const candidate = panel.querySelector("openclaw-panel-empty-state");
    expect(candidate).not.toBeNull();
    return candidate!;
  });
  expect(empty.textContent).toContain("This discussion cannot be embedded");
  const external = panel.querySelector<HTMLAnchorElement>("a");
  expect(panel.querySelector("iframe")).toBeNull();
  expect(external?.textContent).toContain("Open discussion in a new tab");
  expect(external?.href).toBe(openUrl);
  expect(external?.target).toBe("_blank");
  expect(external?.rel).toBe("noopener");
});
