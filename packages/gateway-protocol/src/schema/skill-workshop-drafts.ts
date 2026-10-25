import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** A proposed skill waiting for review in `.drafts/`; never loaded as a skill. */
export const SkillWorkshopDraftSchema = closedObject({
  id: NonEmptyString,
  /** The skill this draft creates or replaces. */
  skillName: NonEmptyString,
  /** Why the review proposed it, or the drafted skill's description when no reason was saved. */
  summary: Type.String(),
  createdAtMs: Type.Number({ minimum: 0 }),
});

/**
 * `skills.workshop.applyDraft` saves the draft's files as the live skill through versioned
 * writes; `skills.workshop.discardDraft` changes no skill. Both delete the draft and answer with
 * the changes made, as `SkillsWorkshopChangesResult`.
 */
export const SkillsWorkshopDraftParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  draftId: NonEmptyString,
});

export type SkillWorkshopDraft = Static<typeof SkillWorkshopDraftSchema>;
export type SkillsWorkshopDraftParams = Static<typeof SkillsWorkshopDraftParamsSchema>;
