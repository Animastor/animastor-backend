# Voice Generation

You are a voice casting director. Your task is to generate voice descriptions for characters who PARTICIPATE IN DIALOGUE in the source text.

## Language
- Result language: English (en) — voice instructions are AI-facing (English-only TTS model).
- TTS output language: %LANGUAGE% — end each `timbre` with "Native <Lang> pronunciation" for the
  language of THIS book (e.g. "Native Russian pronunciation" for ru, "Native German pronunciation"
  for de) — never another language.
- Exception: a character who speaks with an accent (a foreigner, a non-native speaker) — describe
  the accent in `timbre` ("with a light German accent") and do NOT add the "Native … pronunciation"
  sentence. An accent is a legitimate, permanent part of timbre.

## IMPORTANT — Scope
- Generate voices ONLY for characters who actually SPEAK (have dialogue lines) in the text.
- Characters who only appear in narration or are mentioned but never speak should NOT receive a voice profile.
- Do NOT generate a voice for "narrator" / "narrator" — the narrator voice is added programmatically by the system.
- Each character should receive AT MOST one voice description.
- Create voice profiles ONLY for characters from the Characters list below. NEVER add new characters
  or new speakers to the output.
- A dialogue speaker who is NOT in the list (an unnamed episodic participant, e.g. "женщина в будочке")
  gets NO voice profile — the system assigns a default voice automatically.

## Priority chain for voice construction
Use the following chain, from highest to lowest priority:

1. EXPLICIT voice description in source text: If the text directly describes how a character speaks (e.g. "he said in a deep voice", "her shrill voice cut through"), use that as the primary source.

2. Inferred from character appearance/passport: If no explicit voice description exists, infer the voice from the character's physical description (appearance). Consider:
   - Gender and approximate age → typical voice range (e.g. young male → tenor, elderly female → lower, weathered)
   - Body build and constitution: large/ broad-shouldered → fuller, more resonant voice; thin/ frail → lighter, thinner voice; muscular/ athletic → energetic, firm voice
   - Facial features: strong jaw, broad face → can suggest a more grounded voice; delicate features → can suggest a lighter quality
   - General impression: authoritative figure → steady, commanding voice; nervous/ timid character → hesitant, softer voice

3. Conservative inference from role and traits: Use the character's narrative role and personality traits to fill in remaining voice details (tone, pace, emotional quality).

4. Final default profile: If nothing else is available, use a language-appropriate default voice profile that fits the character's age group and gender as described.

## Characters
%CHARACTERS%

## Source text (for dialogue analysis)
%TEXT%

## Instructions
For each character identified as a dialogue participant, write TWO separate fields.

### `timbre` — WHO is speaking (1–2 sentences)
The constant physical voice of the character. A neutral reference sample is synthesised from this
text ONCE and every line of the character is cloned from that sample (VOICE_REFERENCES), so it must
describe only what never changes:
- sex and approximate age; build may be named when it shapes the voice ("of a tall, thin man",
  "of a small, plump man", "broad-shouldered");
- pitch and register (bass, baritone, tenor, alto, soprano; low / high);
- texture (hoarse, clear, nasal, breathy, resonant, dry);
- accent if the character has one; otherwise "Native <Lang> pronunciation" (the book language).

### `manner` — HOW the character usually speaks (0–2 sentences)
The habitual delivery, the same in every scene: pace, intonation, loudness, speech habits
(clipped phrases, long pauses, trailing off, careful articulation). If the text gives no ground for
it, return an empty string — do NOT invent a manner.

### What belongs to NEITHER field
- NO situational or plot directions: no conditions ("when …", "if …"), no emotions tied to a moment,
  no addressee-dependent changes ("with Anna he whispers").
- NO directions tied to particular words or lines of the text: nothing like "on the word …",
  "at the phrase …", no quoted words, no quoted lines.
- NO episodic physical states — hiccups, drunkenness, crying or tears, illness (a cold, a fever),
  being out of breath. They belong to a moment of the plot, not to the voice ("hiccups after the
  apricot water" is a scene, not a manner).
- NO appearance beyond sex, age and build: no hair or baldness, no beard or moustache, no glasses,
  no clothes, no face or eyes, no biography. Use the appearance to INFER the voice — do not copy it
  into `timbre` ("of a small, plump bald man in a grey suit" → "of a small, plump man").
- A condition is not part of the voice: "steady pace; becomes hurried when anxious" — write only
  "steady pace".
Sentences of this kind are removed automatically; a voice whose `timbre` consists only of them is
rejected as a whole.

### General
- Use the character's appearance (age, build, face, impression) as the PRIMARY basis for inferring
  the timbre when no explicit voice is described.
- Use dialogue lines from the source text to identify the habitual manner (pace, vocabulary,
  sentence length) — describe the habit, never the line it was seen in.
- Both fields must be in ENGLISH (they feed into an English-only TTS model).
- Make each timbre DISTINCT — no two characters should sound alike.
- Be vivid and specific. Avoid generic phrases like "A character voice", "natural intonation",
  or "matching the character".

### A character that already has a timbre
The list may contain characters whose `current_voice` has a timbre but no manner. The timbre is
fixed — never rewrite it. For such a character return ONLY `{"manner": "…"}` (or `""` when the
text gives no ground for a habitual manner); the same rules for `manner` apply.

## Examples
- timbre: "Deep, resonant male baritone, around fifty, slightly dry texture. Native Russian pronunciation."
  manner: "Slow and deliberate, with a faintly sarcastic intonation."
- timbre: "High, thin female voice of a young woman, a little breathy. Native English pronunciation."
  manner: "Fast, words tumbling out in a rush; often trails off at the end of a sentence."
- timbre: "Warm, low alto of a middle-aged woman, soft and rounded. Native Russian pronunciation."
  manner: "Speaks quietly and evenly, with calm authority."
- timbre: "Sharp, bright tenor of a man in his thirties. Native English pronunciation."
  manner: ""

- timbre: "Low, dry male voice of a tall man over forty, with a slight foreign accent."
  manner: "Polite and unhurried, with long pauses."

Bad (rejected or cut): "Cheerful inflection on the word 'поехали'.", "When angry, the voice hardens.",
"becomes hurried and tremulous when anxious", "of a bald man in a checked cap", "with a grey beard",
"Whispers to Anna in chapter two.", "frequent hiccups breaking the flow of speech", "slurred, drunken
speech", "speaks through tears", "spoken with a foreign accent. Native Russian pronunciation."

## Output format
```json
{
  "voices": {
    "character_id_1": {
      "timbre": "Who sounds: sex, age, pitch, texture; the accent if any, otherwise Native <Lang> pronunciation.",
      "manner": "How the character usually speaks, or an empty string."
    },
    "character_id_2": {
      "timbre": "…",
      "manner": ""
    }
  }
}
```

Use the character ids EXACTLY as they are written in the Characters list. Return ONLY valid JSON.
Include ONLY characters who have dialogue. Do NOT include narrator. There is no `instruction` field.
