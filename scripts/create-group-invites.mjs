import { randomBytes, createHash } from "node:crypto";
import { existsSync, writeFileSync, chmodSync } from "node:fs";

const out = ".group-invites.local.json";
if (existsSync(out)) {
  console.error(out + " already exists. Do not overwrite existing credentials.");
  process.exit(1);
}
const token = () => randomBytes(32).toString("hex");
const hashed = text => createHash("sha256").update(text).digest("hex");
const owner = token();
const guest = token();
const data = {
  warning: "PRIVATE: Never commit. Use Wrangler secrets when publishing; invites belong to owners only.",
  xiaochi: { url: "https://chat.io99.xyz/#invite=" + owner,
    hashForSecret: hashed(owner), secretName: "GROUP_XIAOCHI_HASH" },
  xiaolai: { url: "https://chat.io99.xyz/#invite=" + guest,
    hashForSecret: hashed(guest), secretName: "GROUP_XIAOLAI_HASH" }
};
writeFileSync(out, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
try { chmodSync(out, 0o600); } catch {}
console.log("Invitation material generated locally in " + out +
  ". The codes were NOT printed and were NOT uploaded.");
