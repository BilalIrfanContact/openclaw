import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  openBrowserActions,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
} from "./browser-panel-controller-test-support.ts";
import { createBrowserPageClient } from "./test-helpers/browser-page.ts";
import "./browser-panel.ts";

describe("Browser toolbar", () => {
  setupBrowserPanelTestCleanup();
  beforeEach(() => vi.stubGlobal("localStorage", createStorageMock()));

  async function mount() {
    stubScreenshotMedia();
    const panel = document.createElement("openclaw-browser-panel");
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.client = createBrowserPageClient(
      "asset",
      "https://assets.example.test/preview.png",
    ).client;
    mountSolid(() => panel);
    await waitForSolid(() => expect(panel.querySelector(".bp-shot")).not.toBeNull());
    return panel;
  }

  const favicon = (panel: HTMLElement) =>
    panel.querySelector<HTMLImageElement>(".bp-toolbar-favicon img");

  it("retires replaced favicon requests without replacing the address draft or focus", async () => {
    const panel = await mount();
    const input = panel.querySelector<HTMLInputElement>(".bp-url")!;
    input.focus();
    input.value = "https://draft.example.test/uncommitted";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await panel.updateComplete;
    input.setSelectionRange(8, 13);
    const toolbar = panel.querySelector(".bp-toolbar");
    const retired = createDeferred<string | null>();
    const current = createDeferred<string | null>();
    const firstFetcher = vi.fn(() => retired.promise);
    const currentFetcher = vi.fn(() => current.promise);
    panel.fetchFavicon = firstFetcher;
    await waitForSolid(() => expect(firstFetcher).toHaveBeenCalledOnce());
    panel.fetchFavicon = currentFetcher;
    await waitForSolid(() => expect(currentFetcher).toHaveBeenCalledOnce());
    expect(favicon(panel)).toBeNull();

    const currentUrl = "data:image/png;base64,Y3VycmVudA==";
    current.resolve(currentUrl);
    await waitForSolid(() => expect(favicon(panel)?.getAttribute("src")).toBe(currentUrl));
    retired.resolve("data:image/png;base64,cmV0aXJlZA==");
    await retired.promise;
    await panel.updateComplete;
    expect(favicon(panel)?.getAttribute("src")).toBe(currentUrl);
    expect(panel.querySelector(".bp-toolbar")).toBe(toolbar);
    expect(panel.querySelector(".bp-url")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input).toMatchObject({
      value: "https://draft.example.test/uncommitted",
      selectionStart: 8,
      selectionEnd: 13,
    });

    favicon(panel)!.dispatchEvent(new Event("error"));
    await waitForSolid(() => expect(favicon(panel)).toBeNull());
    expect(panel.querySelector(".bp-toolbar-favicon svg")).not.toBeNull();
  });

  it("renders the download's Gateway error and HTTP status", async () => {
    const panel = await mount();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { message: "Unauthorized", type: "unauthorized" } },
            { status: 401 },
          ),
        ),
    );
    (await openBrowserActions(panel))
      .querySelector<HTMLElement>('[aria-label="Download file"]')!
      .click();
    await waitForSolid(() => expect(panel.textContent).toContain("HTTP 401: Unauthorized"));
  });

  it("updates download state without replacing the preview", async () => {
    const panel = await mount();
    const body = createDeferred<Blob>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => body.promise }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const preview = panel.querySelector(".bp-shot");
    const menu = await openBrowserActions(panel);
    const download = (label = "Download file") =>
      menu.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
    let button = download();
    const expectPreview = () => {
      expect(panel.querySelector(".bp-note")).toBeNull();
      expect(panel.querySelector(".bp-shot")).toBe(preview);
    };
    const downloadShape = button.querySelector("svg")!.innerHTML;
    button.click();
    await panel.updateComplete;
    await openBrowserActions(panel);
    button = download("Downloading…");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.querySelector("svg")!.innerHTML).not.toBe(downloadShape);
    expectPreview();

    body.resolve(new Blob(["complete asset"], { type: "image/png" }));
    await waitForSolid(() => {
      button = download();
      expect(button?.getAttribute("aria-busy")).toBe("false");
    });
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.querySelector("svg")!.innerHTML).toBe(downloadShape);
    expectPreview();
  });
});
