import { expect, it, onTestFinished, vi } from "vitest";
import { scheduleStaleChunkReload } from "../../app/stale-chunk-reload.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { removeQueuedMessage } from "./chat-queue.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

it("retains memory-only pending input across automatic reloads after its pane and account retire", async () => {
  // Only message persistence fails: the reload-loop guard can still be stored.
  const write = sessionStorage.setItem.bind(sessionStorage);
  vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
    if (key.startsWith("openclaw.control.chatComposer.v4:")) {
      throw new DOMException("Synthetic outbox quota", "QuotaExceededError");
    }
    write(key, value);
  });
  const host = makeChatHost({
    chatMessage: "Keep the only copy of this pending message",
    requestHandlers: {
      "chat.send": () => {
        throw new Error("gateway closed (1006)");
      },
    },
  });
  let account = "reload-original-account";
  vi.spyOn(host.client!, "recoveryScope", "get").mockImplementation(() => account);
  const owner = chatOutboxOwner(host);
  const stop = owner.subscribe(host);
  onTestFinished(stop);
  await handleSendChat(host);
  const pending = host.chatQueue[0]!;
  expect(pending).toMatchObject({
    text: "Keep the only copy of this pending message",
    sendState: "waiting-reconnect",
  });
  expect(host.chatMessage).toBe("");
  expect(listStoredChatOutboxes(host)).toEqual([]);
  stop();
  account = "reload-other-account";
  chatOutboxOwner(host).syncHost(host);
  expect(host.chatQueue).toEqual([]);
  const reload = vi.fn();
  const probe = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", probe);
  expect(await scheduleStaleChunkReload({ reload })).toBe(false);
  expect(reload).not.toHaveBeenCalled();
  expect(probe).not.toHaveBeenCalled();
  account = "reload-original-account";
  owner.syncHost(host);
  expect(host.chatQueue[0]).toMatchObject({
    id: pending.id,
    text: pending.text,
    sendRunId: pending.sendRunId,
  });
  removeQueuedMessage(host, pending.id, { discard: true });
  expect(await scheduleStaleChunkReload({ reload })).toBe(true);
  expect(reload).toHaveBeenCalledOnce();
});
