// Handing an approved plan over to building.

import { envClient } from "../t3/environment";
import { BUILD_THE_PLAN } from "./posture";

/**
 * Tell a plan-mode crew member to build its plan. The order goes first (in default mode), and
 * only once it's accepted does the thread leave plan mode: if the order fails, nothing changed
 * and the plan is still there to approve.
 */
export async function approvePlan(envId: string, threadId: string): Promise<void> {
  const client = envClient(envId);
  if (!client) throw new Error("This station is not connected.");
  await client.order(threadId, BUILD_THE_PLAN, { interactionMode: "default" });
  await client.setInteractionMode(threadId, "default");
}
