/** Publish the public, stand-alone WorkBuddy integration guide from one source of truth.
 * No logins, private config, API keys or invite URLs are included.
 */
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const input=fileURLToPath(new URL('../docs/worker-adapter.md',import.meta.url));
const output=fileURLToPath(new URL('../public/workbuddy.md',import.meta.url));
const canonical='https://chat.io99.xyz/workbuddy.md';
const original=(await readFile(input,'utf8')).split(String.fromCharCode(13)).join('');
if(!original.startsWith('# Build a Worker Adapter / 第三方 Agent Runner 接入指南\n'))
  throw Error('Worker adapter guide heading changed; update public generator intentionally');

// Remove GitHub-relative source links: the public guide must stand on its own
// for agents and people who cannot access github.com.
const standalone=original
  .replace(/^# Build a Worker Adapter \/ 第三方 Agent Runner 接入指南\s*/, '')
  .replace(/Read \[`src\/group\/room\.ts`\]\(\.\.\/src\/group\/room\.ts\), \[`src\/group\/task-contract\.ts`\]\(\.\.\/src\/group\/task-contract\.ts\), and \[`scripts\/runner\.mjs`\]\(\.\.\/scripts\/runner\.mjs\) if you need the authoritative behavior\./,
    'The complete current V1 protocol contract is described below; no GitHub access is required to implement the adapter.');
const intro=`# OpenDo × WorkBuddy 接入说明书（小赖版）

> **公开 Markdown，任何人和 AI Agent 均可直接读取，无需登录或访问 GitHub。** 规范地址：${canonical}
>
> OpenDo 是内部项目代号；本文是 Worker 协议说明，不是 WorkBuddy 官方 CLI 文档。

## 直接交给 WorkBuddy 的任务

请阅读此文档，研究**本机实际安装的 WorkBuddy 版本**是否具有受支持的非交互执行接口（CLI/API）。如果有，请实现一个独立的 OpenDo Worker Runner，将真实 WorkBuddy 执行过程接入下面的 HTTP 协议；如果没有，请明确报告限制，不要猜测命令或伪造执行结果。

**第一阶段目标：** 先用本机配置在一个可信测试目录完成单任务：发布执行配置 → 领取 Task → 调用真正的 WorkBuddy → 心跳 → 回传原始结果。无需修改 OpenDo 的服务端，也无需改动 Codex 或 DSH Runner。

基础地址：\`https://chat.io99.xyz\`，Worker API：\`https://chat.io99.xyz/api/worker/{configs|claim|heartbeat|complete}\`。**所有接口均需独立 Worker Token**；必须先由小赖以自己的邀请身份登录群聊，点击“+ Worker”注册。公开文档**不包含**任何邀请码、Token 或个人密钥；不要在聊天里索要或发送这些秘密。

本文下面是完整 V1 接入协议，可直接作为开发上下文。

---

## 完整 Worker 协议（V1）

`;
const result=intro+standalone.trimStart().replace(/\s+$/,'')+'\n';
if(result.length<8000 || !result.includes('POST /api/worker/claim') ||
   !result.includes('POST /api/worker/complete')) throw Error('Generated guide seems incomplete');
await writeFile(output,result,'utf8');
console.log('Generated public/workbuddy.md from docs/worker-adapter.md ('+result.length+' characters)');
