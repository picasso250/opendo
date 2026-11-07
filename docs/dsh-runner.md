# OpenDo DSH Runner (experimental)

A separate local Worker adapter for **DeepSeek Harness (DSH)**. This does **not** require modifying `scripts/runner.mjs` (the Codex Runner) or changing the existing Cloudflare Worker / Task protocol.

> Status: adapter implemented and tested against an offline mock. The actual installed DSH binary **must be retested after a desktop app upgrade**, especially its CLI arguments, permissions and model authentication. Do not register it as production-ready until a real headless smoke test succeeds.

## Desktop DSH on Windows

The installed DeepSeek Harness desktop application may ship a bundled CLI even if `dsh` is **not** on PATH. The adapter locates the Electron app at:

```text
%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe
```

It runs the packaged CLI with `ELECTRON_RUN_AS_NODE=1`, `--expose-internals`, and the app's own bundled `dsh-desktop-host/lib/cli.js`, using `spawn(shell:false)`. We verified this for **DSH 0.2.1-rc.2**, whose supported single-task syntax is `--profile headless -` (task text from stdin). New DSH releases may change this; check `dsh --profile headless --help` locally after updating.

If the desktop app is installed elsewhere, set `DSGO_DSH_INSTALL_DIR` to its installation root. For a portable or other platform DSH, see `resolveDshLaunch` in `scripts/dsh-headless.mjs`.

### Model authentication

The first real 0.2.1-rc.2 smoke test could start the CLI, but **exited without an answer because its headless process did not receive the model provider credential**. The login to the desktop UI does not prove headless CLI authentication. After upgrading, first verify headless execution in an **isolated empty directory**, with the model credentials required by the installed DSH version. The Runner allows a deliberately narrow set of common provider environment keys (such as `DEEPSEEK_API_KEY`) to pass to DSH. It never forwards OpenDo Worker bearer tokens or GitHub/Cloudflare administrator tokens.

Do not paste a model key into the OpenDo chat or commit it to Git; set it in a local shell/session only as required for your own DSH configuration. If the updated DSH supports credential retrieval from its own secure local store, prefer that instead. Never reuse a private Cloudflare Secret just to make a local smoke test pass.

### Permissions

The experimental adapter sets `DSH_PERMISSION_MODE=workspace-write` and `DSH_TOOLS_MODE=native` in its child environment and never passes Task text as command-line flags. **Do not assume these settings form a security boundary without confirming their meaning in your installed DSH release.** Start in a disposable trusted workspace with no private secrets. WorkBuddy/Codex/DSH sandbox semantics may differ; none are interchangeable.

## Register and run independently

1. Open the OpenDo chat and register **a new Worker named DSH**. Do not reuse the token of the running Codex Worker.
2. Copy the new one-time Worker Token and configure it **only in the local shell running DSH**.
3. Set a dedicated trusted work directory. Make it a disposable test directory initially. Do not use your entire home directory.
4. Complete a local DSH headless smoke test before allowing Router to send real work.

```powershell
cd "$HOME\projects\opendo"

# Paste the NEW token here, not the Codex Worker token.
$env:DSGO_DSH_WORKER_TOKEN = Read-Host 'DSH Worker Token'
$env:DSGO_DSH_WORKDIR = Join-Path $env:TEMP "opendo-dsh-sandbox"
$env:DSGO_DSH_URL = 'https://chat.io99.xyz'

# Create the isolated directory if necessary.
New-Item -ItemType Directory -Force $env:DSGO_DSH_WORKDIR | Out-Null

npm run runner:dsh
```

The adapter advertises **one configuration**, `dsh-default`, and leaves model and effort as unknown (`null`) until they can be verified from the installed DSH CLI. It polls each minute, uses catalog sessions, sends heartbeats, and preserves headless stdout exactly as the task result. Stderr stays only in an ignored local diagnostics file: `.dsh-runner-state/<task-id>/diagnostics.txt`.

No interactive desktop window is launched; the script launches the bundled CLI. The existing Codex Runner may run simultaneously with its own token. If DSH cannot execute, **stop the DSH Runner**: do not let it claim and fail production tasks repeatedly. Never run two DSH Runners sharing one token.

## Acceptance criteria

- [ ] Confirm updated DSH CLI version / `--profile headless --help` and sandbox behavior.
- [ ] Confirm headless can answer one harmless prompt with its own model credential, in an empty directory.
- [ ] Register a separate DSH Worker and see `dsh-default` in OpenDo.
- [ ] Send one harmless Task; confirm original output and one terminal `task_result`.
- [ ] Compare time-to-result and output quality with Codex on the same small, safe tasks; do not assert DSH is faster or aesthetically stronger before measuring.

See [`worker-adapter.md`](worker-adapter.md) for the generic Worker protocol and its safety contract.
