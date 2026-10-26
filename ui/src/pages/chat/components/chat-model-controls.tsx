import { createMemo, type Element, type Accessor } from "solid-js";
import type { ChatAccountSelection } from "../../../../../packages/gateway-protocol/src/index.ts";
import { resolveModelRuntimeRoute } from "../../../../../src/shared/model-runtime-route.js";
import type {
  CyberAccessProgram,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../../api/types.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import {
  normalizeChatModelProviderId,
  resolvePreferredServerChatModelValue,
} from "../../../lib/chat/model-ref.ts";
import {
  prepareChatModelSelectCatalog,
  resolveChatFastModeSelectState,
  resolveChatModelSelectState,
  type ChatFastModeSelectValue,
  type ChatFastModeTarget,
} from "../../../lib/chat/model-select-state.ts";
import {
  resolveChatThinkingSelectState,
  type ChatThinkingTarget,
} from "../../../lib/chat/thinking.ts";
import {
  canonicalModelAuthProviderId,
  listEffectiveModelAuthProviders,
} from "../../../lib/model-auth.ts";
import type { ChatModelCatalogState } from "../../../lib/model-catalog-store.ts";
import {
  describeModelProviderAuth,
  type ModelProviderAuthLabel,
} from "../../../lib/model-provider-auth-label.ts";
import {
  isSessionRuntimePinned,
  resolveModelRuntimeEntry,
} from "../../../lib/model-runtime-choice.ts";
import { i18nRevision, registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { ChatEffortPicker, type ChatEffortPickerParams } from "./chat-effort-picker.tsx";
import type { ChatModelAccountSection } from "./chat-model-account-control.ts";
import {
  normalizeChatModelProviderGroupId,
  prepareChatModelCatalog,
  resolveChatModelPickerLabel,
} from "./chat-model-catalog-presentation.ts";
import {
  isModelPickerOptionSelected,
  type ChatModelPickerOption,
  type ChatModelPickerTargetGroup,
} from "./chat-model-picker-options.ts";
import { ChatModelPicker, type ChatModelPickerParams } from "./chat-model-picker.tsx";

registerEnglishCatalog(registerModelControlsEnglish);

type ChatContextWindowTarget = Pick<
  SessionsListResult["defaults"],
  "contextWindow" | "contextWindows" | "contextWindowDefault"
>;

export type ChatModelControlsProps = {
  modelAuthStatusResult?: ModelAuthStatusResult | null;
  accountSelection?: ChatAccountSelection | null;
  renderAccountSection?: (model: string) => ChatModelAccountSection | undefined;
  activeRunId: string | null;
  agentDefaultModel?: string;
  connected: boolean;
  gatewayAvailable: boolean;
  loading: boolean;
  modelCatalog: ModelCatalogEntry[];
  modelCatalogState: ChatModelCatalogState;
  /** Lets a lazy route wrap catalog status without adding its read to Chat boot. */
  renderModelCatalogStatus?: (render: () => Element) => Element;
  modelOverrides?: Readonly<Record<string, string | null | undefined>>;
  modelSelectionLocked?: boolean;
  modelSelectionTarget?: SessionsListResult["defaults"]["modelSelectionTarget"];
  modelPickerTargetGroups?: readonly ChatModelPickerTargetGroup[];
  modelPickerOpen?: boolean;
  modelSwitching: boolean;
  modelMutationDisabledReason?: string;
  effortMutationDisabledReason?: string;
  contextWindowMutationDisabledReason?: string;
  fastModeTarget?: ChatFastModeTarget;
  accessProgramMutationDisabledReason?: string;
  requestedAccessProgram?: CyberAccessProgram;
  onAccessProgramSelect?: (value: CyberAccessProgram | null, sessionKey: string) => unknown;
  sending: boolean;
  sessionKey: string;
  selectedSession: SessionsListResult["sessions"][number] | undefined;
  selectedAgentRuntime?: string;
  sessionsResult: SessionsListResult | null;
  stream: string | null;
  contextWindowTarget?: ChatContextWindowTarget;
  thinkingDefaults?: SessionsListResult["defaults"];
  thinkingSession?: ChatThinkingTarget;
  onFastModeSelect?: (value: ChatFastModeSelectValue, sessionKey: string) => unknown;
  onContextWindowSelect?: (value: string, sessionKey: string) => unknown;
  onModelSetup?: () => void;
  onProviderSettings?: (provider: string) => void;
  onModelPickerOpen?: () => unknown;
  onModelPickerOpenChange?: (open: boolean) => void;
  onModelSelect?: (value: string, sessionKey: string, agentRuntime?: string | null) => unknown;
  onModelPickerTargetRetry?: (groupId: string) => unknown;
  onModelPickerTargetSelect?: (groupId: string, value: string) => unknown;
  onThinkingSelect?: (value: string, sessionKey: string) => unknown;
};

function formatPickerModelLabel(label: string): string {
  const match = /^Default \((.+)\)$/u.exec(label);
  return match?.[1] ?? label;
}

const MODEL_SELECTION_SCOPE_LABELS = new Map([
  ["session", "chat.modelControls.selectionScopeSession"],
  ["agent", "chat.modelControls.selectionScopeAgent"],
  ["global", "chat.modelControls.selectionScopeGlobal"],
]);

function resolveCatalogTriggerStatus(
  state: ChatModelCatalogState,
  hasOptions: boolean,
  selectionKnown: boolean,
): string | undefined {
  if (state.status === "offline") {
    return undefined;
  }
  if (state.status === "error") {
    return !hasOptions ? t("chat.modelControls.modelsUnavailable") : undefined;
  }
  if (!state.hasSnapshot && ["idle", "loading"].includes(state.status)) {
    return selectionKnown ? undefined : t("chat.modelControls.loadingModels");
  }
  if (state.hasSnapshot && !hasOptions) {
    return t("chat.modelControls.noModelsAvailable");
  }
  return undefined;
}

function createChatModelControls(props: ChatModelControlsProps): Accessor<{
  model: ChatModelPickerParams;
  effort: ChatEffortPickerParams;
}> {
  const catalogEntries = createMemo(() => props.modelCatalog);
  const catalogIndex = createMemo(() => prepareChatModelCatalog(catalogEntries()));
  const selectCatalog = createMemo(() => prepareChatModelSelectCatalog(catalogEntries()));
  // Spread props change with the whole frame; only model facts rebuild the choices.
  const selectionInputs = createMemo(
    () => {
      const state = props.modelCatalogState;
      const session = props.selectedSession;
      const defaults = props.sessionsResult?.defaults;
      const overrides = props.modelOverrides;
      return [
        state.modelSelectionPolicy,
        state.retired === true,
        state.initialized,
        props.modelSelectionTarget,
        props.modelAuthStatusResult,
        props.accountSelection,
        session,
        props.agentDefaultModel,
        overrides,
        props.sessionKey,
        props.sessionsResult,
        props.modelSwitching,
        props.selectedAgentRuntime,
        props.modelSelectionLocked,
        // Retained rows/defaults may be enriched without replacing their container.
        state.modelSelectionPolicy?.restricted,
        state.modelSelectionPolicy?.defaultModel,
        session?.model,
        session?.modelProvider,
        session?.modelOverrideSource,
        session?.runtimeSelectionLocked,
        session?.contextTokens,
        session?.agentRuntime?.id,
        session?.agentRuntime?.source,
        defaults?.model,
        defaults?.modelProvider,
        defaults?.agentRuntime?.id,
        overrides?.[props.sessionKey],
        overrides !== undefined && Object.hasOwn(overrides, props.sessionKey),
      ] as const;
    },
    { equals: (before, after) => before.every((value, index) => value === after[index]) },
  );
  const selection = createMemo(() => {
    // Catalog/auth helpers use plain translation reads.
    i18nRevision();
    const [
      policy,
      retired,
      initialized,
      modelSelectionTarget,
      modelAuthStatusResult,
      accountSelection,
      selectedSession,
      agentDefaultModel,
      modelOverrides,
      sessionKey,
      sessionsResult,
      modelSwitching,
      selectedRuntimeOverride,
      modelSelectionLocked,
    ] = selectionInputs();
    const modelCatalog = catalogEntries();
    const catalog = catalogIndex();
    const uninitialized = initialized === false;
    const catalogOwnsChoices = retired || uninitialized || policy?.restricted === true;
    const selectionScopeLabel = MODEL_SELECTION_SCOPE_LABELS.get(modelSelectionTarget ?? "");
    const providerAuth = new Map<string, ModelProviderAuthLabel>();
    const headingKey = (id: string) =>
      normalizeChatModelProviderGroupId(
        canonicalModelAuthProviderId(normalizeChatModelProviderId(id)),
      );
    // Alias records (e.g. google and google-gemini-cli) share one heading, so merge
    // them under that key first; iterating raw records let the later one overwrite it.
    for (const provider of listEffectiveModelAuthProviders(
      (modelAuthStatusResult?.providers ?? []).map((record) =>
        Object.assign({}, record, { provider: headingKey(record.provider) }),
      ),
    )) {
      const selectedId =
        accountSelection?.kind === "automatic" ? undefined : accountSelection?.authProfileId;
      const auth = describeModelProviderAuth(provider, { authProfileId: selectedId });
      if (auth) {
        providerAuth.set(headingKey(provider.provider), auth);
      }
    }
    const {
      currentOverride: rawCurrentOverride,
      defaultModel,
      defaultLabel,
      modelOverrideSource,
      options: selectOptions,
    } = resolveChatModelSelectState(
      {
        activeSession: selectedSession,
        agentDefaultModel,
        chatModelCatalog: modelCatalog,
        modelOverrides: modelOverrides ?? {},
        sessionKey,
        sessionsResult,
        modelSelectionPolicy: policy,
        catalogRetired: retired,
        catalogInitialized: initialized,
      },
      selectCatalog(),
    );
    const currentOverride =
      !catalogOwnsChoices || (!retired && catalog.entry(rawCurrentOverride))
        ? rawCurrentOverride
        : "";
    const activeSession = selectedSession;
    const runtimeSelectionLocked = activeSession?.runtimeSelectionLocked === true;
    const currentProviderHint = activeSession?.modelProvider ?? "";
    // This control owns the saved preference, not the model observed on a run.
    // A running turn can report its old model (or fallback) after a new choice is saved.
    const triggerModelValue = currentOverride;
    const defaultProviderHint = sessionsResult?.defaults?.modelProvider ?? "";
    const defaultCatalogEntry = catalog.entry(defaultModel);
    const canonicalDefaultLabel = resolveChatModelPickerLabel(defaultCatalogEntry, defaultLabel);
    const pickerDefaultLabel =
      defaultModel && canonicalDefaultLabel !== defaultLabel
        ? t("chat.modelControls.defaultWithModel", { model: canonicalDefaultLabel })
        : defaultLabel;
    const normalizedDefaultModel = defaultModel.trim().toLowerCase();
    // A persisted pin can match a changed default; equality cannot establish inheritance.
    const selectedAgentRuntime =
      selectedRuntimeOverride ??
      selectedSession?.agentRuntime?.id ??
      catalog.entry(currentOverride || defaultModel)?.agentRuntime?.id;
    const defaultRuntime =
      defaultCatalogEntry?.agentRuntime?.id ?? sessionsResult?.defaults?.agentRuntime?.id;
    // A default model can still have a runtime pin; only the configured model/runtime pair inherits Default.
    const pickerValue =
      modelOverrideSource === null &&
      (!selectedAgentRuntime || selectedAgentRuntime === defaultRuntime)
        ? ""
        : currentOverride || defaultModel;
    const isDefaultOption = (value: string, entry: ModelCatalogEntry | undefined) =>
      value.trim().toLowerCase() === normalizedDefaultModel ||
      (entry !== undefined && entry === defaultCatalogEntry);
    const modelOptionFamily = (option: (typeof selectOptions)[number]): ChatModelPickerOption[] => {
      const catalogEntry = catalog.entry(option.value);
      const isDefault = isDefaultOption(option.value, catalogEntry);
      // Anthropic route labels need the resolved runtime even when it was not explicitly pinned.
      const agentRuntime = catalogEntry?.agentRuntime;
      const agentRuntimeId =
        agentRuntime &&
        (agentRuntime.source === "model" ||
          agentRuntime.source === "provider" ||
          resolveModelRuntimeRoute(catalogEntry?.provider ?? "", agentRuntime.id))
          ? agentRuntime.id.trim()
          : undefined;
      const pickerOption: ChatModelPickerOption = {
        ...(catalogEntry?.runtimeChoices?.length && !runtimeSelectionLocked
          ? { agentRuntime: agentRuntime?.id ?? null, agentRuntimeId: agentRuntime?.id }
          : {}),
        commitValue: isDefault ? "" : option.value,
        isDefault,
        value: option.value,
        label: resolveChatModelPickerLabel(catalogEntry, option.label),
        contextTokens: catalogEntry?.contextTokens,
        contextWindow: catalogEntry?.contextWindow,
        supportsTools: catalogEntry?.supportsTools,
        recommended: catalogEntry?.recommended,
        disabled: option.disabled,
        unavailableReason: option.disabled ? option.unavailableReason : undefined,
        provider: catalog.provider(
          option.value,
          isDefault
            ? defaultProviderHint
            : option.value === currentOverride
              ? currentProviderHint
              : "",
        ),
      };
      if (agentRuntimeId) {
        pickerOption.agentRuntimeId = agentRuntimeId;
      }
      if (
        isDefault &&
        isSessionRuntimePinned(selectedSession?.agentRuntime) &&
        resolveModelRuntimeRoute(pickerOption.provider)
      ) {
        // Default clears the runtime pin; session-scoped metadata describes the route being left.
        pickerOption.agentRuntimeId = undefined;
      }
      const options = [pickerOption];
      for (const choice of runtimeSelectionLocked ? [] : (catalogEntry?.runtimeChoices ?? [])) {
        if (choice.manualSelectionAllowed === false) {
          continue;
        }
        options.push({
          value: option.value,
          commitValue: option.value,
          isDefault: false,
          label: resolveChatModelPickerLabel(catalogEntry, option.label, choice.agentRuntime.id),
          provider: pickerOption.provider,
          agentRuntime: choice.agentRuntime.id,
          runtimeOverride: choice.agentRuntime.id,
          agentRuntimeId: choice.agentRuntime.id,
          contextTokens: choice.contextTokens,
          contextWindow: choice.contextWindow,
          supportsTools: choice.supportsTools,
          disabled: choice.available === false,
          unavailableReason: choice.unavailableReason,
          recommended: pickerOption.recommended,
        });
      }
      return options;
    };
    // Only a pin recorded on the session row makes Default a reset target: New Session
    // drafts have no row, and a local optimistic override is not yet a recorded pin.
    const sessionModelPinned =
      selectedSession?.modelOverrideSource === "user" ||
      (!runtimeSelectionLocked && isSessionRuntimePinned(selectedSession?.agentRuntime));
    // A recorded pin keeps Default available even when the catalog omits it.
    const syntheticDefault: ChatModelPickerOption | undefined =
      defaultModel &&
      (sessionModelPinned || policy?.restricted) &&
      !retired &&
      !uninitialized &&
      !selectOptions.some((option) => isDefaultOption(option.value, catalog.entry(option.value)))
        ? {
            commitValue: "",
            isDefault: true,
            value: defaultModel,
            label: formatPickerModelLabel(pickerDefaultLabel),
            provider: catalog.provider(defaultModel, defaultProviderHint),
          }
        : undefined;
    const currentCatalogEntry = catalog.entry(currentOverride);
    const syntheticCurrent: ChatModelPickerOption | undefined =
      currentOverride &&
      (!catalogOwnsChoices || currentCatalogEntry) &&
      currentCatalogEntry?.manualSelectionAllowed !== false &&
      (selectOptions.length > 0 || syntheticDefault) &&
      syntheticDefault?.value !== currentOverride &&
      !selectOptions.some((option) => option.value === currentOverride)
        ? {
            commitValue: currentOverride,
            contextTokens: currentCatalogEntry?.contextTokens,
            contextWindow: currentCatalogEntry?.contextWindow,
            supportsTools: currentCatalogEntry?.supportsTools,
            disabled: currentCatalogEntry?.available === false,
            unavailableReason:
              currentCatalogEntry?.available === false
                ? currentCatalogEntry.unavailableReason
                : undefined,
            isDefault: false,
            value: currentOverride,
            label: resolveChatModelPickerLabel(
              currentCatalogEntry,
              currentCatalogEntry?.name.trim() || currentOverride,
            ),
            provider: catalog.provider(currentOverride, currentProviderHint),
          }
        : undefined;
    const findModelOption = (value: string) => {
      const matches = (option: ChatModelPickerOption) =>
        isModelPickerOptionSelected(option, value, selectedAgentRuntime);
      if (syntheticDefault && matches(syntheticDefault)) {
        return syntheticDefault;
      }
      for (const option of selectOptions) {
        if (
          option.value !== value &&
          !(value === "" && isDefaultOption(option.value, catalog.entry(option.value)))
        ) {
          continue;
        }
        const match = modelOptionFamily(option).find(matches);
        if (match) {
          return match;
        }
      }
      return syntheticCurrent && matches(syntheticCurrent) ? syntheticCurrent : undefined;
    };
    const activeModelOption = findModelOption(pickerValue);
    const triggerModelOption =
      triggerModelValue && triggerModelValue !== pickerValue
        ? findModelOption(triggerModelValue)
        : activeModelOption;
    const hasModelOptions =
      selectOptions.length > 0 || Boolean(syntheticDefault || syntheticCurrent);
    const hasSelectableModel =
      Boolean(syntheticDefault || (syntheticCurrent && !syntheticCurrent.disabled)) ||
      selectOptions.some(
        (option) =>
          !option.disabled ||
          (!runtimeSelectionLocked &&
            catalog
              .entry(option.value)
              ?.runtimeChoices?.some(
                (choice) => choice.manualSelectionAllowed !== false && choice.available !== false,
              )),
      );
    const activeSessionModel = activeSession?.model
      ? catalog.entry(
          resolvePreferredServerChatModelValue(
            activeSession.model,
            activeSession.modelProvider,
            modelCatalog,
          ),
        )
      : undefined;
    const activeOptionModel = activeModelOption
      ? catalog.entry(activeModelOption.value)
      : undefined;
    const activeSessionRuntime = activeSession?.agentRuntime?.id.trim().toLowerCase();
    const activeOptionRuntime = (
      resolveModelRuntimeEntry(activeOptionModel, activeModelOption?.agentRuntime)?.agentRuntime
        ?.id ??
      (activeModelOption?.isDefault ? sessionsResult?.defaults?.agentRuntime?.id : undefined)
    )
      ?.trim()
      .toLowerCase();
    const activeRuntimeMatches =
      Boolean(activeSessionRuntime) && activeSessionRuntime === activeOptionRuntime;
    // Missing or mismatched current-selection provenance cannot bind the cached
    // session window. Even matching provenance is useful only after the switch settles.
    const activeContextTokens =
      !modelSwitching &&
      activeModelOption &&
      activeSession?.contextTokens &&
      activeRuntimeMatches &&
      activeSessionModel !== undefined &&
      activeSessionModel === activeOptionModel
        ? activeSession.contextTokens
        : undefined;
    // The preference label uses its selected runtime, not an executing fallback.
    const triggerRuntime = selectedAgentRuntime ?? defaultRuntime;
    // A lock prevents model changes; the concrete selection still owns its label.
    // Without a selection, neither the runtime nor the agent default identifies it.
    const committedModelLabel =
      modelSelectionLocked === true && !triggerModelValue
        ? t("chat.selectors.lockedSessionModel")
        : resolveChatModelPickerLabel(
            catalog.entry(triggerModelValue || defaultModel),
            formatPickerModelLabel(
              selectOptions.find((entry) => entry.value === triggerModelValue)?.label ??
                (catalog.entry(triggerModelValue)?.name.trim() ||
                  triggerModelValue ||
                  defaultLabel),
            ),
            triggerModelValue || defaultModel ? triggerRuntime : null,
          );
    const buildModelOptions = () => {
      const options = selectOptions.flatMap(modelOptionFamily);
      if (syntheticDefault) {
        options.unshift(syntheticDefault);
      }
      if (syntheticCurrent) {
        options.push(syntheticCurrent);
      }
      if (activeContextTokens !== undefined) {
        const active = options.find((option) =>
          isModelPickerOptionSelected(option, pickerValue, selectedAgentRuntime),
        );
        if (active) {
          active.contextTokens = activeContextTokens;
        }
      }
      return options;
    };
    return {
      catalog,
      policy,
      retired,
      uninitialized,
      selectionScopeLabel,
      providerAuth,
      currentOverride,
      defaultModel,
      modelOverrideSource,
      activeSession,
      buildModelOptions,
      hasModelOptions,
      hasSelectableModel,
      activeModelOption,
      triggerModelOption,
      pickerValue,
      selectedAgentRuntime,
      sessionModelPinned,
      committedModelLabel,
      triggerRuntime,
    };
  });
  // The retained panel starts observing this only after its first open.
  const modelOptions = createMemo(() => selection().buildModelOptions(), { lazy: true });
  return createMemo(() => {
    const {
      catalog,
      policy,
      retired,
      uninitialized,
      selectionScopeLabel,
      providerAuth,
      currentOverride,
      defaultModel,
      modelOverrideSource,
      activeSession,
      hasModelOptions,
      hasSelectableModel,
      activeModelOption,
      triggerModelOption,
      pickerValue,
      selectedAgentRuntime,
      sessionModelPinned,
      committedModelLabel,
      triggerRuntime,
    } = selection();
    const catalogState = props.modelCatalogState;
    const thinking = resolveChatThinkingSelectState({
      catalog: props.modelCatalog,
      defaults: props.thinkingDefaults,
      session: props.thinkingSession,
      sessionKey: props.sessionKey,
      sessionsResult: props.sessionsResult,
    });
    const resolvedFastMode = resolveChatFastModeSelectState({
      catalog: props.modelCatalog,
      connected: props.connected,
      currentModelOverride: currentOverride,
      fastModeTarget: props.fastModeTarget ?? props.selectedSession,
      gatewayAvailable: props.gatewayAvailable,
      loading: props.loading,
      sessionsResult: props.sessionsResult,
    });
    // Reasoning/fast state still describes the previous model until the refreshed
    // session row lands. Lock both so stale levels cannot be committed mid-switch.
    const fastMode = props.modelSwitching
      ? { ...resolvedFastMode, disabled: true }
      : resolvedFastMode;
    const catalogLoadingWithoutSnapshot =
      !catalogState.hasSnapshot && ["idle", "loading"].includes(catalogState.status);
    // The session owns the selected model; its account-scoped catalog only owns
    // picker availability. Refreshing that catalog must not hide a known selection.
    const selectionKnown = Boolean(
      currentOverride || (modelOverrideSource === null && defaultModel),
    );
    const catalogTriggerStatus = retired
      ? resolveCatalogTriggerStatus(catalogState, false, false)
      : policy?.restricted && !currentOverride && !defaultModel
        ? t(
            hasModelOptions
              ? "chat.modelControls.selectionRequired"
              : "chat.modelControls.noPermittedModels",
          )
        : resolveCatalogTriggerStatus(catalogState, hasModelOptions, selectionKnown);
    const hasResolvableModel =
      catalogState.hasSnapshot &&
      (catalogState.status === "ready" ||
        catalogState.status === "error" ||
        catalogState.status === "loading" ||
        catalogState.status === "offline") &&
      activeModelOption?.disabled !== true &&
      hasSelectableModel;
    const busy = props.sending || Boolean(props.activeRunId) || props.stream !== null;
    const modelControlsDisabled =
      !props.connected || props.modelSwitching || !props.gatewayAvailable;
    const commonDisabled = modelControlsDisabled || props.loading;
    const effortMutationDisabled = Boolean(props.effortMutationDisabledReason);
    // Loading owns the menu contents, not the trigger. Keeping the trigger
    // interactive lets the first gesture open the picker and observe that state.
    const modelDisabled = modelControlsDisabled || Boolean(props.modelMutationDisabledReason);
    const thinkingDisabled =
      commonDisabled ||
      effortMutationDisabled ||
      !catalogState.hasSnapshot ||
      (thinking.options.length === 0 && thinking.selection.source === "default");
    // One owner supplies the whole tuple: mixing an override session's fields with
    // the defaults row can render the default model's options for a session whose
    // model declares none, then patch an invalid option id.
    const contextWindowOwner =
      props.contextWindowTarget ?? activeSession ?? props.sessionsResult?.defaults;
    const contextWindows = contextWindowOwner?.contextWindows ?? [];
    const selectedContextWindow =
      contextWindowOwner?.contextWindow ?? contextWindowOwner?.contextWindowDefault ?? "";
    const defaultContextWindow = contextWindowOwner?.contextWindowDefault;
    const accessPrograms =
      props.connected &&
      catalogState.hasSnapshot &&
      catalogState.status === "ready" &&
      !retired &&
      !uninitialized &&
      !props.modelSwitching
        ? (resolveModelRuntimeEntry(catalog.entry(currentOverride || defaultModel), triggerRuntime)
            ?.availableAccessPrograms?.cyber ?? [])
        : [];
    const showAccessProgram =
      Boolean(props.onAccessProgramSelect) &&
      accessPrograms.some((program) => program !== "standard");
    const accessProgramDisabled =
      commonDisabled || Boolean(props.accessProgramMutationDisabledReason);
    const effortDisabled =
      commonDisabled ||
      !hasResolvableModel ||
      ((effortMutationDisabled || (thinking.options.length === 0 && fastMode.disabled)) &&
        (!showAccessProgram || accessProgramDisabled));
    // Keep the effort control mounted but hidden until its catalog resolves.
    const reserveEffortPicker = !hasResolvableModel;
    return {
      model: {
        accessProgramRecovery:
          props.requestedAccessProgram !== undefined &&
          !showAccessProgram &&
          props.onAccessProgramSelect
            ? {
                disabled: accessProgramDisabled,
                onClear: (sessionKey) => props.onAccessProgramSelect?.(null, sessionKey),
              }
            : undefined,
        providerAuth: props.modelAuthStatusResult ? providerAuth : undefined,
        accountSection: props.renderAccountSection?.(currentOverride || defaultModel),
        contextWindow:
          contextWindows.length > 1
            ? {
                options: contextWindows,
                selected: selectedContextWindow,
                ...(defaultContextWindow ? { defaultId: defaultContextWindow } : {}),
                disabled:
                  commonDisabled || busy || Boolean(props.contextWindowMutationDisabledReason),
                onSelect: async (next, targetSessionKey) => {
                  await props.onContextWindowSelect?.(next, targetSessionKey);
                },
              }
            : undefined,
        disabled: modelDisabled,
        disabledReason: props.modelMutationDisabledReason,
        modelCatalogState: catalogState,
        renderModelCatalogStatus: props.renderModelCatalogStatus,
        open: props.modelPickerOpen,
        modelSelectionLocked: props.modelSelectionLocked === true,
        selectionScopeDescription: policy?.restricted
          ? t("chat.modelControls.restrictedModelsHelp")
          : selectionScopeLabel
            ? t(selectionScopeLabel)
            : undefined,
        getModelOptions: modelOptions,
        triggerModelOption,
        targetGroups: props.modelPickerTargetGroups,
        selectedModelValue: pickerValue,
        selectedAgentRuntime,
        sessionModelPinned,
        sessionKey: props.sessionKey,
        triggerModelLabel: formatPickerModelLabel(committedModelLabel),
        triggerStatusLabel: props.modelSelectionLocked ? undefined : catalogTriggerStatus,
        triggerLoading:
          !props.modelSelectionLocked && catalogLoadingWithoutSnapshot && !selectionKnown,
        onModelSetup:
          policy?.restricted || retired || uninitialized ? undefined : props.onModelSetup,
        onProviderSettings:
          policy?.restricted || retired || uninitialized ? undefined : props.onProviderSettings,
        onOpen: props.onModelPickerOpen,
        onOpenChange: props.onModelPickerOpenChange,
        onModelSelect: async (next, targetSessionKey, agentRuntime) =>
          props.onModelSelect?.(next, targetSessionKey, agentRuntime),
        onTargetRetry: props.onModelPickerTargetRetry,
        onTargetSelect: props.onModelPickerTargetSelect,
      },
      effort: {
        accessProgram:
          showAccessProgram && props.onAccessProgramSelect
            ? {
                requested: props.requestedAccessProgram,
                programs: accessPrograms,
                disabled: accessProgramDisabled,
                sessionKey: props.sessionKey,
                onSelect: props.onAccessProgramSelect,
              }
            : undefined,
        disabled: effortDisabled,
        disabledReason: props.effortMutationDisabledReason,
        fastMode: {
          ...fastMode,
          disabled: fastMode.disabled || commonDisabled || effortMutationDisabled,
        },
        sessionKey: props.sessionKey,
        thinkingDisabled,
        thinking,
        onFastModeSelect: async (next, targetSessionKey) =>
          props.onFastModeSelect?.(next, targetSessionKey),
        onThinkingSelect: async (next, targetSessionKey) =>
          props.onThinkingSelect?.(next, targetSessionKey),
        reserved: reserveEffortPicker,
      },
    };
  });
}

export function ChatModelControls(props: ChatModelControlsProps) {
  const controls = createChatModelControls(props);
  return (
    <div class="chat-controls__session chat-controls__model chat-controls__model-settings">
      <ChatModelPicker {...controls().model} />
      <ChatEffortPicker {...controls().effort} />
    </div>
  );
}
