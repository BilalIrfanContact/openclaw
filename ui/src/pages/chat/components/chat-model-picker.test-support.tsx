import { createSignal } from "solid-js";
import { expect, vi } from "vitest";
import { mountSolid, type MountSolidOptions } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  isModelPickerOptionSelected,
  type ChatModelPickerOption,
} from "./chat-model-picker-options.ts";
import { ChatModelPicker, type ChatModelPickerParams } from "./chat-model-picker.tsx";

type PickerProps = Omit<ChatModelPickerParams, "getModelOptions" | "triggerModelOption"> & {
  modelOptions: ChatModelPickerOption[];
};
export function modelControlSelector(name: string, value?: string) {
  return `[data-chat-model-${name}${value === undefined ? "" : `="${value}"`}]`;
}
type Option = ChatModelPickerOption;
export function modelOption(provider: string, id: string, overrides: Partial<Option> = {}): Option {
  return {
    provider,
    value: `${provider}/${id}`,
    commitValue: `${provider}/${id}`,
    label: id,
    isDefault: false,
    ...overrides,
  };
}
export function modelPickerProps(overrides: Partial<PickerProps> = {}): PickerProps {
  return {
    disabled: false,
    modelSelectionLocked: false,
    modelOptions: [],
    selectedModelValue: "fixture/current",
    sessionModelPinned: true,
    sessionKey: "main",
    triggerModelLabel: "Current",
    onModelSelect: vi.fn(async () => {}),
    ...overrides,
  };
}
export function modelPickerParams(props: PickerProps): ChatModelPickerParams {
  const { modelOptions, ...params } = props;
  return {
    ...params,
    getModelOptions: () => modelOptions,
    triggerModelOption: modelOptions.find((option) =>
      isModelPickerOptionSelected(option, params.selectedModelValue, params.selectedAgentRuntime),
    ),
  };
}
export function mountModelPicker(params: Partial<PickerProps>, options?: MountSolidOptions) {
  let update!: (next: PickerProps) => void;
  const view = mountSolid(() => {
    const [props, setProps] = createSignal(modelPickerProps(params));
    update = (next) => {
      setProps(() => next);
      flush();
    };
    return <ChatModelPicker {...modelPickerParams(props())} />;
  }, options);
  flush();
  return { ...view, update };
}
export const waitForModelMenu = (container: HTMLElement) =>
  waitForSolid(() => expect(container.querySelector(".chat-controls__model-menu")).not.toBeNull());

export function expandModelProviders(container: HTMLElement) {
  for (const toggle of container.querySelectorAll<HTMLButtonElement>(
    '[data-chat-model-provider-toggle][aria-expanded="false"]',
  )) {
    toggle.click();
    flush();
  }
}
