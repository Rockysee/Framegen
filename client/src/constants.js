// ─── Video models available on Replicate ──────────────────────
export const MODELS = [
  {
    id:       "wan-480p",
    name:     "Wan 2.1 · 480p",
    badge:    "CHEAPEST",
    badgeColor: "#4dff9e",
    cost:     "~$0.05 / 5s clip",
    time:     "~40s",
    res:      "480p",
    desc:     "Alibaba open-source. Best bang-for-buck. Good motion, decent quality.",
    numFrames: 81,
  },
  {
    id:       "wan-fast",
    name:     "Wan 2.2 Fast",
    badge:    "FAST",
    badgeColor: "#4da6ff",
    cost:     "~$0.04 / 5s clip",
    time:     "~25s",
    res:      "480p",
    desc:     "Optimised Wan 2.2. Quicker turnaround, slightly less detail.",
    numFrames: 81,
  },
  {
    id:       "wan-720p",
    name:     "Wan 2.1 · 720p",
    badge:    "HD",
    badgeColor: "#e8ff6e",
    cost:     "~$0.08 / 5s clip",
    time:     "~150s",
    res:      "720p",
    desc:     "Higher resolution, cinematic output. Takes ~2min per scene.",
    numFrames: 81,
  },
  {
    id:       "ltx",
    name:     "LTX-Video",
    badge:    "REALTIME",
    badgeColor: "#ff6b35",
    cost:     "~$0.019 / run",
    time:     "~20s",
    res:      "768×512",
    desc:     "Lightricks open-source. Near real-time, great for rapid iteration.",
    numFrames: 97,
  },
];

// ─── Visual styles ─────────────────────────────────────────────
export const STYLES = [
  { id: "cinematic",   label: "Cinematic",    emoji: "🎥", color: "#4da6ff",
    hint: "anamorphic lens, shallow DOF, film grain, golden hour, dramatic shadows" },
  { id: "documentary", label: "Documentary",  emoji: "📽", color: "#4dff9e",
    hint: "handheld camera, natural light, raw authentic feel, observational" },
  { id: "anime",       label: "Anime",        emoji: "✨", color: "#b57eff",
    hint: "vibrant colors, expressive characters, stylized backgrounds, motion blur" },
  { id: "commercial",  label: "Commercial",   emoji: "📺", color: "#ffd166",
    hint: "clean bright lighting, product-forward, modern minimalism, sharp focus" },
  { id: "musicvideo",  label: "Music Video",  emoji: "🎵", color: "#ff6b9d",
    hint: "rhythmic fast cuts, bold colors, abstract metaphors, surreal elements" },
  { id: "scifi",       label: "Sci-Fi",       emoji: "🚀", color: "#00e5ff",
    hint: "neon lighting, futuristic tech, volumetric fog, lens flares, space" },
];

// ─── Moods ─────────────────────────────────────────────────────
export const MOODS = [
  "Epic", "Intimate", "Surreal", "Energetic", "Melancholic",
  "Mysterious", "Dreamlike", "Tense", "Joyful", "Raw",
];

// ─── Duration → scene count ────────────────────────────────────
export const DURATION_OPTIONS = [
  { label: "15s",    scenes: 2 },
  { label: "30s",    scenes: 4 },
  { label: "60s",    scenes: 6 },
  { label: "90s",    scenes: 9 },
  { label: "2 min",  scenes: 12 },
];

// ─── Build the Claude system prompt ───────────────────────────
export function buildSystemPrompt({ style, mood, duration, sceneCount, modelId }) {
  const styleInfo = STYLES.find(s => s.id === style) || STYLES[0];
  const modelInfo = MODELS.find(m => m.id === modelId) || MODELS[0];

  return `You are a world-class video director and AI prompt engineer.

Given a video concept, produce a JSON production blueprint — no prose, no markdown fences, raw JSON only.

SCHEMA (strict — every field required):
{
  "title": "short punchy title (3–6 words)",
  "logline": "one sentence — the emotional core of the video",
  "colorGrade": "colour palette description (e.g. 'Teal & orange, high contrast, filmic')",
  "soundtrack": "music style description (e.g. 'Slow build orchestral, then drops into heavy drums')",
  "scenes": [
    {
      "id": 1,
      "title": "Scene title",
      "durationSec": 5,
      "shotType": "EXTREME WIDE / WIDE / MEDIUM / CLOSE-UP / EXTREME CLOSE-UP / OVERHEAD",
      "cameraMove": "STATIC / SLOW PAN / DOLLY IN / HANDHELD / CRANE DOWN / etc",
      "videoPrompt": "Self-contained, vivid AI video prompt. Include: subject + action, environment, lighting style, camera movement, colour grade, mood. Must be 60–90 words. No references to other scenes.",
      "negativePrompt": "text, watermark, blurry, low quality, static, distorted, artifacts",
      "narration": "optional voice-over line or leave empty string",
      "transition": "cut / dissolve / match-cut / fade-to-black"
    }
  ]
}

Rules:
- Generate exactly ${sceneCount} scenes totalling approximately ${duration}
- Style: ${styleInfo.label} — use these visual cues in prompts: ${styleInfo.hint}
- Mood: ${mood}
- Target model: ${modelInfo.name} (${modelInfo.res}) — write prompts this model handles well
- videoPrompt MUST be self-contained and richly descriptive
- Vary shot types and camera moves across scenes
- Output ONLY the JSON object. Zero preamble, zero explanation, zero backticks.`;
}

// ─── Refinement quick-prompts ─────────────────────────────────
export const QUICK_REFINES = [
  "Make the scenes more visually dynamic — add extreme camera movements",
  "Darken the mood — more shadows, tension, emotional weight",
  "Simplify each scene — fewer elements, cleaner for AI to generate",
  "Add more human close-ups — faces and emotions",
  "Make it feel more surreal and abstract",
  "Boost the energy — faster implied pacing, more movement",
];
