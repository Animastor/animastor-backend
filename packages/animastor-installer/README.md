# @animastor/installer

Self-contained CLI and library for Animastor Private GPU Worker setup,
verification, and management.

## Status

**Published.** The production source physically lives here
(`packages/animastor-installer/src/installer/`); the backend consumes it as
the `@animastor/installer` package (`file:` dependency), and the package is
published to npm as `@animastor/installer`.

## Structure

```
packages/animastor-installer/
├── package.json            @animastor/installer 0.2.2, Node >=20, zero runtime deps
├── src/installer/
│   ├── cli.js              CLI entry (detect/plan/install/verify/resume/uninstall)
│   ├── index.js            Public API entry (10 exports, incl. setupContract)
│   ├── setup-contract.js   Host-facing projection (UI-safe DTOs)
│   ├── engine/             Core runtime (installers, fetchers, state, workflows)
│   ├── platform/           Platform adapters (linux/windows, docker/native)
│   └── ...
├── ai/install-manifests/   Manifest profiles (MANIFEST_ROOT fallback, relative to __dirname)
└── tests/                  mocha/chai package tests (npm test)
```

`backend/ai/workflows` is a **shared host asset** (the backend runtime and the
generation package consume it) — it stays host-side and is NOT part of this
package. The installer reads workflows via manifest `repository_path`
candidates (repo root + tarball prefix), never package-locally.

## Public API

| Export | Purpose |
|---|---|
| `manifest` | Install manifest loading and validation |
| `resolver` | Compatibility resolver |
| `workflows` | Workflow artifact management |
| `downloads` | Download planning |
| `plan` | Install planning |
| `safety` | Safety rules |
| `verification` | Verification reports |
| `engine` | Install engine |
| `uninstaller` | Uninstall flows |
| `setupContract` | Host-facing setup contract (backend worker-setup routes) |

## CLI

`animastor-installer` (package `bin` → `src/installer/cli.js`).

Normal use is the hub bootstrap — one command from the Animastor setup page:

```
curl -fsSL "https://animastor.org/gpu/installer?profile=…&mode=…&platform=linux" | bash
```

- every question and the hidden Worker Key are read from `/dev/tty` (stdin is
  the piped script); without a terminal the installer stops with a clear
  message (exit 3) unless `--yes` is given;
- the mode follows the MACHINE, not the recorded state (`engine/comfy-owner.js`):
  a ComfyUI process the installer did not start (a platform/notebook instance
  with `--listen 0.0.0.0 --port 8888 --baseurl /notebook/…`) means `existing`,
  and its address is taken from its own cmdline and confirmed by a ComfyUI
  `/system_stats` payload; the installer never starts a second ComfyUI next to
  it. `managed` only when the installer created the ComfyUI and nobody else
  runs it. A recorded `managed/startComfyui=true` that contradicts the machine
  is shown and corrected; an extra installer-owned instance is offered for
  stop;
- no `--mode` → as above (never "managed" just because the state says so), and
  an explicit `--mode` that contradicts the machine is reported, not applied;
- problems of an existing installation (worker type, Node.js, ComfyUI URL /
  notebook prefix, outdated worker bundle, missing worker dependencies) are
  listed once and fixed after ONE question (`--yes` = fix, `--no-fix` = keep);
- the run ends with a RESULT block: ComfyUI API → worker "ComfyUI ready" →
  hub heartbeat; every ✗ is one cause line plus one fix command.

The installer also links the `animastor` command into `~/.local/bin` (root
included — E2E nodes keep only `/home` across a reboot) and adds that directory
to PATH in `~/.bashrc` / `~/.profile` once; the command points at a persistent
copy of itself (`~/animastor/installer`):

```
animastor start | stop | status | logs [-f] | doctor [--new-key]
```

`doctor` re-runs the installation idempotently for the recorded profile(s):
nothing that is present is downloaded again, the worker is started again (also
after a node reboot), and a missing system prerequisite (`python3.X-venv`, …)
is installed on a single `Install <pkg> now? [Y/n]` question when the host
allows it (root or passwordless `sudo -n`). The Worker Key in `.env` is never
asked for again on a re-run.

`doctor --yes` is the boot path: no TTY, no questions, ONE line of output and
an exit code. It waits up to `--comfy-wait-ms` (default 180000) for the
platform's ComfyUI, installs missing apt packages, starts the worker (and its
own ComfyUI in `managed` mode), and re-applies the PATH block — E2E nodes
reset `~/.bashrc`/`~/.profile` on every boot. `~/animastor/start-worker.sh` is
replaced by a wrapper (`exec ~/.local/bin/animastor start "$@"`, old script
kept as `start-worker.sh.bak`); ready-to-use boot scripts for both node types
are in `animastor-docs/04-planning/INSTALLER_BOOT_STARTUP.md`.

The fix list is APPLIED: `COMFY_URL`, `COMFY_PORT` and `NOTEBOOK_PATH` are
rewritten in `.env` (only real differences are listed, one entry per key), and
a second run over the fixed `.env` prints no fix list. The address is
recomputed on every run because the platform's port and notebook prefix change
between boots. Answers already given (a declined optional workflow, a declined
model download) are remembered and not asked again, also under `--yes`.

## Manifest resolution (MANIFEST_ROOT contract)

1. `/app/artifacts/install-manifests` (baked container layout)
2. `packages/animastor-installer/ai/install-manifests` (repo-dev, resolved
   relative to `__dirname` — package-relative fallback, no env var)

## GPU Hub tarball contract (unchanged prefixes)

```
animastor-installer/src/installer/...
animastor-installer/ai/install-manifests/...
animastor-installer/backend/ai/workflows/...
animastor-installer/packages/animastor-worker/worker/...
```
