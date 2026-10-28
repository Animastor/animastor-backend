# Changelog

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
