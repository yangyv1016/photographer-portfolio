import { env } from "cloudflare:workers";
import { getChatGPTUser } from "./chatgpt-auth";

export async function checkAdmin(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "请先使用 ChatGPT 登录。" }, { status: 401 });
  if (!env.ADMIN_EMAIL) throw new Error("ADMIN_EMAIL is not configured.");
  if (user.email.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()) {
    return Response.json({ error: "此账号没有照片管理权限。" }, { status: 403 });
  }
  if (request.method !== "GET" && request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "请从本站后台执行此操作。" }, { status: 403 });
  }
  return null;
}
