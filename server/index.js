/**
 * FRAMEGEN — Server
 * Chat → Blueprint → Video pipeline backend
 *
 * Supported video providers:
 *   • Replicate  — wavespeedai/wan-2.1-t2v-480p  (cheapest, open-source)
 *                  wavespeedai/wan-2.1-t2v-720p  (better quality)
 *                  lightricks/ltx-video           (fastest, ~$0.019/run)
 *                  wan-video/wan-2.2-t2v-fast     (cheap + good quality)
 *   • FAL.ai     — fal-ai/wan/v2.1/t2v           (fallback)
 */

import express            from "express";
import cors               from "cors";
import helmet             from "helmet";
import rateLimit          from "express-rate-limit";
import fetch              from "node-fetch";
import { exec }           from "child_process";
import { promisify }      from "util";
import { createWriteStream, existsSync, mkdirSync,
         readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname }  from "path";
import { fileURLToPath }  from "url";
import { v4 as uuid }     from "uuid";
import dotenv             from "dotenv";

const execAsync  = promisify(exec);
const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT       = join(__dirname, "..");

dotenv.config({ path: join(ROOT, ".env") });

// ─── storage ──────────────────────────────────────────────────
const STORAGE  = join(ROOT, "storage");
const VIDS     = join(STORAGE, "videos");
const DB_FILE  = join(STORAGE, "db.json");

[STORAGE, VIDS].forEach(d => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

function readDB()  { try { return JSON.parse(readFileSync(DB_FILE, "utf8")); } catch { return { projects: [] }; } }
function writeDB(d){ writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); }

// ─── app ───────────────────────────────────────────────────────
const app        = express();
const PORT       = Number(process.env.PORT) || 3002;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5174";

app.use(helmet({ contentSecurityPolicy: false }));
// Production: React build served by same server (same-origin). Dev: proxy to separate Vite dev server.
const corsOrigin = process.env.NODE_ENV === "production" ? true : CLIENT_URL;
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: "200kb" }));
app.use("/videos", express.static(VIDS));                // serve generated clips
app.use("/api/", rateLimit({ windowMs: 60_000, max: 120 }));

// ─── helpers ──────────────────────────────────────────────────
async function downloadToFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const stream = createWriteStream(dest);
  await new Promise((ok, fail) => {
    res.body.pipe(stream);
    res.body.on("error", fail);
    stream.on("finish", ok);
  });
}

// ─── health ───────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({
  ok:        true,
  anthropic: !!process.env.ANTHROPIC_API_KEY,
  replicate: !!process.env.REPLICATE_API_KEY,
  fal:       !!process.env.FAL_API_KEY,
  ffmpeg:    true,
  version:   "1.0.0",
}));

// ─── Claude streaming chat ────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { messages, systemPrompt } = req.body;
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured in .env" });

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  const send = (evt, data) => res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":    "application/json",
        "x-api-key":       process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-20250514",
        max_tokens: 4096,
        stream:     true,
        system:     systemPrompt || "",
        messages,
      }),
    });

    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      send("error", { message: err.error?.message || `Claude API ${upstream.status}` });
      return res.end();
    }

    const reader  = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta")
            send("delta", { text: evt.delta.text });
          if (evt.type === "message_stop") send("done", {});
        } catch { /* ignore parse errors on partial chunks */ }
      }
    }
    res.end();
  } catch (err) {
    send("error", { message: err.message });
    res.end();
  }
});

// ─── model catalogue ──────────────────────────────────────────
// Replicate model slugs verified March 2026
const REPLICATE_MODELS = {
  "wan-480p":    "wavespeedai/wan-2.1-t2v-480p",   // ~$0.05/run, 5s, fastest
  "wan-720p":    "wavespeedai/wan-2.1-t2v-720p",   // ~$0.08/run, 5s, better quality
  "wan-fast":    "wan-video/wan-2.2-t2v-fast",      // very fast + cheap, great for drafts
  "ltx":         "lightricks/ltx-video",            // ~$0.019/run, near real-time
};

