# OpenDo DSH Runner (experimental)

A separate local Worker adapter for **DeepSeek Harness (DSH)**. This does **not** require modifying `scripts/runner.mjs` (the Codex Runner) or changing the existing Cloudflare Worker / Task protocol.

> Status: **live end-to-end verified** on DSH 0.2.2-rc.1: locally loaded model key, startup preflight, separate Worker registration, catalog, Task creation/claim/execute/complete, and raw Task detail. This is still experimental: the effective DSH workspace sandbox and execution authorization require ongoing review.

## Desktop DSH on Windows

The installed DeepSeek Harness desktop application may ship a bundled CLI even if `dsh` is **not** on PATH. The adapter locates the Electron app at:

```text
%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe
```

It runs the packaged CLI with `ELECTRON_RUN_AS_NODE=1`, `--expose-internals`, and the app's own bundled `dsh-desktop-host/lib/cli.js`, using `spawn(shell:false)`. Verified locally on **DSH 0.2.2-rc.1**. The Runner calls `--profile headless --permission-mode workspace-write --approval-policy never -` (Task text through stdin). DSH upgrades may change syntax; verify `dsh --profile headless --help` for each installed version.

If the desktop app is installed elsewhere, set `DSGO_DSH_INSTALL_DIR` to its installation root. For a portable or other platform DSH, see `resolveDshLaunch` in `scripts/dsh-headless.mjs`.

### Model authentication

A real DSH 0.2.2-rc.1 headless prompt succeeded after loading the key from `~/.deepseek.key` (the actual filename on the Windows machine). The adapter now **automatically** reads that private file when `DEEPSEEK_API_KEY` is not already set.

Priority: (1) an explicitly set `DEEPSEEK_API_KEY` environment variable; (2) `DSGO_DSH_KEY_FILE` if supplied, otherwise `~/.deepseek.key`; (3) fail-closed preflight if no valid provider key is available. The key file contains **only the key text** plus an optional trailing newline. The loader does not print its contents or mutate `process.env`.

This is intentionally a **local** convenience: keep the key file outside Git, with permissions limited to your Windows user. DSH receives the provider key in its child-process environment because the model API requires it. It will **not** receive the OpenDo Worker bearer token. Nevertheless, a coding agent may access process environment or files through its tools; run only with the minimum necessary permissions, in a disposable workspace with no unrelated secrets.

Do not paste a model key into OpenDo, an Issue/PR, or chat, and do not reuse a production Cloudflare Secret merely to make a smoke test pass.

### First, verify the local model works (no Worker Token needed)

For the installed Windows setup, no manual PowerShell key export is needed once the private `~/.deepseek.key` file exists. Run:

```powershell
npm run runner:dsh:smoke
```

This sends one harmless headless prompt in a disposable temporary folder. It deliberately does **not** register, claim, or complete a room Task; model usage may be billed by your provider. The credential loader can also use `$env:DSGO_DSH_KEY_FILE` (an absolute file path) or an already-set `$env:DEEPSEEK_API_KEY`. No key contents are echoed. **Use a separately scoped provider key where available** and never commit it to Git.

The Worker performs a similar **fail-closed preflight on startup**. If DSH cannot answer, the Runner exits without publishing a Worker catalog or claiming a live Task.

### Permissions

The adapter explicitly supplies `--permission-mode workspace-write --approval-policy never` in the DSH CLI, also sets `DSH_PERMISSION_MODE=workspace-write` and `DSH_TOOLS_MODE=native` in the child environment, and never passes Task text as command-line flags. **Do not assume these settings form a security boundary without confirming their meaning in your installed DSH release.** Start in a disposable trusted workspace with no private secrets. WorkBuddy/Codex/DSH sandbox semantics may differ; none are interchangeable.

## Register and run independently

1. Open the OpenDo chat and register **a new Worker named DSH**. Do not reuse the Codex Worker token. An existing verified DSH registration must be reused, not duplicated.
2. Save the one-time token in **gitignored** `opendo/.dsh-worker.local.json` as `{"worker_id":"worker_…","token":"worker_….<secret>"}`. An explicit `DSGO_DSH_WORKER_TOKEN` environment variable takes precedence. Never reuse the Codex token. During initial integration, the registration token was saved by a local one-time helper and is not visible in Git.
3. Set a dedicated trusted work directory. Make it a disposable test directory initially. Do not use your entire home directory.
4. Run `npm run runner:dsh:smoke` and confirm success before allowing Router to send real work. The Worker repeats this preflight at startup.

```powershell
cd "$HOME\projects\opendo"

$env:DSGO_DSH_WORKDIR = Join-Path $env:TEMP "opendo-dsh-experiment-workspace"
$env:DSGO_DSH_URL = 'https://chat.io99.xyz'

# Create the isolated directory if necessary.
New-Item -ItemType Directory -Force $env:DSGO_DSH_WORKDIR | Out-Null

npm run runner:dsh
```

The adapter reads `.dsh-worker.local.json` automatically if no `DSGO_DSH_WORKER_TOKEN` environment variable is set. The credential file is ignored by Git and remains on this machine.

The adapter advertises **one configuration**, `dsh-default`, and leaves model and effort as unknown (`null`) until they can be verified from the installed DSH CLI. It polls each minute, uses catalog sessions, sends heartbeats, and preserves headless stdout exactly as the task result. Stderr stays only in an ignored local diagnostics file: `.dsh-runner-state/<task-id>/diagnostics.txt`.

No interactive desktop window is launched; the script launches the bundled CLI. The existing Codex Runner may run simultaneously with its own token. If DSH cannot execute, **stop the DSH Runner**: do not let it claim and fail production tasks repeatedly. Never run two DSH Runners sharing one token.

## Acceptance criteria

- [x] Confirm updated DSH CLI version 0.2.2-rc.1 and `--profile headless --help` syntax; sandbox semantics still require real security verification.
- [x] Confirm headless can answer one harmless prompt with its own model credential, in an isolated temporary directory (real test passed after reading `~/.deepseek.key`).
- [x] Register a separate DSH Worker and see `dsh-default` in OpenDo.
- [x] Send one harmless live Task; confirm original output and one terminal `task_result` (result contained `OPENDO_DSH_E2E_OK`; status `completed`).
- [ ] Compare time-to-result and output quality with Codex on the same small, safe tasks; do not assert DSH is faster or aesthetically stronger before measuring.

See [`worker-adapter.md`](worker-adapter.md) for the generic Worker protocol and its safety contract.

## Live verification notes

The first real integration Task was a harmless read-only request; the isolated DSH Runner returned the expected final text, and the server's `task_detail` confirmed status `completed` with configuration `dsh-default`. This verifies the HTTP protocol and headless execution route, **not** that the DSH sandbox prevents every prohibited operation. The test used an isolated directory below the local Windows Temp folder and no production repository writes.
