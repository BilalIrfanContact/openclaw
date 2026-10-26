import { createMemo, createSignal } from "solid-js";
import { expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createSubmissionAction, type SubmissionPresentation } from "./submission-action.ts";

it.each(["awaited", "fire-and-forget"])(
  "preserves a replacement outcome when a retired %s operation rejects",
  async (invocation) => {
    let lifetime = Promise.withResolvers<void>();
    const owner: SubmissionPresentation = {
      get submissionLifetime() {
        return lifetime.promise;
      },
    };
    const pending = Promise.withResolvers<void>();
    let retire!: () => void;
    const view = mountSolid(() => {
      const [revision, publish] = createSignal(0);
      const [message, setMessage] = createSignal("Original draft");
      const outcome = createMemo(message);
      const saving = createSubmissionAction(
        () => owner,
        revision,
        outcome,
        (error) => setMessage(String(error)),
      );
      retire = () => {
        lifetime.resolve();
        lifetime = Promise.withResolvers<void>();
        publish((value) => value + 1);
        setMessage("Replacement draft");
      };
      return (
        <>
          <span role="status">{saving() ? "Starting" : "Ready"}</span>
          <p>{outcome()}</p>
        </>
      );
    });
    await waitForSolid(() => expect(owner.presentSubmit).toBeTypeOf("function"));
    const presenting = owner.presentSubmit!(() => pending.promise);
    await waitForSolid(() => expect(view.getByRole("status").textContent).toBe("Starting"));
    retire();
    await waitForSolid(() => expect(view.getByRole("status").textContent).toBe("Ready"));
    const rejection =
      invocation === "awaited"
        ? expect(presenting).rejects.toThrow("Old submission failed")
        : undefined;
    pending.reject(new Error("Old submission failed"));
    await rejection;
    // Give fire-and-forget rejection reporting its own turn. Vitest fails on an unhandled promise.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await waitForSolid(() => {
      expect(view.getByRole("status").textContent).toBe("Ready");
      expect(view.getByText("Replacement draft")).toBeDefined();
    });
  },
);
