# OpenDo × WorkBuddy 接入说明书（小赖版）

> **公开 Markdown，任何人和 AI Agent 均可直接读取，无需登录或访问 GitHub。** 规范地址：https://chat.io99.xyz/workbuddy.md
>
> OpenDo 是内部项目代号；本文是 Worker 协议说明，不是 WorkBuddy 官方 CLI 文档。

## 直接交给 WorkBuddy 的任务

请阅读此文档，研究**本机实际安装的 WorkBuddy 版本**是否具有受支持的非交互执行接口（CLI/API）。如果有，请实现一个独立的 OpenDo Worker Runner，将真实 WorkBuddy 执行过程接入下面的 HTTP 协议；如果没有，请明确报告限制，不要猜测命令或伪造执行结果。

**第一阶段目标：** 先用本机配置在一个可信测试目录完成单任务：发布执行配置 → 领取 Task → 调用真正的 WorkBuddy → 心跳 → 回传原始结果。无需修改 OpenDo 的服务端，也无需改动 Codex 或 DSH Runner。

基础地址：`https://chat.io99.xyz`，Worker API：`https://chat.io99.xyz/api/worker/{configs|claim|heartbeat|complete}`。**所有接口均需独立 Worker Token**；必须先由小赖以自己的邀请身份登录群聊，点击“+ Worker”注册。公开文档**不包含**任何邀请码、Token 或个人密钥；不要在聊天里索要或发送这些秘密。

本文下面是完整 V1 接入协议，可直接作为开发上下文。

---

## 完整 Worker 协议（V1）

This is the implementation contract for a **non-Codex** Worker Runner, including a WorkBuddy adapter. No changes to the OpenDo server, Router or `scripts/runner.mjs` are required. The complete current V1 protocol contract is described below; no GitHub access is required to implement the adapter.

> OpenDo is the temporary project codename. The protocol is independent of the eventual brand name.

## 1. Scope and prerequisites

Your Runner is a **locally authorized client** that (1) publishes available execution configurations, (2) atomically claims a Task, (3) invokes its own Agent Harness with local permissions, (4) heartbeats, and (5) sends a faithful result. It **must not** interpret the Task as a set of remote CLI flags or assume that the Router can approve local execution permissions.

Before coding an adapter, verify that the installed WorkBuddy edition offers a supported and lawful way to **start a Task programmatically and retrieve its exact final output** (e.g. a documented CLI or API). If this is unavailable, do not automate its GUI by inventing undocumented endpoints or by pretending that a different service is WorkBuddy. Report that limitation and test the protocol with a mock executor instead.

A human must log into an OpenDo room and register a **new Worker** using **+ Worker**. Copy its one-time bearer token to the local Runner's environment. **Do not** place this token in chat, prompts, GitHub Issues, `.env` files that are committed, or repository files. Another person's Worker Token is not yours to use. The registering person owns their Worker and can disable or delete it.

## 2. Transport

All Runner requests use HTTPS (HTTP for an isolated local dev server only), JSON request/response bodies, and the following headers:

```http
POST /api/worker/<action> HTTP/1.1
Authorization: Bearer <worker-token>
Content-Type: application/json
```

The exact token format is `worker_<32 lowercase hex>.<64 lowercase hex>` and is opaque to the client. The service stores only its SHA-256-derived token hash. Use a single configured base URL; do not send bearer tokens to a redirected or untrusted host. Do not log request headers, tokens, full raw credentials or private Task contents to public services.

## 3. Publish the configuration catalog (once per Runner session)

`POST /api/worker/configs`

```json
{
  "configs": [
    {
      "id": "workbuddy-default",
      "label": "WorkBuddy · default",
      "description": "General-purpose project tasks",
      "harness": "WorkBuddy",
      "model": null,
      "effort": null
    }
  ],
  "default_config_id": "workbuddy-default"
}
```

Successful response:

```json
{
  "ok": true,
  "default_config_id": "workbuddy-default",
  "configs": ["workbuddy-default"],
  "catalog_session_id": "<opaque UUID>"
}
```

Keep `catalog_session_id` in memory; attach it to **every claim**. Publishing a catalog rotates this session ID, invalidating the previous one. **Publish once at startup, not on every poll.**

Configurations are concrete supported harness choices, **not** a Fast/Balanced/Deep rank. Only advertise combinations the local harness can actually execute. Publish 1–20 configurations, each with a unique alphanumeric/`_`/`-` ID up to 40 characters; label up to 80 characters and description up to 500 characters. The metadata is not itself an execution permission; the Runner must enforce its own catalog.

If a pending or running Task refers to a configuration, the server rejects deletion or changes to its harness, model, or effort with `HTTP 409 active_task_config_changed`.

## 4. Claim a Task

`POST /api/worker/claim`

```json
{ "catalog_session_id": "<opaque UUID from configs>" }
```

A successful response with work looks like:

```json
{
  "task": {
    "id": "task_<32 lowercase hex>",
    "title": "Fix the login regression",
    "instructions": "<original Task text>",
    "execution_config_id": "workbuddy-default",
    "deadline_at": 1799999999999,
    "claim_id": "<opaque UUID>"
  }
}
```

