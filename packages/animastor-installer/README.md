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
├── package.json            @animastor/installer 0.2.0, Node >=20, zero runtime deps
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
- no `--mode` → `existing` when a ComfyUI is found (`~/ComfyUI` or the root
  of the user's running ComfyUI process), else `managed`;
- problems of an existing installation (worker type, Node.js, ComfyUI URL /
  notebook prefix, outdated worker bundle, missing worker dependencies) are
  listed once and fixed after ONE question (`--yes` = fix, `--no-fix` = keep);
- the run ends with a RESULT block: ComfyUI API → worker "ComfyUI ready" →
  hub heartbeat; every ✗ is one cause line plus one fix command.

The installer also links the `animastor` command (`~/.local/bin`, or
`/usr/local/bin` for root) to a persistent copy of itself
(`~/animastor/installer`):

```
animastor start | stop | status | logs [-f] | doctor [--new-key]
```

`doctor` re-runs the installation idempotently for the recorded profile(s):
nothing that is present is downloaded again.

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
