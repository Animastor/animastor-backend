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
├── package.json            @animastor/installer 0.2.10, Node >=20, zero runtime deps
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
an exit code. It installs missing apt packages, starts the worker (and its
own ComfyUI in `managed` mode), and re-applies the PATH block — E2E nodes
reset `~/.bashrc`/`~/.profile` on every boot.

Type A (the platform starts ComfyUI, e.g. TIR): when the install state says
the ComfyUI belongs to the platform (`mode existing`, `startComfyui=false`,
or `comfy_owner.owner = foreign` recorded by an earlier run) and no verified
platform instance answers yet, `doctor` waits up to `--comfy-wait-ms`
(default 180000 on boot) for the `main.py` process AND its
`GET /system_stats`, re-reading the address from the process cmdline on every
poll and logging progress every 30 s. Only then are `COMFY_URL` /
`COMFY_PORT` / `NOTEBOOK_PATH` recomputed and the worker started; its 90 s
"ComfyUI ready" window opens after ComfyUI answered. If ComfyUI does not come
up in time the result is `FAILED` — "ComfyUI is started by the platform; it
did not come up in N s" — and the worker is NOT started against the address
of a previous boot. `animastor status` labels such a ComfyUI
"started by the platform (pid …)". `~/animastor/start-worker.sh` is
replaced by a wrapper (`exec ~/.local/bin/animastor start "$@"`, old script
kept as `start-worker.sh.bak`); ready-to-use boot scripts for both node types
are in `animastor-docs/04-planning/INSTALLER_BOOT_STARTUP.md`.

`animastor boot` (0.2.4) is the whole node startup script on both node types:
it detaches at once (own session, stdin `/dev/null`, output appended to
`~/animastor/logs/bootstrap.log` under a header with the boot time) and exits
0; the detached `doctor --yes` waits up to 600 s by default. TIR starts its
ComfyUI only after the startup script has finished, so waiting inside the
script deadlocks.

Custom-node Python dependencies on type A (0.2.5): the pip requirements of
every required profile custom node are checked in the Python of the running
`main.py` (taken from `/proc/<pid>`). Missing ones go into a persistent
OVERLAY venv `~/animastor/pydeps/py<X.Y>` (`python -m venv --without-pip
--system-site-packages`: pip of the platform runs there and writes only what
the platform lacks; torch is pinned as a constraint) and a generated custom
node `custom_nodes/animastor-pydeps/prestartup_script.py` puts that
site-packages in front of `sys.path` before ComfyUI imports the nodes. All of
it is in `/home`, so after a node restart the platform's ComfyUI loads the
nodes with no reinstall and no restart. (As root, pip into `/usr/bin/python3`
writes `/usr/local/lib/python3.X/dist-packages` and `--user` writes
`/root/.local` — both are lost with a node restart.) A ComfyUI without
prestartup-script support falls back to the 0.2.4 behaviour (install into its
Python; boot reinstalls). When the running ComfyUI lacks the node classes it
is restarted — only with consent: `--restart-platform-comfy` /
`--no-restart-platform-comfy`, the answer recorded in `install-state.json`
(`installer_options.restartPlatformComfy`, asked once interactively, default
Yes), or the boot default (yes). A plain `--yes` is not consent. The restart
stops exactly that pid (its argv, cwd and environment are read from `/proc`
first; nothing is stopped when they are unreadable or the signal is refused),
gives the platform 30 s to start it again, otherwise starts the same command
line itself (detached, log `~/animastor/logs/comfyui-restart.log`) and waits
for `GET /system_stats` at the original `--baseurl` address and the node
classes in `/object_info`. Type B checks its own venv and restarts its own
ComfyUI.

Version replacements of the overlay (0.2.6): the overlay is first in
`sys.path` of the WHOLE ComfyUI, so a node that pins a version (qwen-tts:
`transformers==4.57.3`) replaces the platform's package for ComfyUI and every
other node (E2E 02.11: transformers 5.0.0→4.57.3, huggingface_hub
1.3.5→0.36.2, cryptography 3.4.8→50.0.2). After the dependencies are in place
the overlay is compared with the platform Python (`python -I`,
`importlib.metadata`, overlay not on `sys.path`); every replacement is logged
and shown in RESULT as
`[i] <pkg> platform X → overlay Y (needed by <node>)` — `!` when the major
version goes up or down — and recorded in `install-state.json`
(`installer_options.nodeDeps.overrides`). One GPU node — one profile: when
another profile is installed (or being installed) on the same ComfyUI and a
replacement touches a package one of its nodes uses, or — with more than one
profile — a ComfyUI core requirement (`<ComfyUI>/requirements.txt`) whose
range excludes the overlay version, the replacement needs consent: an
interactive question (default No) or `--accept-node-deps-overrides`; the
answer is recorded (`installer_options.nodeDeps.accepted`). `boot` and a
plain `--yes` never consent: the run is FAILED with the cause, and the overlay
is restored from the copy taken before pip (`py<X.Y>.pre-install`).

Node classes for the worker (0.2.7): the worker bundle (>= 2.2.2) asks for
tasks only when ComfyUI's `/object_info` lists every node class of its
profile. The list is `<worker dir>/node-classes.json`
(`{"profiles":{"audio/qwen-tts":[…]}}`), written from the manifests'
`provides_classes` (required dependencies only) on a fresh install, on a
bundle update and on every `doctor`/`boot` run — a node installed by an
older installer gets it on its next doctor/boot. An identical file is left
untouched; the file is registered for the uninstaller. Without the file the
worker keeps the previous behaviour (ComfyUI API only) and logs one warning.

A running worker is not restarted by `install`/`doctor` (0.2.8). It is left
as is (`worker already running (pid N), left as is`) unless its configuration
changed (`.env` or bundle files newer than the process). Then an idle worker
is restarted; a busy one (a `Task <id>` in its own log without `Done`/`Failed`)
is waited for up to `--wait-job-ms` (default 600000), else the run is FAILED
(exit 1) and the worker keeps running. `--force` restarts it anyway. The boot
path (`doctor --yes`, no TTY) only starts a stopped worker. An unchanged
`.env` is no longer rewritten. `doctor` and `status` print
`current job: none|<id>`.

The worker bundle is deployed WHOLE (0.2.10): every file of the source — the
hub bundle or the installer's bundled copy — is copied, not only
`manifest.worker_bundle.files` (that list is the minimal presence check; `.env`
and `.env.*` other than `.env.example`, `node_modules/`, `.git/`, `logs/` are
never copied). The deployed file list is recorded in install-state
(`components.worker.bundle_files`); the next update removes the files of the
old version the new bundle no longer ships (only recorded files, never `.env`
or `node-classes.json`; a 0.2.9 state falls back to `files_installed`). Before
a start every local `require('./…')` reachable from `worker.cjs` must exist,
otherwise the start is FAILED naming the file and the worker is not spawned.

Every install/doctor run first brings the management tools (`animastor`,
the persistent installer copy) and an installed worker bundle to its own
version — before any check that can end the run — so every printed fix
command exists in the installed `animastor`. Unknown options are an error
(exit 2). When node classes are missing the result names the cause: missing
packages, an `IMPORT FAILED` line from the ComfyUI log (`/internal/logs`,
the process stdout file, the restart log) or a needed restart.

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
