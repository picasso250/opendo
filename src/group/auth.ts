export type Member = "xiaochi" | "xiaolai";

export type GroupSecrets = {
  GROUP_XIAOCHI_HASH?: string;
  GROUP_XIAOLAI_HASH?: string;
};

const encoder = new TextEncoder();
const WEEK_SECONDS = 7 * 86400;
const COOKIE = "group_session";
const COOKIE_PATH = "/api/group";

function hex(bytes: Uint8Array): string {
  return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
}

export async function hashInvite(token: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
  return hex(bytes);
}

function secretFor(member: Member, env: GroupSecrets): string | undefined {
  return member === "xiaochi" ? env.GROUP_XIAOCHI_HASH : env.GROUP_XIAOLAI_HASH;
}

export function secretsConfigured(env: GroupSecrets): boolean {
  return /^[0-9a-f]{64}$/.test(env.GROUP_XIAOCHI_HASH || "") &&
    /^[0-9a-f]{64}$/.test(env.GROUP_XIAOLAI_HASH || "");
}

async function mac(text: string, key: string): Promise<string> {
  const imported = await crypto.subtle.importKey(
    "raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(text))));
}

async function verifyMac(text: string, sig: string, key: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const imported = await crypto.subtle.importKey(
    "raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const bytes = Uint8Array.from(sig.match(/.{2}/g)!.map(x => parseInt(x, 16)));
  return crypto.subtle.verify("HMAC", imported, bytes, encoder.encode(text));
}

export async function roleForInvite(token: unknown, env: GroupSecrets): Promise<Member | null> {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !secretsConfigured(env)) {
    return null;
  }
  const hashed = await hashInvite(token);
  if (hashed === env.GROUP_XIAOCHI_HASH) return "xiaochi";
  if (hashed === env.GROUP_XIAOLAI_HASH) return "xiaolai";
  return null;
}

export async function sessionCookie(role: Member, env: GroupSecrets, now = Date.now()): Promise<string> {
  const key = secretFor(role, env);
  if (!key) throw new Error("group not configured");
  const exp = Math.floor(now / 1000) + WEEK_SECONDS;
  const value = role + "." + exp;
  return COOKIE + "=" + value + "." + await mac(value, key) +
    "; HttpOnly; Secure; SameSite=Strict; Path=" + COOKIE_PATH +
    "; Max-Age=" + WEEK_SECONDS;
}

export function clearCookie(): string {
  return COOKIE + "=; HttpOnly; Secure; SameSite=Strict; Path=" + COOKIE_PATH + "; Max-Age=0";
}

export async function memberFromCookie(request: Request, env: GroupSecrets, now = Date.now()):
  Promise<Member | null> {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.split(";").map(x => x.trim()).find(x => x.startsWith(COOKIE + "="));
  if (!match || !secretsConfigured(env)) return null;
  const values = match.slice(COOKIE.length + 1).split(".");
  if (values.length !== 3) return null;
  const [role, expText, signature] = values;
  if (role !== "xiaochi" && role !== "xiaolai") return null;
  if (!/^\d{10}$/.test(expText)) return null;
  const exp = Number(expText);
  const nowSeconds = Math.floor(now / 1000);
  if (exp < nowSeconds || exp > nowSeconds + WEEK_SECONDS) return null;
  const key = secretFor(role, env);
  if (!key) return null;
  return await verifyMac(role + "." + expText, signature, key) ? role : null;
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // Non-browser clients still need a valid member cookie.
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}
