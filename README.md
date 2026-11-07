# OpenDo

**不同的声音，同一场对话。** 让人类、聊天 AI 和本地执行任务的 Agent 在同一个房间里协作。

OpenDo 是项目的**临时代号**，不是已经确定的正式品牌。当前版本是一套自托管的私人群聊原型，而不是提供给陌生人直接注册的公共 SaaS。前端使用「人类 / AI / Worker」成员列表；Router AI 可自主讨论、调用 `list_workers` / `create_task` / `get_task`，再让本机 Runner 完成实际工作。

> Different minds, one conversation, real work. The Worker protocol is intentionally independent of any specific agent harness.

## Architecture

```text
Humans ── WebSocket ──────┐
Chat AIs / Routers ───────┤  Cloudflare Worker + Durable Object (SQLite)
                         │         │
                         │   Task + selected configuration ID
                         │         ▼
                         └── HTTPS Worker API ◀── Local Runner ── Codex / other harness
                                     │
                             Raw result + status
```

- **人类（Human）**：目前是两位受邀请的房间成员，拥有各自的登录凭证。
- **AI / Router**：聊天、独立判断、三轮讨论；根据 Worker 描述和可用执行配置自主派发 Task。
- **Worker**：房间中登记的执行资源，持有独立的、只显示一次的 Token。
- **Runner**：用户自己电脑上运行的客户端；它配置真实的 Harness、模型、权限与工作目录。
- **Harness**：实际完成任务的 Agent，例如当前已经验证的 Codex；其他 Harness 可实现相同 HTTPS 协议。

本项目不提供远程任意 shell 接口。Task 不能指定执行命令、工作目录、沙箱开关或提权选项。

## Quick start · 本地开发

需要 Node.js、npm、Cloudflare Wrangler；部署需要自己的 Cloudflare 账号和模型服务 API Key。

```bash
npm install
npm run generate:invites
```

将 `scripts/create-group-invites.mjs` 生成的房间身份哈希配置到**不入库**的 `.dev.vars`，并提供自己的 `DEEPSEEK_API_KEY`、`AI_KEY_ENCRYPTION_SECRET`。后者是 Base64 编码的 32 字节加密密钥；不要公开或随意轮换，否则已加密存储的 AI Key 将无法解密。

```bash
npm run dev       # http://localhost:8787
npm run check     # TypeScript + tests + Cloudflare dry-run
```

访问本地地址并使用专属邀请链接登录。代码中仍有与双人私人群聊有关的命名、固定房间和部署参数；如果要自托管，请先理解并调整这些配置。生产部署前，在 Cloudflare 设置 `wrangler.jsonc` 所声明的全部必需 Secrets；`npm run deploy` 将发布到你自己配置的域名。

## Running a Worker

1. 登录自己的群聊，点击 **+ Worker**，填写名称、能力描述并复制一次性的 Worker Token。
2. 在本机安装并登录 Codex CLI；将工作目录限制为自己信任的项目。
3. 将 `runner.example.json` 复制为被 Git 忽略的 `runner.local.json`，按本机可用模型修改执行配置。
4. 启动 `scripts/runner.mjs`（Windows PowerShell 示例）：

```powershell
$env:DSGO_URL = 'http://localhost:8787'
$env:DSGO_WORKER_TOKEN = '在本地群聊注册得到的 Token'
$env:DSGO_WORKDIR = (Get-Location).Path
node scripts/runner.mjs
```

Runner 公布本机模型配置目录，Router 只能选择实际公布的 `execution_config_id`。不指定配置时，由 Worker 本机默认值决定。Codex Runner 默认启用 `workspace-write` 沙箱；**不要在含有个人秘密的机器上启用不受沙箱保护的模式**。在生产环境接入时，将 `DSGO_URL` 指向自己部署的服务，并使用该服务注册生成的 Token。

## Build another Agent Runner / 接入 WorkBuddy

**[Worker Adapter Guide — docs/worker-adapter.md](docs/worker-adapter.md)** describes the complete HTTPS contract, examples, Task state transitions, claim leases, result semantics, security requirements, and the minimal acceptance test. An independent WorkBuddy runner can be built without modifying the Cloudflare server or Codex Runner, provided WorkBuddy has a usable local execution interface.

More protocol details: [docs/tasks.md](docs/tasks.md).

## Security and limits

- Never commit `.dev.vars`, personal invites, Worker bearer tokens, model API keys, local logs or `runner.local.json`.
- Workers receive **only their claimed Task**, not the entire chat history.
- Only the registering human can edit or delete their Worker. Tokens are stored server-side as hashes and shown once.
- Tasks expire after 30 minutes; the first version deliberately has no automatic requeue, process reattachment or remote arbitrary command execution.
- The Worker must treat Router instructions as untrusted input and enforce its **own** permissions, timeout, and workspace boundaries.

The project is experimental software. Review the source, security model and Cloudflare costs before deploying.

## Development

`npm run check` runs TypeScript checks, automated tests and `wrangler deploy --dry-run`. `npm run deploy` performs a real deployment. Keep production secrets out of Git and do not publish private room exports or local Runner state.

## License

[MIT License](LICENSE). OpenDo is a temporary development name; its final brand may change.
