import { checkAdmin } from "../../../admin-access";
import exportScript from "../../../admin-photo-export.js?raw";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await checkAdmin(request);
  if (denied) return denied;
  return new Response(exportScript, {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
