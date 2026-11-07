import { DEFAULT_DS_PERSONA, DEFAULT_DOUBAO_PERSONA } from "./persona-defaults.generated.ts";

export type HumanId = "xiaochi" | "xiaolai";
export type Provider = "deepseek" | "volcengine";
export type AIRecord = {
  id: string;
  owner: HumanId;
  name: string;
  provider: Provider;
  model_id: string;
  persona: string;
  encrypted_key: string | null;
  enabled: number;
  created_at: number;
};

export { DEFAULT_DS_PERSONA, DEFAULT_DOUBAO_PERSONA };
export const MAX_AI_PER_HUMAN = 3;
export const MAX_PERSONA_LENGTH = 12000;

export function publicAI(ai: AIRecord) {
  return {
    id: ai.id, kind: "ai" as const, owner: ai.owner, name: ai.name,
    provider: ai.provider, modelId: ai.model_id, persona: ai.persona,
    enabled: Boolean(ai.enabled), hasKey: Boolean(ai.encrypted_key),
    builtin: ai.id === "ds"
  };
}

export function readAIInput(raw: unknown, editing = false) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("AI 设置无效");
  const x = raw as Record<string, unknown>;
  if (typeof x.name !== "string" || !x.name.trim() || x.name.trim().length > 24)
    throw new Error("名称应为 1–24 字");
  if (x.provider !== "deepseek" && x.provider !== "volcengine")
    throw new Error("模型服务商只能是 DeepSeek 或火山方舟");
  if (typeof x.modelId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,119}$/.test(x.modelId.trim()))
    throw new Error("请填写正确的模型 ID");
  if (typeof x.persona !== "string" || !x.persona.trim() ||
      x.persona.length > MAX_PERSONA_LENGTH) throw new Error("人格文字应为 1–12000 字");
  if (x.apiKey !== undefined && (typeof x.apiKey !== "string" ||
     x.apiKey.length > 2048 || (x.apiKey.length > 0 && x.apiKey.trim() !== x.apiKey)))
    throw new Error("API Key 格式不正确");
  if (!editing && (!x.apiKey || typeof x.apiKey !== "string"))
    throw new Error("请填写你自己的 API Key");
  return {
    name: x.name.trim(),
    provider: x.provider,
    model_id: x.modelId.trim(),
    persona: x.persona.trim(),
    apiKey: typeof x.apiKey === "string" ? x.apiKey : ""
  };
}

function encryptionBytes(secret: string | undefined): Uint8Array {
  if (!secret) throw new Error("AI 加密密钥尚未配置");
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(secret), x => x.charCodeAt(0)); }
  catch { throw new Error("AI 加密密钥无效"); }
  if (bytes.length !== 32) throw new Error("AI 加密密钥必须为 32 字节");
  return bytes;
}

async function aesKey(secret: string | undefined, usage: KeyUsage) {
  return crypto.subtle.importKey(
    "raw", Uint8Array.from(encryptionBytes(secret)), { name: "AES-GCM" }, false, [usage]
  );
}

export async function encryptAPIKey(key: string, secret: string | undefined): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, await aesKey(secret, "encrypt"),
    new TextEncoder().encode(key)
  ));
  return "v1." + btoa(String.fromCharCode(...iv)) + "." +
    btoa(String.fromCharCode(...ciphertext));
}

export async function decryptAPIKey(value: string, secret: string | undefined): Promise<string> {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("不支持的密钥格式");
  const iv = Uint8Array.from(atob(parts[1]), c => c.charCodeAt(0));
  const data = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0));
  if (iv.length !== 12) throw new Error("密钥损坏");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv }, await aesKey(secret, "decrypt"), data
  );
  return new TextDecoder().decode(plaintext);
}
