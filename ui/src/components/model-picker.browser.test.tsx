import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { updatePickers, openPicker, choosePickerValue } from "../test-helpers/select-picker.ts";
import type { SelectPicker } from "./select-picker.ts";
import { ModelPicker } from "./solid/model-picker.tsx";
import { installTitleTooltips } from "./tooltip-title.ts";

const fixture = (name: string, detail?: string) => ({
  value: `openai/fixture-${name.toLowerCase()}`,
  label: `Fixture ${name}`,
  provider: "openai",
  detail,
});
async function mountPicker(
  props: Partial<Omit<Parameters<typeof ModelPicker>[0], "label" | "onChange">>,
) {
  const onChange = vi.fn();
  const view = mountSolid(() => (
    <ModelPicker
      label="Model"
      value="openai/fixture-alpha"
      options={[{ value: "", label: "Default" }, fixture("Alpha")]}
      onChange={onChange}
      {...props}
    />
  ));
  await updatePickers(view.container);
  const picker = view.container.querySelector<SelectPicker>("openclaw-select-picker")!;
  const option = (value: string) =>
    picker.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`)!;
  return { ...view, picker, option, onChange };
}
const settle = async () => {
  await Promise.resolve();
  flush();
};

it("settles disabled provider groups and allows re-enabling", async () => {
  const [disabled, setDisabled] = createSignal(false);
  const { container, picker, onChange } = await mountPicker({
    options: [fixture("Alpha"), fixture("Beta")],
    get disabled() {
      return disabled();
    },
    groupByProvider: true,
  });
  const trigger = picker.querySelector<HTMLButtonElement>(".picker-select__trigger")!;
  const group = () => picker.querySelector<HTMLButtonElement>(".picker-select__group-toggle");
  await openPicker(picker);
  group()!.click();
  flush();
  expect(group()?.getAttribute("aria-expanded")).toBe("false");
  setDisabled(true);
  flush();
  await settle();
  expect(trigger.disabled).toBe(true);
  expect(group()).toBeNull();
  container.append(document.createElement("span"));
  // Deliver the registry mutation, then settle its consumers.
  await settle();
  expect(group()).toBeNull();
  setDisabled(false);
  flush();
  await openPicker(picker);
  expect(group()?.getAttribute("aria-expanded")).toBe("true");
  await choosePickerValue(picker, "openai/fixture-beta");
  expect(onChange).toHaveBeenCalledExactlyOnceWith("openai/fixture-beta");
});

it("commits free-form models on input by default", async () => {
  const { container, onChange } = await mountPicker({
    value: "vendor/current",
    custom: { label: "Custom model…" },
  });
  const input = container.querySelector<HTMLInputElement>("input")!;
  input.value = "vendor/model with spaces";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("vendor/model with spaces");
});

it("keeps raw references out of hover tooltips", async () => {
  const { picker, option } = await mountPicker({
    options: [{ value: "", label: "Automatic" }, fixture("Alpha", "API"), fixture("Beta", "API")],
  });
  const dispose = installTitleTooltips(document);
  try {
    await openPicker(picker);
    expect(option("").querySelector(".picker-select__leading")).toBeNull();
    const row = option("openai/fixture-beta");
    expect(row.textContent).toContain("API");
    row.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
    expect(document.querySelector("openclaw-tooltip")?.content ?? "").toBe("");
  } finally {
    dispose();
  }
});
