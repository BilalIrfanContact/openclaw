import { afterEach, expect, it, vi } from "vitest";
import * as staleChunkReload from "../../app/stale-chunk-reload.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createNewSessionRouteData as routeData } from "./location.test-support.ts";
import type { PageHost } from "./new-session-page-owner.ts";
import "./new-session-page-entry.ts";

const detailImport = vi.hoisted(() => ({
  calls: 0,
  first: Promise.withResolvers<void>(),
  ready: Promise.withResolvers<void>(),
  recovery: Promise.withResolvers<void>(),
  canReload: (): boolean => false,
}));
vi.mock("../chat/components/chat-detail-panel.tsx", async (importOriginal) => {
  if (++detailImport.calls === 1) {
    await detailImport.first.promise;
    throw new Error("Failed to fetch dynamically imported module");
  }
  await detailImport.ready.promise;
  return importOriginal();
});

async function enterMessage(page: PageHost, message: string) {
  const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message")!;
  textarea.value = message;
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
  await page.updateComplete;
  return textarea;
}

async function pasteAttachment(page: PageHost, text: string) {
  const textarea = await enterMessage(page, "Review the attachment");
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { items: [], getData: () => text },
  });
  textarea.dispatchEvent(paste);
  expect(paste.defaultPrevented).toBe(true);
  await page.updateComplete;
  await vi.dynamicImportSettled();
  const open = () => page.querySelector<HTMLElement>(".chat-attachment-file__open");
  await waitForSolid(() => expect(open()).not.toBeNull());
  open()!.click();
}

afterEach(async () => {
  detailImport.first.resolve();
  detailImport.ready.resolve();
  detailImport.recovery.resolve();
  document.querySelectorAll("openclaw-new-session-page").forEach((element) => element.remove());
  await vi.dynamicImportSettled();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

it("keeps the draft usable through a cold preview retry and retires it before the import settles", async () => {
  const isStaleChunkImportError = staleChunkReload.isStaleChunkImportError;
  // Vitest wraps rejected mock imports; browsers deliver the original import error.
  vi.spyOn(staleChunkReload, "isStaleChunkImportError").mockImplementation((error) =>
    isStaleChunkImportError(
      error instanceof Error && error.cause instanceof Error ? error.cause : error,
    ),
  );
  vi.spyOn(staleChunkReload, "retryStaleChunkReloadWhenReachable").mockImplementation(
    async (options) => {
      detailImport.canReload = options?.canReload ?? (() => false);
      await detailImport.recovery.promise;
      return false;
    },
  );
  const page = document.createElement("openclaw-new-session-page");
  const loading = () => page.querySelector(".new-session-attachment-panel [role='status']");
  page.data = routeData("research");
  document.body.append(page);
  await page.updateComplete;
  expect(detailImport.calls).toBe(0);
  const original = "# Original pasted content\n  preserve indentation 漢字 😀\n".repeat(50);
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(async () => new Response(original)),
  );
  await pasteAttachment(page, original);
  await waitForSolid(() => {
    expect(detailImport.calls).toBe(1);
    expect(loading()).not.toBeNull();
  });
  const textarea = await enterMessage(page, "Keep typing while the preview loads");
  expect(page.querySelector(".new-session-page__message")).toBe(textarea);
  expect(textarea.value).toBe("Keep typing while the preview loads");

  detailImport.first.resolve();
  await waitForSolid(() => expect(page.querySelector(".lazy-view-error--stale")).not.toBeNull());
  page.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await waitForSolid(() => expect(loading()).not.toBeNull());
  expect(textarea.value).toBe("Keep typing while the preview loads");
  expect(detailImport.canReload()).toBe(true);
  detailImport.recovery.resolve();
  await waitForSolid(() => expect(detailImport.calls).toBe(2));

  window.history.replaceState({}, "", "/new?agent=main");
  page.data = routeData("main");
  await waitForSolid(() => expect(page.querySelector(".new-session-attachment-panel")).toBeNull());
  expect(detailImport.canReload()).toBe(false);
  detailImport.ready.resolve();
  await vi.dynamicImportSettled();
  expect(page.querySelector("openclaw-chat-detail-panel")).toBeNull();

  await pasteAttachment(page, original);
  await waitForSolid(() =>
    expect(page.querySelector("openclaw-chat-detail-panel pre")?.textContent).toBe(original),
  );
});
