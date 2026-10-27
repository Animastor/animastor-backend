# Stage 147 — A1 fix + production release plan

Status: **fix merged & pushed; report only; staging left running; nothing changed on prod.**

---

## 1. A1 — defect, fix, semantics

**Defect (A1).** The version gate in `completeStage()` could not see a `scene_assets` row whose `build_id IS NULL`. On a gate miss it never re-read that row, so a legacy NULL-row scene stayed `DIRTY` forever and the scheduler re-dispatched it every 5 s (endless DIRTY/re-dispatch loop). Reproduced on the Stage-146 looped scene with the flag ON.

**Fix semantics (exactly as specified).** On `getAsset(..., stage, buildId)` miss, do **exactly ONE extra read of the SAME key with `build_id IS NULL`** — never another build's row, never "latest any". Apply the **same version rules** as the primary read:
- `scene_content_version` for all assets,
- plus `scene_audio_config_version` for audio.

Then `markReady` stamps `build_id`. If the NULL row's version is below the scene version → still `DIRTY`, but the gate explains where the correct version must come from, and because there is only a single bounded fallback read there is **no infinite 5 s loop**.

**Implementation** (new port op, no raw SQL — architecture tests enforce the repository boundary):
- `packages/animastor-orchestration/src/runtime/persistence-port.js` — `sceneAssets.getAssetNullBuild` added to OPS + comment
- `backend/src/storage/postgres/repositories/scene-assets-repo.js` — `getAssetNullBuild` (same key, `build_id IS NULL`, latest) + export
- `backend/src/storage/runtime-persistence-adapter.js` — delegation of the new op + export + comment
- `packages/animastor-orchestration/src/orchestration/orchestrator.js` — shared `versionsConfirm(row)` helper (primary + NULL-fallback use identical rules), gate fallback calls `getAssetNullBuild`
- `packages/animastor-orchestration/CHANGELOG.md` — 0.1.6 entry extended
- `backend/package-lock.json` — `@animastor/orchestration` integrity updated to the new tarball hash (included in the amended fix commit)

Version stays **`0.1.6` (unpublished)** — extended CHANGELOG rather than bumping to `0.1.7`.

**Commit:** `2754bc0f` `fix(stage147): A1 — version-gate falls back to the key's build_id IS NULL row`
- amended from `cac7722b` to add `backend/package-lock.json`
- pushed to branch `stage143a-foundation-phase1` (base `41cc0313`), range `41cc0313..2754bc0f`
- Only the fix is in this commit. The report is a separate commit.

**Files changed by the fix (backend-adapter layer):** `scene-assets-repo.js`, `runtime-persistence-adapter.js`, `persistence-port.js`, `orchestrator.js`, plus `package-lock.json` and `CHANGELOG.md`.

---

## 2. Proof on staging (flag ON) — CONFIRMED FIXED

Staging rebuilt from `2754bc0f` (`IU_IMAGE_VERSIONED=1`), running. Staging auth for `/regenerate` via a signed guest token inserted into the staging `guests` table (staging DB write, allowed).

Scene: book `stage145_mini` / chapter `ch-a1b2c3` / scene `sc-d4e5f6`, build `stage145_build1`.

Result after `/regenerate`:
- `scene_assets.image` → `build_id=stage145_build1`, `status=ready`, `cv=5` → **READY reached, `build_id` stamped**
- legacy `build_id IS NULL` row left untouched
- 15-minute ON monitor (pid 2536241, log `/tmp/opencode/stage147-monitor-on.log`): `stale_last75s=0`, `cachehits_last75s=0` every minute → **`[VERSION-GATE] stale` not growing, no scheduler `cache_hit` cycles**

| Check | Result |
|---|---|
| Scene → READY | YES |
| `scene_assets` row gets `build_id` | YES (`stage145_build1`) |
| 15 min: stale not growing | YES (flat at 0) |
| 15 min: no `cache_hit` cycles | YES (0 per minute) |
| Legacy NULL row untouched | YES |

Staging was **not** torn down and remains up.