// ─── start video generation ───────────────────────────────────
app.post("/api/generate-scene", async (req, res) => {
  const {
    prompt,
    negativePrompt = "blurry, low quality, text overlay, watermark, distorted faces, static, no motion",
    model   = "wan-480p",
    sceneId,
    numFrames = 81,       // ~5s at 16fps
  } = req.body;

  if (!prompt?.trim())
    return res.status(400).json({ error: "prompt is required" });

  // ── Replicate ─────────────────────────────────────────────
  if (process.env.REPLICATE_API_KEY) {
    const modelSlug = REPLICATE_MODELS[model] || REPLICATE_MODELS["wan-480p"];

    try {
      const createRes = await fetch(
        `https://api.replicate.com/v1/models/${modelSlug}/predictions`,
        {
          method:  "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization:  `Bearer ${process.env.REPLICATE_API_KEY}`,
          },
          body: JSON.stringify({
            input: {
              prompt,
              negative_prompt: negativePrompt,
              num_frames:      numFrames,
              num_inference_steps: 30,
              guidance_scale:      5.0,
              seed:            Math.floor(Math.random() * 999999),
            },
          }),
        }
      );

      if (!createRes.ok) {
        const e = await createRes.json().catch(() => ({}));
        throw new Error(e.detail || e.error || `Replicate ${createRes.status}`);
      }

      const pred = await createRes.json();
      return res.json({
        provider:     "replicate",
        predictionId: pred.id,
        model:        modelSlug,
        status:       "processing",
        sceneId,
      });
    } catch (err) {
      console.error("Replicate error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── FAL.ai fallback ───────────────────────────────────────
  if (process.env.FAL_API_KEY) {
    try {
      const falRes = await fetch("https://queue.fal.run/fal-ai/wan/v2.1/t2v", {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Key ${process.env.FAL_API_KEY}`,
        },
        body: JSON.stringify({ prompt, negative_prompt: negativePrompt, num_frames: numFrames }),
      });
      if (!falRes.ok) throw new Error(`FAL ${falRes.status}`);
      const d = await falRes.json();
      return res.json({ provider: "fal", requestId: d.request_id, status: "processing", sceneId });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(400).json({
    error: "No video API key found. Add REPLICATE_API_KEY to your .env file.\nGet a free key at https://replicate.com",
  });
});

// ─── poll status ───────────────────────────────────────────────
app.get("/api/poll/:provider/:id", async (req, res) => {
  const { provider, id } = req.params;

  try {
    if (provider === "replicate") {
      const r    = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
        headers: { Authorization: `Bearer ${process.env.REPLICATE_API_KEY}` },
      });
      const data = await r.json();

      if (data.status === "succeeded") {
        // output can be a URL string or array
        const remoteUrl = Array.isArray(data.output) ? data.output[0] : data.output;
        const filename  = `${id}.mp4`;
        const localPath = join(VIDS, filename);
        if (!existsSync(localPath)) await downloadToFile(remoteUrl, localPath);
        return res.json({ status: "succeeded", videoUrl: `/videos/${filename}` });
      }
      if (data.status === "failed")
        return res.json({ status: "failed", error: data.error || "Prediction failed" });

      // still processing — return current logs
      return res.json({ status: data.status || "processing", logs: (data.logs || "").slice(-400) });
    }

    if (provider === "fal") {
      const r    = await fetch(`https://queue.fal.run/fal-ai/wan/v2.1/t2v/requests/${id}`, {
        headers: { Authorization: `Key ${process.env.FAL_API_KEY}` },
      });
      const data = await r.json();
      if (data.status === "COMPLETED") {
        const remoteUrl = data.response_body?.video?.url;
        if (remoteUrl) {
          const filename  = `${id}.mp4`;
          const localPath = join(VIDS, filename);
          if (!existsSync(localPath)) await downloadToFile(remoteUrl, localPath);
          return res.json({ status: "succeeded", videoUrl: `/videos/${filename}` });
        }
      }
      if (data.status === "FAILED") return res.json({ status: "failed", error: "FAL generation failed" });
      return res.json({ status: "processing" });
    }

    res.status(400).json({ error: "Unknown provider" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── FFmpeg stitch ─────────────────────────────────────────────
app.post("/api/stitch", async (req, res) => {
  const { sceneFiles = [], projectTitle = "video" } = req.body;

  const resolved = sceneFiles
    .map(f => join(VIDS, f.replace(/^\/videos\//, "")))
    .filter(existsSync);

  if (resolved.length < 1)
    return res.status(400).json({ error: "No valid scene files to stitch." });

  const outId   = uuid();
  const listTxt = join(VIDS, `${outId}.txt`);
  const outFile = join(VIDS, `${outId}_final.mp4`);

  writeFileSync(listTxt, resolved.map(f => `file '${f}'`).join("\n"));

  try {
    await execAsync(
      `ffmpeg -y -f concat -safe 0 -i "${listTxt}" ` +
      `-c:v libx264 -crf 22 -preset fast -movflags +faststart "${outFile}"`
    );
    try { unlinkSync(listTxt); } catch {}
    res.json({ videoUrl: `/videos/${outId}_final.mp4` });
  } catch (err) {
    try { unlinkSync(listTxt); } catch {}
    console.error("FFmpeg error:", err.message);
    res.status(500).json({ error: "FFmpeg stitch failed: " + err.stderr || err.message });
  }
});

// ─── projects CRUD ─────────────────────────────────────────────
app.get("/api/projects", (_req, res) => {
  const { projects } = readDB();
  const list = projects
    .map(({ id, title, style, mood, duration, sceneCount, status, createdAt, updatedAt }) =>
      ({ id, title, style, mood, duration, sceneCount, status, createdAt, updatedAt }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ projects: list });
});

app.post("/api/projects", (req, res) => {
  const { id, ...fields } = req.body;
  const db  = readDB();
  const now = new Date().toISOString();
  if (id) {
    const i = db.projects.findIndex(p => p.id === id);
    if (i >= 0) {
      db.projects[i] = { ...db.projects[i], ...fields, sceneCount: fields.scenes?.length ?? db.projects[i].sceneCount, updatedAt: now };
      writeDB(db);
      return res.json({ id });
    }
  }
  const newId = uuid();
  db.projects.push({ id: newId, ...fields, sceneCount: fields.scenes?.length || 0, createdAt: now, updatedAt: now });
  writeDB(db);
  res.json({ id: newId });
});

app.get("/api/projects/:id", (req, res) => {
  const p = readDB().projects.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json(p);
});

app.delete("/api/projects/:id", (req, res) => {
  const db = readDB();
  db.projects = db.projects.filter(p => p.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// ─── production: serve built client ───────────────────────────
const DIST = join(ROOT, "client", "dist");
if (process.env.NODE_ENV === "production" && existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get("*", (_, res) => res.sendFile(join(DIST, "index.html")));
}

// ─── boot ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  const line = (label, val) => console.log(`   ${label.padEnd(12)} ${val}`);
  console.log(`\n🎬  FRAMEGEN — Chat to Video`);
  line("Server",  `http://localhost:${PORT}`);
  if (process.env.NODE_ENV !== "production") line("Client", CLIENT_URL);
  line("Claude",    process.env.ANTHROPIC_API_KEY ? "✓ configured" : "✗ missing (required)");
  line("Replicate", process.env.REPLICATE_API_KEY ? "✓ configured" : "✗ not set");
  line("FAL.ai",    process.env.FAL_API_KEY        ? "✓ configured" : "– not set");
  if (!process.env.REPLICATE_API_KEY && !process.env.FAL_API_KEY)
    console.log("\n   ⚠  No video API key found. Video generation will be disabled.");
  console.log();
});
