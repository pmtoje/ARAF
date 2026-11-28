"use server";
import { requireUser } from "../_lib/auth";
import { markReturnPromptsSeen } from "@/server/domain/return-prompts";

export async function markReturnPromptsSeenAction(correctionIds: string[]) {
  const { ctx } = await requireUser({ touch: false });
  await markReturnPromptsSeen(ctx, Array.isArray(correctionIds) ? correctionIds.map(String) : []);
}