A staging flag-OFF control run was **not re-run end-to-end** on the live cluster: with `IU_IMAGE_VERSIONED` OFF the versioned gate is inactive, so A1 cannot manifest there. The flag-OFF path is covered by unit tests (`stage143a-flag-off.test.js` 5/5 in fresh clone). If you need a live OFF control run, recreate the staging container with `IU_IMAGE_VERSIONED` removed and run `/regenerate` against a NULL-row scene — expected: READY, gate inactive, no loop.

---

## 3. Tests — fresh clone at `2754bc0f` + local tarball `0.1.6`

Fresh clone of `stage143a-foundation-phase1` at `2754bc0f` (detached). `orchestration@0.1.6` resolved from the local tarball `/tmp/opencode/animastor-orchestration-0.1.6-stage147.tgz` (installed as a real directory, not a symlink; `package.json` temporarily pointed at `file:...`, reverted — not committed). Local PG `127.0.0.1:55432` db `stage143a`, Redis `127.0.0.1:56379`, `ANIMASTOR_DOCS_ROOT=/home/animastor/animastor-docs`.

| Suite | Result |
|---|---|
| A1 backend (`tests/stage147-a1-null-build-gate.test.js`) | **13/13 pass** |
| A1 package (`packages/animastor-orchestration/test/stage147-a1-null-build-gate.test.js`) | **6/6 pass** |
| `stage143a-*` + D2 + A1 (backend) | 112 passing (1 Redis isolated-Redis `before all` connection flake — re-verified clean in isolation, 5/5) |
| `test:arch` (`tests/architecture/*.test.js`) | **935 passing / 24 pending / 0 failing** |
| Orchestration package suite (`npm test`) | **42/42 pass** |
| Full backend suite (`npm test`) | **3610 passing / 28 pending / 2 failing** — both pre-existing & environmental (Redis `before all` connection flake; `ai-endpoint-sharing` assertion), **unrelated to A1**; A1 tests all pass |

A1 tests were verified to **fail on pre-fix code and pass with the fix** (13 backend + 6 package).

> Note: the dirty working copy (`deploy/`, `freebuff-chat-*.md`, `database.js`, `dispatch-engine.js`, `generation-routes.cjs`, deleted `audit-orphan-books.js`, etc.) was **not** committed or touched. The fresh-clone numbers above are the authoritative source.

---

## 4. Production inventory (read-only only)

Container `animastor-backend`, compose project `animastor` (`deploy/docker-compose.yml` + `deploy/overlay-backend-standalone.yml`, env `deploy/.env`).

- Image: `ghcr.io/animastor/animastor-backend@sha256:f6aefe57045aaa…bfd`
- Base commit (image label `org.opencontainers.image.revision`): `78e8f1ae4bb581f52b736bc64e5ae603dedab839` — `chore(backend): update orchestration to 0.1.4` (2026-10-21)
- `@animastor/orchestration` **0.1.4** in prod; other `@animastor/*`: ai-agent 0.1.0, ai-analysis 0.1.0, assistant 0.1.0, auth 0.1.0, contracts 0.1.1, editor 0.1.2, generation 0.1.1, installer 0.1.1, parser 0.1.1, player 0.1.1, url-safety 0.1.0, vbook-runtime 0.2.0
- `IU_IMAGE_VERSIONED` **absent (OFF)**; no `FENCING`/`GPU_LANE`/`STAGING`/`PUBLICATION`/`LOCK`/`VERSIONED` flags in `deploy/.env`
- Container has **no** `.staging` / `.publication-locks` dirs; Redis has **no** keys matching `*staging*`, `*lock*`, `*fence*`, `*publication*`, `*version*`
- `animastor-pg`/`animastor-redis` up ~2 months; `animastor-proxy` up 7 days

**Published npm:** `orchestration 0.1.5` (and lower). **`0.1.6` NOT published.** Hotfix version naming must avoid colliding with published `0.1.5` and branch `0.1.6` (`^0.1.x` would resolve to the higher).

---

## 5. Prod ↔ branch diff

