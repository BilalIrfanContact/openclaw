import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiMockSameOriginGatewayScript } from "../test-helpers/control-ui-e2e.ts";
import { requireString } from "./chat-flow.test-support.ts";
import { readOutboxQueue } from "./chat-outbox-payloads.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const retainedText = "Keep this pending message and its attachment during an update.";
const sessionKey = "agent:main:pending-update";
const file = {
  name: "pending-note.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("Exact synthetic pending attachment bytes."),
};

suite.define(() => {
  it("holds automatic stale-build recovery for a rejected first turn kept only in memory", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
        await page.addInitScript(() => {
          const setItem = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")
            ?.value as Storage["setItem"];
          Storage.prototype.setItem = function (key: string, value: string) {
            // Reject pending-message payloads, not sessionStorage itself or saved drafts.
            if (key.startsWith("openclaw.control.chatComposer.v4:") && value.includes('"queue":')) {
              throw new DOMException("Synthetic pending payload quota", "QuotaExceededError");
            }
            return setItem.call(this, key, value);
          };
        });
        const gateway = await installMockGateway(page, {
          sessions: [{ key: sessionKey, label: "Pending input", kind: "direct", updatedAt: 1 }],
        });
        await page.goto(suite.server.baseUrl + "new?agent=main");
        await page.locator(".new-session-page__message").fill(retainedText);
        await page.locator(".agent-chat__file-input").setInputFiles(file);
        await page.getByText(file.name, { exact: true }).first().waitFor();
        await gateway.deferNext("sessions.create");
        await page.getByRole("button", { name: "Start session", exact: true }).click();
        const created = await gateway.waitForRequest("sessions.create");
        expect(created.params).toMatchObject({
          message: retainedText,
          attachments: [{ fileName: file.name, content: file.buffer.toString("base64") }],
        });
        await gateway.resolveDeferred("sessions.create", {
          key: sessionKey,
          runStarted: false,
          runError: { code: "INVALID_REQUEST", message: "Synthetic initial turn rejected" },
        });
        await waitForCommittedChatRoute(page);
        const pending = page.locator(".chat-group.user", { hasText: retainedText });
        await pending.getByText("Not sent", { exact: true }).waitFor();
        expect(await readOutboxQueue(page)).toEqual([]);
        expect(
          await page.evaluate(() => {
            sessionStorage.setItem("qa.reload-storage-control", "works");
            return sessionStorage.getItem("qa.reload-storage-control");
          }),
        ).toBe("works");
        let reloads = 0;
        page.on("domcontentloaded", () => {
          reloads += 1;
        });
        await gateway.setOnline(false);
        await gateway.deferNext("connect");
        const previous = (await gateway.getRequests("connect")).length;
        await gateway.setOnline(true);
        await gateway.waitForRequest("connect", { after: previous });
        await page.clock.install();
        const navigation = page.waitForEvent("domcontentloaded").then(() => "reloaded" as const);
        await gateway.rejectDeferred("connect", {
          code: "UNAVAILABLE",
          message: "protocol mismatch: Control UI updated; reload this page to continue",
          details: {
            code: "PROTOCOL_MISMATCH",
            gatewayBuildId: "pending-input-replacement-build",
            reloadRequired: true,
          },
          retryable: false,
        });
        const refresh = page.getByRole("button", { name: /Server updated/u });
        const blocked = page.getByText(
          "A pending message is only saved in this tab. Keep this tab open until it is sent, or copy it before discarding it and reloading.",
          { exact: true },
        );
        const outcome = await Promise.race([
          navigation,
          (async () => {
            // Exercise the automatic build-recovery timer before requesting Refresh.
            await page.clock.runFor(2001).catch((error: unknown) => {
              if (reloads === 0) {
                throw error;
              }
            });
            await refresh.click();
            await blocked.waitFor();
            return "held" as const;
          })(),
        ]);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const content =
            outcome === "held"
              ? [pending, blocked]
              : [page.locator(".agent-chat__composer-combobox textarea")];
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("openclaw-app"),
            content,
            { animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, outcome + ".png"), frame.png);
        }
        expect(outcome, "automatic document recovery must not drop the only pending copy").toBe(
          "held",
        );
        expect(reloads).toBe(0);
        await pending.getByText(file.name, { exact: true }).first().waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        // Update-required mode locks controls; inspect the actual rendered Blob without
        // changing that policy or claiming an unavailable UI download succeeded.
        const href = requireString(
          await pending
            .getByRole("link", { name: "Download pending-note.txt", exact: true })
            .getAttribute("href"),
          "retained attachment URL",
        );
        const bytes = await page.evaluate(
          async (url) => [...new Uint8Array(await (await fetch(url)).arrayBuffer())],
          href,
        );
        expect(Buffer.from(bytes)).toEqual(file.buffer);
      },
    );
  });
});
