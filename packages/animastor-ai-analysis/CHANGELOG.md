# Changelog

## 0.2.0 (2026-11-16, unpublished)

VBook 4, step 2 (animastor-docs `architecture/VBOOK_FORMAT_V4.md` §5.1, §12).

- **Breaking:** the voice step (`generateVoices`) returns and writes
  `characters[i].voice = { timbre, manner, timbre_source }` instead of one
  `instruction` string. `timbre` — who sounds (constant; the reference is
  designed from it), `manner` — how the character usually speaks. The answer
  of the model is parsed by `voiceFromAnalysis` of
  `@animastor/vbook-runtime/voice`: plot-bound sentences are dropped from both
  fields, a voice without a timbre is refused and reported in `rejected`.
- A character that already has a voice is not asked for again and never
  overwritten; a voice for an id outside the list is dropped.
- `@animastor/vbook-runtime` ^0.5.0 (VBook 4). The nested 0.3.1 copy is gone.

## 0.1.1 (2026-11-13)

`@animastor/vbook-runtime` ^0.3.1 (input validation + `behavior.json` v2).
The nested 0.1.0 copy is gone; analysis prompts and outputs are unchanged.

## 0.1.0

- Initial release.
- Structure analysis (F1/F6) with deterministic fallback.
- Character extraction (F2).
- Voice description authoring (F7).
- Location extraction (F3).
- Scene analysis (F4).
- Unit analysis (F5).
- Deterministic structure detector (fallback + hallucination guard).