- `git log 78e8f1ae..2754bc0f`: **29 commits**, direct line (merge-base = prod base `78e8f1ae`)
- Stages covered: **105 → 147** (CI approve 78e8f1ae at 105; branch tip 2754bc0f at 147)
- Notable since prod base: stage 114–118 GPU-queue/dispatch hardening, stage 127/129/131/133/135/137/139 fencing & publication, stage 141 ready-chain idempotency, stage 143a versioned-iimage foundation + phase 2a/2b/2c, stage 145 staging run, stage 146 D1/D2 fixes + A1 classification, stage 147 A1 fix
- Overlap with published `orchestration@0.1.5`: prod ships orchestration 0.1.4; 0.1.5 contains some of the stage-114…143a orchestration changes but **not** the A1 fix (0.1.6, unpublished)

**Prod A1 status (read-only):** `docker logs animastor-backend --since 24h` → **0** occurrences of `[VERSION-GATE]` → **no A1-stuck scenes in prod**. Prod also runs flag OFF, so A1 cannot manifest on current prod code; it would only matter if the flag is turned on while orchestration is still 0.1.4 (pre-A1).

---

## 6. Release options

### Option A — full-branch release, flag OFF
Ship the entire `stage143a-foundation-phase1` branch (`41cc0313..2754bc0f`, 29 commits, stages 105→147) to prod with `IU_IMAGE_VERSIONED` OFF.

- Steps: cut a release commit/tag from `2754bc0f`, build & deploy the backend image, keep `IU_IMAGE_VERSIONED` unset.
- Risks: large surface (29 commits incl. fencing/publication/versioned-iimage), much of it unproven on prod; requires prod DB migrations for the versioned schema; flag stays OFF so A1 fix is dormant (not exercised).
- Rollback: redeploy previous prod image (`f6aefe57045a`).
- Size: **large**.

### Option B — narrow D1+A1 hotfix on prod code (recommended)
Backport only D1 + A1 onto prod's base commit `78e8f1ae` as a hotfix branch, flag stays OFF.

- Steps: create hotfix branch from `78e8f1ae`, cherry-pick/adapt D1 (`hoist artifactNaming` + `debug-runtime next()`) and A1 (`getAssetNullBuild` fallback + `versionsConfirm`), bump orchestration to a version that does **not** collide with published `0.1.5` or branch `0.1.6` — e.g. `0.1.5-hotfix.1` or `0.1.6-1` (never plain `0.1.6`, since `^0.1.x` would pull the highest published); publish that tarball; point prod's `package.json`/`package-lock.json` at it; rebuild prod image; deploy; flag OFF.
- Risks: backport conflicts (stage-114…143a orchestration refactors may not apply cleanly to 0.1.4 base); version-resolution footgun with `^0.1.x`.
- Rollback: redeploy `f6aefe57045a`.
- Size: **narrow**.

### Option C — do nothing now (A1 dormant)
Leave prod as-is. A1 cannot reproduce because `IU_IMAGE_VERSIONED` is OFF and there are no `[VERSION-GATE]` stale scenes in prod logs.

- Risk: if the flag is later turned ON against orchestration 0.1.4, legacy NULL-row scenes re-enter the endless DIRTY loop.
- Size: zero, but defers the fix.

**Recommendation (one phrase):** **Option B — narrow D1+A1 hotfix on prod code with a non-colliding orchestration version and flag OFF**, because it ships the proven fix with minimal surface and no prod data change.

---

## 7. Summary for chat

- Fix commit `2754bc0f` (was `cac7722b`, amended with `backend/package-lock.json`), pushed on `stage143a-foundation-phase1` (`41cc0313..2754bc0f`). Report committed separately.
- Fresh-clone tests: A1 backend 13/13, A1 package 6/6, `test:arch` 935/24 pending/0, package suite 42/42, full backend 3610 passing / 28 pending / 2 failing (both pre-existing/environmental, unrelated to A1).
- A1 on staging (flag ON): **READY yes, `build_id` stamped yes, cycle stopped yes** (`[VERSION-GATE] stale` flat at 0, 0 `cache_hit`/min for 15 min). Staging left running.
- Prod ↔ branch: **29 commits / stages 105→147** separate prod base `78e8f1ae` from branch tip `2754bc0f`; prod runs orchestration `0.1.4`, flag OFF.
- Prod stuck scenes: **no** (`[VERSION-GATE]` count in last 24 h = 0).
- Recommended release: **Option B — narrow D1+A1 hotfix on prod code, flag OFF.**
