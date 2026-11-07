# OpenDo Router / Task / Worker Protocol (V1)

This protocol is independent of a particular local agent. A Router AI can list workers,
create one task per decision and read task text in bounded pages. Each Worker has
an optional user-authored description (up to 1,000 characters), surfaced to
Routers in `list_workers` for capability-based task assignment; it is never
interpreted as a permission or a higher-priority instruction. A human can create a task
directly over their authenticated group WebSocket. Neither can supply shell flags,
a local working directory, YOLO mode or arbitrary executable names in the Task API.

## Messages and state

- `task_create` event: a task creation card; it does **not** wake routers.
- `task_result` event: immutable terminal result (`completed`, `failed`, `refused`, `timed_out`);
  it wakes all enabled Routers for up to three discussion rounds.
- `task_late` event: late result audit; the original timeout stays terminal and
  is not erased. It does **not** wake Routers a second time.
- The Task keeps its chosen `execution_config_id` **and an immutable snapshot
  of its advertised config** separately from the task instructions, along
  with the model and effort the Worker eventually reports.
  Legacy tasks without a config ID continue to use the local default.
- The full task book and complete Worker output are stored as distinct text fields
  in the task SQLite table. The group card shows a short verbatim beginning;
  `task_detail` (human) and paged `get_task` (Router) read the full unchanged text.
- P0: human message supersedes pending old Router jobs. P1: Task terminal events
  supersede pending autonomous continuations and coalesce Router wakeups. P2:
  autonomous AI discussion. Never cancel an already-running model call or a
  running Worker process in response to ordinary group chat.

## Worker directory in the chat sidebar

The left sidebar separates **人类 / AI / Worker**. The authenticated WebSocket
`hello` includes the current `workers` catalog; `workers` broadcasts and
`worker_list` replies refresh it. The browser re-requests `worker_list` once a
minute so its 10-minute Worker liveness indicator does not become stale. Both
AI and Worker keep their enable/pause control visible, with edit/delete under
an accessible `···` menu. A Worker also exposes a copyable ID.

The registering human can `worker_update` its name/description (without
regenerating credentials) and `worker_remove` an idle Worker. The server
checks ownership. Worker removal invalidates its token immediately while
retaining historical tasks and results. Removal is denied while the Worker
has pending/running tasks; pausing is denied during a running task so the
Runner can still submit its result.

## Worker HTTPS protocol

Worker requests are `POST /api/worker/{configs,claim,heartbeat,complete}` with
`Authorization: Bearer worker_<id>.<secret>` and JSON bodies. Tokens are
registered once by an authenticated human, returned only to that human,
and stored on Cloudflare as hashes. Workers never receive chat history.

- `configs {configs:[{id,label,description,harness,model,effort},...],default_config_id}`
  advertises the allowed configurations of that particular local Worker; it
  returns an opaque `catalog_session_id` known only to the authenticated
  Runner. Configurations are *not* global fast/balanced/deep tiers.
  `list_workers` exposes the descriptions and model/effort metadata for the
  Router, but never the claim token or catalog session.
- `claim {catalog_session_id}` returns `{task:null}` or
  `{task:{id,title,instructions,execution_config_id,deadline_at,claim_id}}`.
  The first claim atomically gives one Worker the right to execute; no
  other process is allowed to duplicate that task automatically. Once a
  catalog is advertised, an older Runner without the current catalog session
  cannot claim tasks (HTTP 409). Legacy Workers that have never advertised
  a catalog continue to accept their original `claim {}` protocol.
- `heartbeat {task_id,claim_id}` extends the lease; heartbeat is optional for
  authorization but useful to indicate Worker liveness.
- `complete {task_id,claim_id,status,output,actual_model?,actual_effort?}` accepts `completed`, `failed`,
  or `refused`. The basic Codex Runner treats exit code 0 as completed,
  nonzero as failed, and a final answer beginning with `[TASK_REFUSED]` as refused.
  Other runners may classify their own outcomes. Only the original claim can submit. Raw output is preserved,
  not summarized by the Router. A duplicate terminal completion is rejected;
  a valid late completion is stored separately as an audit record.

