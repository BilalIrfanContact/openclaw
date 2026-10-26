/* @vitest-environment jsdom */
import { getQueriesForElement } from "@solidjs/testing-library";
import { createMemo, createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { DevicePairJoinSetup } from "../../lib/device-pair-setup.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ConnectMachineDialog } from "./connect-machine-dialog-view.tsx";
import { ConnectMachineSetupState } from "./connect-machine-dialog.ts";

function code(id: string): DevicePairJoinSetup {
  const joinUrl = `https://gateway.example.test/j/${id}`;
  const command = `openclaw connect ${joinUrl}`;
  return {
    setupId: id,
    setupCode: "SYNTHETIC",
    joinUrl,
    command: `${command} --session-host`,
    serviceCommand: command,
    installedCommand: `${command} --installed`,
    gatewayUrl: "wss://gateway.example.test",
    auth: "token",
    urlSource: "test",
    access: "node",
    expiresAtMs: 2_000_000_000_000,
  };
}

function mountSetup() {
  const gateway = {
    client: new GatewayBrowserClient({ url: "wss://gateway.example.test" }),
    connected: true,
  };
  let changed = () => {};
  const setup = new ConnectMachineSetupState(
    () => gateway,
    () => changed(),
  );
  const view = mountSolid(() => {
    const [revision, publish] = createSignal(0);
    changed = () => publish((value) => value + 1);
    const props = createMemo(() => {
      revision();
      return setup.view(true, () => {});
    });
    return (
      <>
        <button onClick={() => setup.start()}>Connect</button>
        <ConnectMachineDialog {...props()} />
      </>
    );
  });
  onTestFinished(() => setup.close());
  flush();
  const queries = getQueriesForElement(document.body);
  return {
    gateway,
    ...queries,
    button: (name: string) => queries.getByRole<HTMLButtonElement>("button", { name }),
    dialog: () => view.container.querySelector("openclaw-modal-dialog"),
    command: (id: string) => queries.queryByText(code(id).command),
    ready: (id: string) =>
      waitForSolid(() => expect(queries.getByText(code(id).command)).toBeDefined()),
  };
}

it("retains the command and dialog through minting, refresh failure and retry", async () => {
  const f = mountSetup();
  const initial = Promise.withResolvers<DevicePairJoinSetup>();
  const request = vi.spyOn(f.gateway.client, "request").mockReturnValueOnce(initial.promise);
  f.button("Connect").click();
  await waitForSolid(() =>
    expect(f.getByRole("status").textContent).toBe("Creating a secure connection link…"),
  );
  expect(f.button("Dismiss").disabled).toBe(false);
  initial.resolve(code("first"));
  await f.ready("first");
  const dialog = f.dialog();
  const refresh = Promise.withResolvers<DevicePairJoinSetup>();
  request.mockReturnValueOnce(refresh.promise);
  f.button("Mint fresh code").click();
  await waitForSolid(() => expect(f.button("Minting…").disabled).toBe(true));
  expect(f.command("first")).not.toBeNull();
  expect(f.dialog()).toBe(dialog);
  refresh.reject(new Error("Connection unavailable"));
  await waitForSolid(() =>
    expect(f.getByRole("alert").textContent).toContain("Connection unavailable"),
  );
  expect(f.command("first")).not.toBeNull();
  request.mockResolvedValueOnce(code("replacement"));
  f.button("Mint fresh code").click();
  await f.ready("replacement");
  expect(f.queryByRole("alert")).toBeNull();
  expect(f.command("first")).toBeNull();
  expect(f.dialog()).toBe(dialog);
});

it.each(["resolve", "reject"] as const)(
  "ignores a dismissed connection's late %s",
  async (outcome) => {
    const f = mountSetup();
    const retired = Promise.withResolvers<DevicePairJoinSetup>();
    const originalRequest = vi
      .spyOn(f.gateway.client, "request")
      .mockReturnValueOnce(retired.promise);
    f.button("Connect").click();
    await waitForSolid(() => expect(originalRequest).toHaveBeenCalledOnce());
    f.button("Dismiss").click();
    await waitForSolid(() => expect(f.dialog()).toBeNull());
    f.gateway.client = new GatewayBrowserClient({ url: "wss://replacement.example.test" });
    const replacement = Promise.withResolvers<DevicePairJoinSetup>();
    const nextRequest = vi
      .spyOn(f.gateway.client, "request")
      .mockReturnValueOnce(replacement.promise);
    f.button("Connect").click();
    await waitForSolid(() => expect(nextRequest).toHaveBeenCalledOnce());
    if (outcome === "resolve") {
      retired.resolve(code("retired-secret"));
    } else {
      retired.reject(new Error("Retired failure"));
    }
    replacement.resolve(code("current-secret"));
    await f.ready("current-secret");
    expect(f.command("retired-secret")).toBeNull();
    expect(f.queryByRole("alert")).toBeNull();
    expect(f.button("Mint fresh code").disabled).toBe(false);
  },
);
