import { toolRegistry } from "@/lib/agent/tools";
import { handler, json, requireAuth } from "@/lib/http";

export const GET = handler(async (req) => {
  await requireAuth(req);
  return json(toolRegistry.describe());
});
