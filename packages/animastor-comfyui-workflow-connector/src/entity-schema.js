// ======================================================
// Entity Schema — Animastor Data Types
// ======================================================
// Defines the catalog of all data entities that can flow
// between backend and ComfyUI workflows.
//
// Each entity has:
//   key     — canonical identifier (used in connectors)
//   label   — human-readable name (for future UI)
//   type    — data type (string, image, audio, video, int, float, number)
//   kind    — 'input' | 'output' | 'parameter' | 'output'
//
// This schema serves as the foundation for:
//   - Connector-to-workflow mapping validation
//   - Future UI workflow configurator
//   - Parameter editing interface

const ENTITIES = {
  // ─── Text / Prompt ──────────────────────────────
  positivePrompt: {
    key: 'positivePrompt',
    label: 'Positive Prompt',
    type: 'string',
    kind: 'input',
    description: 'Main text prompt for generation (image or video)'
  },
  negativePrompt: {
    key: 'negativePrompt',
    label: 'Negative Prompt',
    type: 'string',
    kind: 'input',
    description: 'Negative / undesired content prompt'
  },
  narrationText: {
    key: 'narrationText',
    label: 'Narration Text',
    type: 'string',
    kind: 'input',
    description: 'Text to be synthesized as narration speech'
  },
  voiceInstruction: {
    key: 'voiceInstruction',
    label: 'Voice Instruction',
    type: 'string',
    kind: 'input',
    description: 'Natural language description of the desired voice'
  },
  dialogueScript: {
    key: 'dialogueScript',
    label: 'Dialogue Script',
    type: 'string',
    kind: 'input',
    description: 'Multi-character dialogue script with role markers'
  },
  defaultInstruct: {
    key: 'defaultInstruct',
    label: 'Default Instruction',
    type: 'string',
    kind: 'input',
    description: 'Default TTS instruction for dialogue'
  },

  // ─── Dialogue speakers (voice references, VOICE_REFERENCES.md) ───
  roleName1: {
    key: 'roleName1',
    label: 'Role Name 1',
    type: 'string',
    kind: 'input',
    description: 'Name/ID of dialogue speaker 1'
  },
  speaker1ReferenceAudio: {
    key: 'speaker1ReferenceAudio',
    label: 'Speaker 1 Reference Audio',
    type: 'string',
    kind: 'input',
    description: 'File name (ComfyUI/input) of the locked voice reference of dialogue speaker 1'
  },
  speaker1ReferenceText: {
    key: 'speaker1ReferenceText',
    label: 'Speaker 1 Reference Text',
    type: 'string',
    kind: 'input',
    description: 'Exact transcript of the voice reference of dialogue speaker 1'
  },
  roleName2: {
    key: 'roleName2',
    label: 'Role Name 2',
    type: 'string',
    kind: 'input',
    description: 'Name/ID of dialogue speaker 2'
  },
  speaker2ReferenceAudio: {
    key: 'speaker2ReferenceAudio',
    label: 'Speaker 2 Reference Audio',
    type: 'string',
    kind: 'input',
    description: 'File name (ComfyUI/input) of the locked voice reference of dialogue speaker 2'
  },
  speaker2ReferenceText: {
    key: 'speaker2ReferenceText',
    label: 'Speaker 2 Reference Text',
    type: 'string',
    kind: 'input',
    description: 'Exact transcript of the voice reference of dialogue speaker 2'
  },
  roleName3: {
    key: 'roleName3',
    label: 'Role Name 3',
    type: 'string',
    kind: 'input',
    description: 'Name/ID of dialogue speaker 3'
  },
  speaker3ReferenceAudio: {
    key: 'speaker3ReferenceAudio',
    label: 'Speaker 3 Reference Audio',
    type: 'string',
    kind: 'input',
    description: 'File name (ComfyUI/input) of the locked voice reference of dialogue speaker 3'
  },
  speaker3ReferenceText: {
    key: 'speaker3ReferenceText',
    label: 'Speaker 3 Reference Text',
    type: 'string',
    kind: 'input',
    description: 'Exact transcript of the voice reference of dialogue speaker 3'
  },

  // ─── Voice references ───────────────────────────
  referenceAudio: {
    key: 'referenceAudio',
    label: 'Reference Audio',
    type: 'string',
    kind: 'input',
    description: 'File name (ComfyUI/input) of a voice reference WAV for LoadAudio'
  },
  referenceText: {
    key: 'referenceText',
    label: 'Reference Text',
    type: 'string',
    kind: 'input',
    description: 'Exact transcript of the voice reference (Qwen3TTSVoiceClonePrompt.ref_text)'
  },
  referencePhrase: {
    key: 'referencePhrase',
    label: 'Reference Phrase',
    type: 'string',
    kind: 'input',
    description: 'Template phrase spoken by a voice-reference candidate'
  },
  whisperModel: {
    key: 'whisperModel',
    label: 'Whisper Model',
    type: 'string',
    kind: 'parameter',
    description: 'faster-whisper model size for reference verification (small | medium)'
  },
  whisperDevice: {
    key: 'whisperDevice',
    label: 'Whisper Device',
    type: 'string',
    kind: 'parameter',
    description: 'Device for reference verification (auto | cuda | cpu)'
  },

  // ─── Images ─────────────────────────────────────
  sourceImage: {
    key: 'sourceImage',
    label: 'Source Image',
    type: 'image',
    kind: 'input',
    description: 'Single source image for conditioning'
  },
  sourceImages: {
    key: 'sourceImages',
    label: 'Source Images',
    type: 'image[]',
    kind: 'input',
    description: 'Array of source images for multi-image workflows',
    arrayLength: 4
  },
  mask: {
    key: 'mask',
    label: 'Mask',
    type: 'image',
    kind: 'input',
    description: 'Binary mask for inpainting / compositing'
  },
  characterImage: {
    key: 'characterImage',
    label: 'Character Image',
    type: 'image',
    kind: 'input',
    description: 'Character reference image for consistent appearance'
  },
  coverImage: {
    key: 'coverImage',
    label: 'Cover Image',
    type: 'image',
    kind: 'input',
    description: 'Book cover image'
  },

  // ─── Audio ──────────────────────────────────────
  audio: {
    key: 'audio',
    label: 'Audio',
    type: 'audio',
    kind: 'input',
    description: 'Audio input for conditioning or merging'
  },

  // ─── Generated Outputs ──────────────────────────
  generatedImage: {
    key: 'generatedImage',
    label: 'Generated Image',
    type: 'image',
    kind: 'output',
    description: 'Image generated by the workflow'
  },
  generatedVideo: {
    key: 'generatedVideo',
    label: 'Generated Video',
    type: 'video',
    kind: 'output',
    description: 'Video generated by the workflow'
  },
  generatedAudio: {
    key: 'generatedAudio',
    label: 'Generated Audio',
    type: 'audio',
    kind: 'output',
    description: 'Audio generated by the workflow'
  },
  videoFrames: {
    key: 'videoFrames',
    label: 'Video Frames',
    type: 'video',
    kind: 'output',
    description: 'Raw video frames from LTX model'
  },

  // ─── Parameters ─────────────────────────────────
  totalFrames: {
    key: 'totalFrames',
    label: 'Total Frames',
    type: 'int',
    kind: 'parameter',
    description: 'Total number of video frames to generate'
  },
  frameRate: {
    key: 'frameRate',
    label: 'Frame Rate',
    type: 'float',
    kind: 'parameter',
    description: 'Video frame rate (FPS)'
  },
  width: {
    key: 'width',
    label: 'Width',
    type: 'int',
    kind: 'parameter',
    description: 'Output image/video width in pixels'
  },
  height: {
    key: 'height',
    label: 'Height',
    type: 'int',
    kind: 'parameter',
    description: 'Output image/video height in pixels'
  },
  steps: {
    key: 'steps',
    label: 'Steps',
    type: 'int',
    kind: 'parameter',
    description: 'Number of diffusion sampling steps'
  },
  cfg: {
    key: 'cfg',
    label: 'CFG Scale',
    type: 'float',
    kind: 'parameter',
    description: 'Classifier-free guidance scale'
  },
  sampler: {
    key: 'sampler',
    label: 'Sampler',
    type: 'string',
    kind: 'parameter',
    description: 'Sampling method (euler, dpmpp_2m, etc.)'
  },
  scheduler: {
    key: 'scheduler',
    label: 'Scheduler',
    type: 'string',
    kind: 'parameter',
    description: 'Noise scheduler (normal, karras, etc.)'
  },
  seed: {
    key: 'seed',
    label: 'Seed',
    type: 'int',
    kind: 'parameter',
    description: 'Random seed for reproducibility'
  },
  outputFilenamePrefix: {
    key: 'outputFilenamePrefix',
    label: 'Output Filename Prefix',
    type: 'string',
    kind: 'parameter',
    description: 'Prefix for output file names'
  },
  fps: {
    key: 'fps',
    label: 'FPS',
    type: 'int',
    kind: 'parameter',
    description: 'Frames per second for video'
  },
  quality: {
    key: 'quality',
    label: 'Quality',
    type: 'string',
    kind: 'parameter',
    description: 'Output quality setting (e.g. 320k for audio)'
  },
  language: {
    key: 'language',
    label: 'Language',
    type: 'string',
    kind: 'parameter',
    description: 'Language for TTS output (e.g. Russian, English)'
  },
  temperature: {
    key: 'temperature',
    label: 'Temperature',
    type: 'float',
    kind: 'parameter',
    description: 'Sampling temperature for generation randomness'
  },

  // ─── Guide Frame (LTX) ──────────────────────────
  guideFrameIndex: {
    key: 'guideFrameIndex',
    label: 'Guide Frame Index',
    type: 'int',
    kind: 'parameter',
    description: 'Frame index for LTXVAddGuide node'
  },
  guideStrength: {
    key: 'guideStrength',
    label: 'Guide Strength',
    type: 'float',
    kind: 'parameter',
    description: 'Strength of the guide image influence'
  }
};

// ─── Quick Lookup ─────────────────────────────────
const BY_KEY = {};

for (const [key, def] of Object.entries(ENTITIES)) {
  BY_KEY[key] = def;
}

/**
 * Look up an entity definition by its key.
 * @param {string} key
 * @returns {object|undefined}
 */
function getEntity(key) {
  return BY_KEY[key];
}

/**
 * Return all entities of a given kind.
 * @param {'input'|'output'|'parameter'} kind
 * @returns {object[]}
 */
function getEntitiesByKind(kind) {
  return Object.values(ENTITIES).filter(e => e.kind === kind);
}

/**
 * Return all entities of a given data type.
 * @param {string} type
 * @returns {object[]}
 */
function getEntitiesByType(type) {
  return Object.values(ENTITIES).filter(e => e.type === type);
}

module.exports = {
  ENTITIES,
  getEntity,
  getEntitiesByKind,
  getEntitiesByType
};
