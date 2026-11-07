import { getAgentByName } from "agents";
import {
  roleForInvite, sessionCookie, memberFromCookie, clearCookie,
  sameOrigin, secretsConfigured, type GroupSecrets
} from "./group/auth.ts";

export { GroupRoom } from "./group/room.ts";

type GroupOnlyEnv = Env & GroupSecrets;

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: HEADERS });
}

export async function groupEndpoint(request: Request, env: GroupOnlyEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!secretsConfigured(env)) {
    return json({ error: "群聊尚未配置，请等待正式发布" }, 503);
  }
  if (!sameOrigin(request)) return json({ error: "跨域请求不被允许" }, 403);

  if (path === "/api/group/auth" && request.method === "POST") {
    if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
      return json({ error: "仅接受 JSON" }, 415);
    }
    if (Number(request.headers.get("Content-Length") || 0) > 4096) {
      return json({ error: "邀请码过长" }, 413);
    }
    const body = await request.text();
    if (body.length > 4096) return json({ error: "邀请码过长" }, 413);
    let code: unknown = null;
    try { code = (JSON.parse(body) as Record<string, unknown>).code; } catch {}
    const member = await roleForInvite(code, env);
    if (!member) return json({ error: "邀请码不正确" }, 401);
    const response = json({ member });
    response.headers.set("Set-Cookie", await sessionCookie(member, env));
    return response;
  }

  if (path === "/api/group/logout" && request.method === "POST") {
    const response = json({ ok: true });
    response.headers.set("Set-Cookie", clearCookie());
    return response;
  }

  const member = await memberFromCookie(request, env);
  if (!member) return json({ error: "请使用自己的专属邀请链接进入" }, 401);
  if (path === "/api/group/me" && request.method === "GET") {
    return json({ member });
  }

  if (path === "/api/group/ws" && request.method === "GET") {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "需要 WebSocket 连接" }, 426);
    }
    const forwarded = new Request(request);
    // Overwrite any client-forged identity header. Agent trusts ONLY this header
    // after the Worker has authenticated the HttpOnly cookie.
    forwarded.headers.set("x-group-member", member);
    const agent = await getAgentByName(env.GroupRoom, "xiaochi-xiaolai-ds-v1");
    return agent.fetch(forwarded);
  }
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: GroupOnlyEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, service: "ds-private-group", version: 2 });
    }
    // Separate machine-to-machine credential from human cookie sessions.
    // Each route is authenticated again inside the Durable Object.
    if (url.pathname.startsWith("/api/worker/")) {
      if(request.method!=="POST")return json({error:"method_not_allowed"},405);
      if(Number(request.headers.get("content-length")||0)>1_200_000)
        return json({error:"payload_too_large"},413);
      // Buffer the bounded body before forwarding across the DO boundary;
      // never pass a client-owned live stream to a hibernatable Agent.
      const body=await request.arrayBuffer();
      if(body.byteLength>1_200_000)return json({error:"payload_too_large"},413);
      const forwarded=new Request(request.url,{method:"POST",headers:{
        "Authorization":request.headers.get("Authorization")||"",
        "Content-Type":"application/json"
      },body});
      const agent=await getAgentByName(env.GroupRoom,"xiaochi-xiaolai-ds-v1");
      return agent.fetch(forwarded);
    }
    if (url.pathname.startsWith("/api/group/")) {
      return groupEndpoint(request, env);
    }
    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<GroupOnlyEnv>;
