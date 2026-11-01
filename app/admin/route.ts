import { checkAdmin } from "../admin-access";
import { chatGPTSignInPath } from "../chatgpt-auth";
import { adminHtml } from "../admin-html";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const denied = await checkAdmin(request);
    if (denied?.status === 401) return Response.redirect(new URL(chatGPTSignInPath("/admin"), request.url), 302);
    if (denied) return new Response("此账号没有照片管理权限，请使用网站所有者的 ChatGPT 账号登录。", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    return new Response(adminHtml, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Unable to open photo admin", error);
    return new Response("照片后台暂时不可用，请稍后重试。", { status: 503 });
  }
}
