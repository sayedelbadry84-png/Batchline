"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { effectiveSiteId } from "@/lib/siteScope";
import { requeueDeadLetter, dismissDeadLetter, type DeadLetterKind } from "@/lib/deadLetterQueue";

// PL-R12-P2-03, twelfth production-lifecycle review: the operator-facing
// half of the dead-letter path. Thin wrappers only — permission gate,
// site scope, form parsing — with the state transitions and their audit
// events living in src/lib/deadLetterQueue.ts so they are testable
// against real PostgreSQL without a session.
//
// Typed results, not void (see AGENTS.md's own rule): a requeue that
// silently did nothing because the row was already handled by someone
// else is exactly the kind of refusal an operator must be able to see.
export type DeadLetterActionState = { status: "OK" | "NOT_FOUND" | "NOT_DEAD_LETTERED" | "INVALID" } | null;

function parseKind(raw: FormDataEntryValue | null): DeadLetterKind | null {
  return raw === "AUTO_REQUISITION" || raw === "BLOB_DELETION" ? raw : null;
}

export async function requeueDeadLetterAction(_prevState: DeadLetterActionState, formData: FormData): Promise<DeadLetterActionState> {
  const user = await getCurrentUser();
  await requireActionPermission(user, "queues", "requeueDeadLetter");

  const kind = parseKind(formData.get("kind"));
  const id = String(formData.get("id") ?? "");
  if (!kind || !id) return { status: "INVALID" };

  const result = await requeueDeadLetter(kind, id, { id: user!.id, role: user!.role }, effectiveSiteId(user));
  if (result.status === "OK") revalidatePath("/queues");
  return { status: result.status };
}

export async function dismissDeadLetterAction(_prevState: DeadLetterActionState, formData: FormData): Promise<DeadLetterActionState> {
  const user = await getCurrentUser();
  await requireActionPermission(user, "queues", "dismissDeadLetter");

  const kind = parseKind(formData.get("kind"));
  const id = String(formData.get("id") ?? "");
  if (!kind || !id) return { status: "INVALID" };

  const result = await dismissDeadLetter(kind, id, { id: user!.id, role: user!.role }, effectiveSiteId(user));
  if (result.status === "OK") revalidatePath("/queues");
  return { status: result.status };
}