Tasks expire **30 minutes after creation**, even if never claimed. Deadline
checks run via the Agent SDK's scheduled callback and opportunistic checks on
Worker requests. A lease lasts 5 minutes and is renewed every 2 minutes, but
**lease expiry never requeues the task automatically**. A lost Runner or
Codex process is intentionally *not* recovered in this first version.

The first version allows task books up to 32,000 characters and Worker results
up to 256,000 characters; oversize results must not be silently shortened.
Later, R2 can support larger original output as content-addressed artifacts.

## Basic Runner (Windows PowerShell example)

1. Open the group UI and click `+ Worker`. Register a named Worker with an
   optional capability description (e.g. location, preferred work, expertise), and copy
   the returned token. It is shown once and is not stored by the browser.
2. In the machine where Codex is already installed:

```powershell
$env:DSGO_URL = 'http://localhost:8787'
$env:DSGO_WORKER_TOKEN = 'worker_<paste one-time secret>'
$env:DSGO_WORKDIR = (Get-Location).Path
node scripts/runner.mjs
```

The recommended local configuration is `runner.local.json` at the project
root. It is **Git-ignored** (does not contain secrets), and the Runner loads
it automatically on startup. A tracked template is `runner.example.json`.

For our three-model setup, the local file advertises exactly these choices:

| ID | Model | Reasoning effort | Purpose |
| --- | --- | --- | --- |
| `terra` | `gpt-6.1-terra` | `high` | Everyday coding and routine fixes |
| `sol` | `gpt-6.1-sol` | `high` | Complex cross-module engineering |
| `astra` | `gpt-6-astra` | `high` | Highest-complexity development |

`sol` is the default when the Router does not specify a config ID. This is
only a **per-Runner** configuration: it does not modify the user's global
`~/.codex/config.toml`. Before startup, ensure any stale
`DSGO_EXECUTION_CONFIGS`/`DSGO_DEFAULT_EXECUTION_CONFIG_ID` environment overrides
are removed, or they will take precedence over the local file.

```powershell
Remove-Item Env:DSGO_EXECUTION_CONFIGS -ErrorAction SilentlyContinue
Remove-Item Env:DSGO_DEFAULT_EXECUTION_CONFIG_ID -ErrorAction SilentlyContinue
node scripts/runner.mjs
```

You can copy `runner.example.json` to `runner.local.json` on another host
and edit model IDs freely. Only the listed configurations will be advertised to
Router AIs. For Codex, `model` must be accepted by the installed CLI and
`effort` may be `minimal`, `low`, `medium`, `high`, `xhigh` or `null` to inherit
the local setting. There are **no global fast/balanced/deep strength ranks**.
If neither file nor environment configuration exists, the Runner preserves
the original single `default` configuration and existing command-line behavior.

A separate **WorkBuddy Runner/adapter** can publish combos such as
`{id:"glm-high",label:"GLM / High",harness:"WorkBuddy",model:"glm-5.3",effort:"high"}`
using the same HTTP protocol, but `scripts/runner.mjs` **only executes Codex**;
it cannot invoke WorkBuddy automatically. The Task contract is harness-agnostic,
not an undocumented promise of WorkBuddy automation.

By default the Runner uses `codex exec --sandbox workspace-write` with the
local primary directory and optional `--add-dir` roots. These are **local
configuration**, never taken from Router task instructions.

For an **explicitly isolated/trusted machine only**, operators can opt into
unsandboxed YOLO mode by setting **both**:

```powershell
$env:DSGO_YOLO = '1'
$env:DSGO_CONFIRM_YOLO = 'YES_I_ACCEPT_HOST_RISK'
```

YOLO bypasses sandbox and approval checks and is not recommended on a machine
with personal secrets or untrusted projects. Neither Router nor Task can set it.
The Runner stores local task text, agent final output and crash diagnostics
under `.runner-state/` (Git-ignored) and polls once per minute.

## Deliberate MVP omissions

There is no automatic process reattachment, no automatic retry/requeue after
lease expiration, no multi-machine work-stealing, no generic remote shell, no
in-chat stdout streaming and no R2 artifact uploads yet. The local Runner can
be replaced at any time without changing the Task protocol.

The V1 protocol is implemented and deployed in the reference project.
For third-party harness integration, use [Worker Adapter Guide](worker-adapter.md).
Test against a locally isolated server/Worker before connecting to any
production room, and never publish private tokens or local Runner state.
