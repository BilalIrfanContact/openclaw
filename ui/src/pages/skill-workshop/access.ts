import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { WorkshopMutation } from "./api.ts";

export type SkillWorkshopAccess = {
  canArchive: boolean;
  canRestore: boolean;
  canApplyDraft: boolean;
  canDiscardDraft: boolean;
  canSetMode: boolean;
};

export function canRunWorkshopMutation(
  access: SkillWorkshopAccess,
  method: WorkshopMutation["method"],
): boolean {
  return {
    "skills.workshop.archive": access.canArchive,
    "skills.workshop.restore": access.canRestore,
    "skills.workshop.applyDraft": access.canApplyDraft,
    "skills.workshop.discardDraft": access.canDiscardDraft,
  }[method];
}

export function resolveWorkshopAccess(
  snapshot: ApplicationGatewaySnapshot | null | undefined,
): SkillWorkshopAccess {
  return {
    canArchive: canCallGatewayMethod(snapshot, "skills.workshop.archive", "operator.admin"),
    canRestore: canCallGatewayMethod(snapshot, "skills.workshop.restore", "operator.admin"),
    canApplyDraft: canCallGatewayMethod(snapshot, "skills.workshop.applyDraft", "operator.admin"),
    canDiscardDraft: canCallGatewayMethod(
      snapshot,
      "skills.workshop.discardDraft",
      "operator.admin",
    ),
    canSetMode: canCallGatewayMethod(snapshot, "config.patch", "operator.admin"),
  };
}
