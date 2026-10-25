import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { applyWorkshopDraft, listWorkshopDrafts, saveWorkshopDraft } from "./drafts.js";
import {
  createWorkshopSkill,
  listWorkshopChanges,
  restoreWorkshopSkill,
  viewWorkshopSkill,
} from "./library.js";
import { resolveWorkshopDraftsDir } from "./skills-root.js";

const ctx = { config: {}, agentId: "main", actor: "user" as const };
const skillFile = (name: string, step: string) =>
  `---\nname: ${name}\ndescription: Deploy staging\n---\n\n1. ${step}\n`;

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  await createWorkshopSkill(ctx, {
    name: "deploy",
    content: skillFile("deploy", "Run make deploy."),
  });
});
afterEach(async () => {
  await state.cleanup();
});

it("applies a draft over the live skill as an undoable change and deletes the draft", async () => {
  const id = await saveWorkshopDraft({}, "main", {
    name: "deploy",
    content: skillFile("deploy", "Run make ship."),
    reason: "target was renamed",
  });

  const changes = await applyWorkshopDraft(ctx, id);

  expect(changes).toEqual([
    expect.objectContaining({ action: "write_file", actor: "user", summary: "target was renamed" }),
  ]);
  expect((await viewWorkshopSkill({}, "main", "deploy")).content).toContain("make ship");
  expect(await listWorkshopDrafts({}, "main")).toEqual([]);
  await restoreWorkshopSkill(ctx, { name: "deploy" });
  expect((await viewWorkshopSkill({}, "main", "deploy")).content).toContain("make deploy");
});

it("creates a new skill from a draft with its support files, skipping files already live", async () => {
  // A Doctor export: a draft directory with support files and no recorded reason.
  const draftDir = path.join(resolveWorkshopDraftsDir({}, "main"), "release-notes-proposal");
  await fs.mkdir(path.join(draftDir, "templates"), { recursive: true });
  await fs.writeFile(
    path.join(draftDir, "SKILL.md"),
    skillFile("release-notes", "Group by impact."),
  );
  await fs.writeFile(path.join(draftDir, "templates", "notes.md"), "## Fixes\n");

  const changes = await applyWorkshopDraft(ctx, "release-notes-proposal");

  expect(changes.map((change) => change.action)).toEqual(["create", "write_file"]);
  expect((await viewWorkshopSkill({}, "main", "release-notes", "templates/notes.md")).content).toBe(
    "## Fixes\n",
  );

  // A draft that matches the live skill changes nothing and still leaves the inbox.
  const same = await saveWorkshopDraft({}, "main", {
    name: "deploy",
    content: skillFile("deploy", "Run make deploy."),
  });
  expect(await applyWorkshopDraft(ctx, same)).toEqual([]);
  expect(await listWorkshopDrafts({}, "main")).toEqual([]);
  expect(await listWorkshopChanges("main", {})).toHaveLength(3);
});
