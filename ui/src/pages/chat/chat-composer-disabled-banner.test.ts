/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import {
  renderComposerFixture,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";

afterEach(() => resetComposerFixture());

type Banner = NonNullable<Parameters<typeof renderComposerFixture>[0]>["disabledBanner"];
function drawBanner(overrides: Partial<NonNullable<Banner>> = {}) {
  const view = renderComposerFixture({
    canSend: false,
    disabledBanner: {
      kind: "composer-replacement",
      text: "This session is archived.",
      actionLabel: "Unarchive",
      onAction: vi.fn(),
      ...overrides,
    },
  });
  const banner = view.container.querySelector(".agent-chat__disabled-banner")!;
  const update = (disabledBanner: Banner) =>
    renderComposerInto(view.container, { ...view.props, disabledBanner });
  return { ...view, update, banner, action: banner.querySelector<HTMLButtonElement>("button")! };
}

function expectClasses(element: Element, classes: string) {
  expect(new Set(element.classList)).toEqual(new Set(classes.split(" ")));
}

it("keeps the focused action through a banner refresh and uses the current action", () => {
  const initialAction = vi.fn();
  const refreshedAction = vi.fn();
  const text = "This session is still archived.";
  const { container, update, action, banner } = drawBanner({ onAction: initialAction });
  document.body.append(container);
  action.focus();
  expectClasses(
    action.parentElement!,
    "agent-chat__disabled-banner agent-chat__disabled-banner--replacement callout info callout--action",
  );

  update({
    kind: "composer-replacement",
    text,
    actionLabel: "Unarchive",
    onAction: refreshedAction,
  });

  expect(container.querySelector(".agent-chat__disabled-banner")?.textContent).toContain(text);
  expect(container.querySelector(".agent-chat__disabled-banner")).toBe(banner);
  expect(container.querySelector(".agent-chat__disabled-banner button")).toBe(action);
  expect(document.activeElement).toBe(action);
  action.click();
  expect(initialAction).not.toHaveBeenCalled();
  expect(refreshedAction).toHaveBeenCalledOnce();
});

it("disables its action with the mutation reason", () => {
  const onAction = vi.fn();
  const reason = "Operator write access is required.";
  const { action } = drawBanner({ disabledReason: reason, onAction });
  expect(action).toMatchObject({ disabled: true, title: reason });
  action?.click();
  expect(onAction).not.toHaveBeenCalled();
});

it("renders a standard primary action with progress feedback", () => {
  const title = "This task was interrupted by a restart.";
  const text = "Your transcript is safe. Resume to continue in this session.";
  const busyLabel = "Resuming…";
  const { banner, action } = drawBanner({
    title,
    text,
    tone: "neutral",
    icon: "warning",
    actionLabel: "Resume",
    actionStyle: "primary",
    busy: true,
    busyLabel,
  });
  expectClasses(
    banner,
    "agent-chat__disabled-banner agent-chat__disabled-banner--replacement callout agent-chat__disabled-banner--neutral callout--action",
  );
  expect(banner?.querySelector(".agent-chat__disabled-banner-icon")).not.toBeNull();
  expect(banner.querySelector(".agent-chat__disabled-banner-title")?.textContent).toContain(title);
  expect(banner.querySelector(".agent-chat__disabled-banner-detail")?.textContent).toContain(text);
  expectClasses(action, "btn btn--sm primary");
  expect(action).toMatchObject({ disabled: true, textContent: expect.stringContaining(busyLabel) });
  expect(action?.getAttribute("aria-busy")).toBe("true");
  expect(action?.querySelector(".btn__spinner")).not.toBeNull();
});

it("keeps notice Stop focused, uses the current callback and removes it when no action is supplied", () => {
  const initialAbort = vi.fn();
  const currentAbort = vi.fn();
  const { container, update } = drawBanner({
    text: "This subagent is working.",
    actionLabel: undefined,
    onAction: undefined,
    stop: { onAbort: initialAbort },
  });
  document.body.append(container);
  const findStop = () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Stop generating"]');
  const stop = findStop()!;
  expect(stop).not.toBeNull();
  stop.focus();

  update({
    kind: "composer-replacement",
    text: "This subagent is still working.",
    stop: { onAbort: currentAbort },
  });
  expect(findStop()).toBe(stop);
  expect(document.activeElement).toBe(stop);
  stop.click();
  expect(initialAbort).not.toHaveBeenCalled();
  expect(currentAbort).toHaveBeenCalledOnce();

  update({ kind: "composer-replacement", text: "This subagent finished." });
  expect(findStop()).toBeNull();
  expect(currentAbort).toHaveBeenCalledOnce();
});