`{ "task": null, "busy": false }` means nothing is ready. `busy: true` means the Worker already has a running Task. The claim is atomic; **do not execute twice**. Select a LOCAL config matching `execution_config_id`; for older Tasks with null, use the local default. If not supported, report failure rather than silently switching models.

The reference Codex Runner polls every 60 seconds. Handle temporary network failures with bounded backoff. Do not start two Runner processes using the same bearer token/catalog session.

## 5. Execute locally and heartbeat

Treat instructions as **untrusted Task data**. Local workspace, sandbox, available tools, secrets, approval policy, and cost limits are determined solely by the Runner owner. The Router must not be allowed to override them. `deadline_at` is an absolute timestamp in Unix **milliseconds**.

While running a longer Task, send a heartbeat approximately every two minutes:

`POST /api/worker/heartbeat`

```json
{ "task_id": "<task.id>", "claim_id": "<task.claim_id>" }
```

Response: `{ "ok": true, "deadline_at": 1799999999999 }`. The lease lasts five minutes; the Task itself expires 30 minutes after creation, even with heartbeats. Lease expiry **does not automatically requeue** a Task. Do not re-execute a Task after a process crash without a separate recovery protocol.

## 6. Submit the faithful result

`POST /api/worker/complete`

```json
{
  "task_id": "<task.id>",
  "claim_id": "<task.claim_id>",
  "status": "completed",
  "output": "<full original final result from the harness>",
  "actual_model": null,
  "actual_effort": null
}
```

Valid result statuses are `completed`, `failed`, `refused`. **Completed means the Runner reports a successful execution, not that the Router has independently verified the work.** Preserve the final output exactly, including whitespace: never summarize or silently truncate it. Maximum output is **256,000 characters**; maximum Task instructions **32,000 characters**. If the output is too large, retain it locally and surface a clear error rather than altering it.

Only report `actual_model` and `actual_effort` if actually known; null or absent means inherited/unknown. An accepted completion adds a `task_result` event and wakes Routers. A correctly authenticated late completion may be retained as a `task_late` audit record without restarting the Task. Do not forge claim IDs after a 403/409 response.
## 7. Error behavior

| Error | Required reaction |
| --- | --- |
| `401 unauthorized` | Token invalid/disabled/deleted; stop, notify owner |
| `400 invalid_execution_configs` | Fix your local catalog |
| `400 invalid_default_config_id` | Choose an advertised default |
| `409 catalog_session_mismatch` | Investigate stale/competing Runner; never bypass this check |
| `409 active_task_config_changed` | Preserve the in-flight Task's model/effort/harness |
| `409 claim_not_active` | Stop heartbeat for that claim; do not assume execution permission |
| `409 already_finished` | Do not retry the same completion indefinitely |
| `403 invalid_claim` | Never forge a claim ID or bypass ownership |
| Network timeout / 5xx | Back off; retry safe requests, **not** actual Task execution |

V1 has no generic remote shell, automatic process reattachment/requeue, or artifact upload API.

## 8. Minimal adapter loop (pseudocode)

```text
read Worker bearer token, base URL and workspace from LOCAL configuration
verify that the real local harness can run tasks non-interactively
catalog = validate LOCAL list of genuinely supported configurations
session = POST /api/worker/configs(catalog, default_config_id).catalog_session_id

loop:
    reply = POST /api/worker/claim(catalog_session_id=session)
    if reply.task is null: sleep(poll_interval); continue

    task = reply.task
    config = catalog.find(task.execution_config_id ?? default_config_id)
    if config missing: report failed, do not execute; continue
    enforce LOCAL workspace, sandbox, tool allowlist and budget
    start a heartbeat loop
    try:
        result = invoke_REAL_WorkBuddy_interface(task.instructions, config)
        status = classify outcome from actual harness signals
        output = the exact returned final text
    except local failure:
        status = failed
        output = a clear local failure diagnostic
    stop heartbeat
    POST /api/worker/complete(task_id, claim_id, status, output,
                              actual_model, actual_effort)
```

This is **pseudocode**, not a claim that every WorkBuddy edition has such an API. `invoke_REAL_WorkBuddy_interface` must call the *actual supported interface* of the installed version. Never take an executable name, command, CLI argument, sandbox mode, token or working directory from the remote Task book.

## 9. Acceptance test for Xiaolai / 小赖

Use a disposable isolated workspace, not a repository containing personal credentials.

1. Register a Worker in OpenDo and keep its token only on the local machine.
2. Start the adapter. Confirm its model choices appear under **Worker** and in Router `list_workers`.
3. Create a harmless Task selecting a published configuration. Confirm it was claimed **once**, executed locally, and submitted with the original output.
4. On a longer Task, confirm at least one valid heartbeat.
5. Verify the Router receives the `task_result` event and can inspect the original result.
6. Check that an unadvertised configuration is rejected, and old catalog sessions cannot claim Tasks.
7. Confirm an unrelated room member cannot edit/remove your Worker; after disabling or deleting it, the token must no longer work.

**Minimal goal:** one genuine WorkBuddy Task end-to-end without any change to the Cloudflare server or Codex Runner. Multi-model support is a follow-on, not a prerequisite.
