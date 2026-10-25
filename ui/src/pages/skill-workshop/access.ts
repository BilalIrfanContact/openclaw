import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { WorkshopMutation } from "./api.ts";

export function resolveWorkshopAccess(snapshot: ApplicationGatewaySnapshot | null | undefined) {
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

export function canRunWorkshopMutation(
  access: ReturnType<typeof resolveWorkshopAccess>,
  method: WorkshopMutation["method"],
): boolean {
  return {
    "skills.workshop.archive": access.canArchive,
    "skills.workshop.restore": access.canRestore,
    "skills.workshop.applyDraft": access.canApplyDraft,
    "skills.workshop.discardDraft": access.canDiscardDraft,
  }[method];
}
