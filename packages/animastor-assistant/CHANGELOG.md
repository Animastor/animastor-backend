# Changelog

## 0.3.0 (2026-11-18, unpublished)

VBook 4 step 4 (animastor-docs `architecture/VBOOK_FORMAT_V4.md` §8.2). **Breaking.**

- `edit_book` addresses heroes by id: `/heroes/<hero_id>/…` — the segment after
  `/heroes/` is an id, never an array index; the guard (`normalizeHeroPatches`,
  inside `applyPatches`) turns it into the index. `add /heroes/<new_id>` appends a
  hero. Refused with a hint: `/characters`, `/voices`, `/behaviors`,
  `/behavior_rules`, `/mentions`, `/behavior`; computed `/hero_issues`,
  `/scene_list`; replacing / removing the whole `/heroes`; index addressing;
  the id / schema / rev of a hero; `voice.reference` (only the hero card pins a
  reference); removing the narrator.
- `add` creates missing intermediate objects (`/heroes/<id>/behaviour/profile`).
- Edit-mode prompt and the `edit_book` tool describe heroes; participants are
  mapped from `heroes` (exact name or id, case-insensitive — nothing fuzzy).
- Removed: `normalizeBehaviorPatches` and the character-delete cascade of
  `behavior.json` v2 (rules live in the hero file and go with it).
- `chatRequestExtras(input, ai)` — the model extras plus the provider's
  `disable_thinking` / `reasoning_effort` through the injected
  `deps.withReasoning` (the host's `ai-reasoning.js`); both chat routes use it.
  Without the injection the body is the one of 0.2.0.

## 0.2.0 (2026-11-10, unpublished)

- Edit-mode prompt and `edit_book` tool describe behavior.json schema v2:
  entries at `/behaviors/characters/{character_id}`.
- Deterministic guard inside `applyPatches` (exported as
  `normalizeBehaviorPatches`): on a v2 book, legacy `/behaviors/<id>…` paths
  are rewritten to `/behaviors/characters/<id>…`, and a flat map written to
  `/behaviors` becomes `characters` while `rules`/`schema_version` survive.
- Character-delete cascade in `applyPatches`: a character removed by the
  patches loses its `behaviors.characters` entry and its `scope:"character"`
  rules (same contract as the editor).

## 0.1.1

- Fix: `enable_thinking` is sent only to providers that accept it
  (`supportsEnableThinking`: qwen* models, not on NVIDIA endpoints). Strict
  OpenAI-compatible gateways (integrate.api.nvidia.com) rejected every chat
  turn with 400 "Unsupported parameter(s): enable_thinking".
- A 400 "Unsupported parameter" on a body carrying non-standard fields is
  retried once without them (streaming and non-streaming routes).
- Upstream errors reach the user as `AI API error <status>: <provider message>`
  (key-looking strings masked) instead of the bare status.
- New export `buildChatRequestExtras` so the host provider connection test
  sends the same body extras as the chat.

## 0.1.0

- Initial publishable release of `@animastor/assistant`.
- Chat engine: persona/system prompt assembly, book context (full + compact),
  mode/topic prompts, `edit_book` tool, response parsing and the validated
  JSON-patch pipeline with scene-participants normalization.
- HTTP contour: `/api/v1/ai/*` session CRUD, non-streaming chat and SSE
  streaming (`meta` / `delta` / `done` / `error`).
- Contracts: `AssistantPorts` + chat-session repository interfaces with
  fail-fast assertions.
- Host-agnostic: zero runtime dependencies, no filesystem, no ambient env
  reads; persona content arrives as injected `aiProfile`.
