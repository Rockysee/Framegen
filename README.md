# FRAMEGEN — Chat to Video

> Personal AI video production tool. Describe a concept → get a full production blueprint from Claude → generate each scene with open-source video models → stitch into a final MP4.

## Stack

| Layer | Tech |
|---|---|
| Blueprint AI | Claude Sonnet via Anthropic API |
| Video generation | Replicate (Wan 2.1, Wan 2.2 Fast, LTX-Video) |
| Video stitching | FFmpeg (local, free) |
| Backend | Node.js + Express |
| Frontend | React + Vite |
| Storage | Local filesystem + JSON |

All video models are **open-source** (Apache 2.0). No subscriptions — pay only for compute on Replicate.

---

## Quick start

### 1. Prerequisites
- Node.js 18+
- FFmpeg installed (`brew install ffmpeg` / `sudo apt install ffmpeg`)
- [Anthropic API key](https://console.anthropic.com/settings/api-keys)
- [Replicate API key](https://replicate.com/account/api-tokens) ← free credits on signup

### 2. Install & configure

```bash
# Clone / extract to a folder
cd framegen

# Interactive setup wizard (installs deps + writes .env)
npm run setup

# Or manually:
cp .env.example .env
# Edit .env with your keys
npm run install:all
```

### 3. Run

```bash
npm run dev
# Open http://localhost:5174
```

---

## How it works

```
You type a concept in Chat
    ↓
Claude generates a JSON production blueprint
  (title, logline, colour grade, soundtrack, N scenes)
    ↓
Blueprint tab shows each scene with:
  - Shot type + camera move
  - Detailed AI video prompt (60–90 words)
  - Negative prompt
  - Optional narration
    ↓
Click "Generate Scene" or "Generate All"
  → Sends prompt to Replicate
  → Polls for completion (4s intervals)
  → Downloads .mp4 to storage/videos/
    ↓
Timeline tab → preview all clips
  → "Stitch Final MP4" → FFmpeg concatenates all scenes
  → Download your finished video
```

---

## Video models

| Model | Cost | Speed | Quality |
|---|---|---|---|
| Wan 2.1 480p | ~$0.05 / 5s | ~40s | ★★★☆ |
| Wan 2.2 Fast | ~$0.04 / 5s | ~25s | ★★★☆ |
| Wan 2.1 720p | ~$0.08 / 5s | ~150s | ★★★★ |
| LTX-Video | ~$0.019 / run | ~20s | ★★★☆ |

All are open-source and available on Replicate.

---

## Project structure

```
framegen/
├── server/
│   └── index.js          Express API + Claude proxy + Replicate + FFmpeg stitch
├── client/
│   ├── src/
│   │   ├── App.jsx        Main UI (Chat → Blueprint → Timeline)
│   │   ├── api.js         API client (SSE stream + polling)
│   │   ├── constants.js   Models, styles, moods, system prompts
│   │   └── index.css      Global styles
│   └── vite.config.js
├── scripts/
│   └── setup.js           Interactive setup wizard
├── storage/
│   ├── videos/            Generated .mp4 files
│   └── db.json            Project database (auto-created)
├── .env.example
└── package.json
```

---

## Tips for better AI video prompts

- **Be specific**: "a 75-year-old Indian sage with white hair and amber robes" beats "an old man"
- **Include camera move**: "slow dolly into a close-up", "crane shot descending from clouds"
- **Add lighting**: "golden hour backlighting", "soft candlelight", "overcast diffused"
- **State the mood**: "meditative and still", "kinetic and chaotic"
- **Wan 2.1 loves**: clear subjects, defined environments, natural physics
- **LTX loves**: abstract motion, textures, stylised scenes

---

## Adding more models

Edit `server/index.js` → `REPLICATE_MODELS` object.  
Edit `client/src/constants.js` → `MODELS` array.

Any model on Replicate that returns a video URL will work.

---

## License
Personal use. All AI models retain their respective open-source licences (Apache 2.0 for Wan, LTX-Video).
