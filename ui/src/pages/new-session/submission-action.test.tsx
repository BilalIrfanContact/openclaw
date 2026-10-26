import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createSubmissionAction, type SubmissionPresentation } from "./submission-action.ts";

async function mountPresentation(destinationReady?: () => void) {
  let lifetime = Promise.withResolvers<void>();
  const owner: SubmissionPresentation = {
    get submissionLifetime() {
      return lifetime.promise;
    },
  };
  let retire!: () => void;
  function Destination() {
    onSettled(() => destinationReady?.());
    return <h1>Chat</h1>;
  }
  const view = mountSolid(() => {
    const [revision, publish] = createSignal(0);
    const [message, setMessage] = createSignal("Original draft");
    retire = () => {
      lifetime.resolve();
      lifetime = Promise.withResolvers<void>();
      publish((value) => value + 1);
      setMessage("Replacement draft");
    };
    const outcome = createMemo(() =>
      destinationReady ? (message() === "Replacement draft" ? "Chat" : "Draft") : message(),
    );
    const saving = createSubmissionAction(
      () => owner,
      revision,
      outcome,
      (error) => {
        if (destinationReady) {
          throw error;
        }
        setMessage(String(error));
      },
    );
    return (
      <>
        <span role="status">{saving() ? "Starting" : "Ready"}</span>
        <Show
          when={destinationReady && message() === "Replacement draft"}
          fallback={destinationReady ? <h1>Draft</h1> : <p>{outcome()}</p>}
        >
          <Destination />
        </Show>
      </>
    );
  });
  await waitForSolid(() => expect(owner.presentSubmit).toBeTypeOf("function"));
  return {
    ...view,
    start: (operation: () => Promise<void>) => owner.presentSubmit!(operation),
    status: (text: string) =>
      waitForSolid(() => expect(view.getByRole("status").textContent).toBe(text)),
    retire,
  };
}

it("releases the presentation before waiting for the destination to commit", async () => {
  const created = Promise.withResolvers<void>();
  const destinationReady = Promise.withResolvers<void>();
  const view = await mountPresentation(() => destinationReady.resolve());
  let operationFinished = false;
  const presenting = view.start(async () => {
    await created.promise;
    // Retire before the destination commits; waiting for its DOM must not deadlock.
    view.retire();
    await destinationReady.promise;
    operationFinished = true;
  });
  await view.status("Starting");
  created.resolve();
  await presenting;
  await waitForSolid(() => {
    expect(view.getByRole("heading").textContent).toBe("Chat");
    expect(view.getByRole("status").textContent).toBe("Ready");
    expect(operationFinished).toBe(true);
  });
});

it.each(["awaited", "fire-and-forget"])(
  "preserves a replacement outcome when a retired %s operation rejects",
  async (invocation) => {
    const pending = Promise.withResolvers<void>();
    const view = await mountPresentation();
    const presenting = view.start(() => pending.promise);
    await view.status("Starting");
    view.retire();
    await view.status("Ready");
    const rejection =
      invocation === "awaited"
        ? expect(presenting).rejects.toThrow("Old submission failed")
        : undefined;
    pending.reject(new Error("Old submission failed"));
    await rejection;
    // Vitest must observe unhandled fire-and-forget rejections on their own turn.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await waitForSolid(() => {
      expect(view.getByRole("status").textContent).toBe("Ready");
      expect(view.getByText("Replacement draft")).toBeDefined();
    });
  },
);
