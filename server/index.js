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

// ─── debugger API ─────────────────────────────────────────────
import { execSync as execSyncRaw } from "child_process";

async function runDebugChecks() {
  const checks = {};

  // env vars
  checks.env = {
    label: "Environment Variables",
    items: [
      { name: "ANTHROPIC_API_KEY", ok: !!process.env.ANTHROPIC_API_KEY,
        value: process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY.slice(0,12)+"..." : null,
        fix: "Add ANTHROPIC_API_KEY to your .env file" },
      { name: "REPLICATE_API_KEY", ok: !!process.env.REPLICATE_API_KEY,
        value: process.env.REPLICATE_API_KEY ? process.env.REPLICATE_API_KEY.slice(0,8)+"..." : null,
        warn: !process.env.REPLICATE_API_KEY, fix: "Add REPLICATE_API_KEY — get it at replicate.com" },
      { name: "FAL_API_KEY",       ok: !!process.env.FAL_API_KEY,
        value: process.env.FAL_API_KEY ? process.env.FAL_API_KEY.slice(0,8)+"..." : null,
        warn: true, fix: "Optional fallback — only needed if not using Replicate" },
      { name: "PORT",    ok: true, value: String(process.env.PORT || 3002) },
      { name: "NODE_ENV",ok: true, value: process.env.NODE_ENV || "development" },
    ],
  };

  // deps
  const serverMods = existsSync(join(ROOT, "node_modules"));
  const clientMods = existsSync(join(ROOT, "client", "node_modules"));
  let ffmpegVer = null, ffmpegOk = false;
  try { const r = execSyncRaw("ffmpeg -version 2>&1").toString(); ffmpegVer = r.split("\n")[0].replace("ffmpeg version","").trim().split(" ")[0]; ffmpegOk = true; } catch {}
  checks.deps = {
    label: "Dependencies & Tools",
    items: [
      { name: "Node.js",              ok: true, value: process.version },
      { name: "server node_modules",  ok: serverMods, fix: "Run: npm install" },
      { name: "client node_modules",  ok: clientMods, fix: "Run: npm install --prefix client" },
      { name: "FFmpeg",               ok: ffmpegOk, value: ffmpegVer,
        fix: "macOS: brew install ffmpeg  |  Ubuntu: sudo apt install ffmpeg" },
    ],
  };

  // storage
  const storagePath = existsSync(STORAGE);
  const videosPath  = existsSync(VIDS);
  let dbProjects = null, dbOk = false, dbWarn = false;
  if (existsSync(DB_FILE)) {
    try { dbProjects = readDB().projects.length; dbOk = true; } catch { dbWarn = true; }
  }
  checks.storage = {
    label: "Storage",
    items: [
      { name: "storage/",        ok: storagePath, warn: !storagePath, fix: "Auto-created on first server start" },
      { name: "storage/videos/", ok: videosPath,  warn: !videosPath,  fix: "Auto-created on first server start" },
      { name: "storage/db.json", ok: dbOk || !existsSync(DB_FILE),
        warn: dbWarn || !existsSync(DB_FILE),
        value: dbOk ? `${dbProjects} project(s)` : existsSync(DB_FILE) ? "corrupted!" : "not yet created",
        fix: dbWarn ? "db.json is corrupted — delete it to reset" : null },
    ],
  };

  // anthropic API
  let anthropicOk = false, anthropicMsg = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 16, messages: [{ role: "user", content: "Reply: OK" }] }),
      });
      if (r.ok) { const d = await r.json(); anthropicOk = true; anthropicMsg = d.content?.[0]?.text?.trim(); }
      else { const e = await r.json().catch(()=>{}); anthropicMsg = `HTTP ${r.status}: ${e?.error?.message||"unknown"}`; }
    } catch (e) { anthropicMsg = `Network error: ${e.message}`; }
  }
  checks.anthropic = {
    label: "Anthropic API",
    items: [
      process.env.ANTHROPIC_API_KEY
        ? { name: "API key valid & reachable", ok: anthropicOk, value: anthropicOk ? `Claude replied: "${anthropicMsg}"` : anthropicMsg, fix: anthropicOk ? null : "Check your ANTHROPIC_API_KEY in .env" }
        : { name: "ANTHROPIC_API_KEY", ok: false, fix: "Set ANTHROPIC_API_KEY in .env — get it at console.anthropic.com" },
    ],
  };

  // replicate API
  let replicateOk = false, replicateMsg = null;
  if (process.env.REPLICATE_API_KEY) {
    try {
      const r = await fetch("https://api.replicate.com/v1/account", {
        headers: { Authorization: `Bearer ${process.env.REPLICATE_API_KEY}` },
      });
      if (r.ok) { const d = await r.json(); replicateOk = true; replicateMsg = `Authenticated as: ${d.username||d.name||"unknown"}`; }
      else { const e = await r.json().catch(()=>{}); replicateMsg = `HTTP ${r.status}: ${e?.detail||"invalid key?"}`; }
    } catch (e) { replicateMsg = `Network error: ${e.message}`; }
  }
  checks.replicate = {
    label: "Replicate API",
    items: [
      process.env.REPLICATE_API_KEY
        ? { name: "API key valid & reachable", ok: replicateOk, value: replicateMsg, warn: !replicateOk, fix: replicateOk ? null : "Check your REPLICATE_API_KEY in .env" }
        : { name: "REPLICATE_API_KEY", ok: false, warn: true, fix: "Optional but needed for video generation — get at replicate.com" },
    ],
  };

  return checks;
}

app.get("/api/debug", async (_req, res) => {
  try { res.json(await runDebugChecks()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/debug", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Framegen Debugger</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#080808;color:#ede9e3;font-family:'Courier New',monospace;padding:32px;min-height:100vh}
  h1{color:#e8ff6e;font-size:1.4rem;margin-bottom:4px;letter-spacing:2px}
  .sub{color:#4a4440;font-size:.8rem;margin-bottom:32px}
  .section{background:#0f0f0f;border:1px solid #222;border-radius:8px;margin-bottom:16px;overflow:hidden}
  .section-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #1c1c1c;background:#111}
  .section-title{font-size:.85rem;font-weight:bold;color:#4da6ff;letter-spacing:1px}
  .section-status{font-size:.75rem;padding:2px 8px;border-radius:4px;font-weight:bold}
  .status-ok{background:#1a3a1a;color:#4dff9e}
  .status-warn{background:#3a3a0a;color:#e8ff6e}
  .status-fail{background:#3a0a0a;color:#ff5555}
  .status-loading{background:#1a1a2a;color:#4da6ff}
  .item{display:flex;align-items:flex-start;gap:12px;padding:10px 16px;border-bottom:1px solid #141414}
  .item:last-child{border-bottom:none}
  .dot{margin-top:2px;font-size:1rem;flex-shrink:0}
  .dot-ok{color:#4dff9e}
  .dot-warn{color:#e8ff6e}
  .dot-fail{color:#ff5555}
  .dot-loading{color:#4da6ff;animation:pulse 1s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .item-body{flex:1;min-width:0}
  .item-name{font-size:.82rem;color:#ede9e3}
  .item-value{font-size:.75rem;color:#4dff9e;margin-top:2px;word-break:break-all}
  .item-fix{font-size:.75rem;color:#8a8078;margin-top:3px}
  .item-fix span{color:#e8ff6e}
  .actions{display:flex;gap:10px;margin-bottom:24px;flex-wrap:wrap}
  button{background:#1c1c1c;color:#ede9e3;border:1px solid #2e2e2e;padding:8px 16px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:.8rem;transition:all .15s}
  button:hover{background:#252525;border-color:#4da6ff;color:#4da6ff}
  button.primary{background:#1a2a0a;border-color:#e8ff6e;color:#e8ff6e}
  button.primary:hover{background:#252f0a}
  .spinner{display:inline-block;margin-right:6px}
  .timestamp{color:#4a4440;font-size:.72rem;margin-bottom:16px}
  a{color:#4da6ff;text-decoration:none}
  a:hover{text-decoration:underline}
</style>
</head>
<body>
<h1>⚙ FRAMEGEN DEBUGGER</h1>
<div class="sub">Self-diagnostic dashboard — ${SERVER_URL}</div>

<div class="actions">
  <button class="primary" onclick="runAll()">▶ Run All Checks</button>
  <button onclick="location.href='/'">← Back to App</button>
</div>

<div class="timestamp" id="ts"></div>
<div id="results"></div>

<script>
const SECTIONS = {
  env:      "Environment Variables",
  deps:     "Dependencies & Tools",
  storage:  "Storage",
  anthropic:"Anthropic API",
  replicate:"Replicate API",
};

function renderSkeleton() {
  const el = document.getElementById("results");
  el.innerHTML = Object.entries(SECTIONS).map(([id, label]) => \`
    <div class="section" id="sec-\${id}">
      <div class="section-header">
        <span class="section-title">\${label}</span>
        <span class="section-status status-loading">CHECKING…</span>
      </div>
      <div class="item">
        <div class="dot dot-loading">●</div>
        <div class="item-body"><div class="item-name">Running check…</div></div>
      </div>
    </div>
  \`).join("");
}

function dotClass(item) {
  if (item.ok) return "dot-ok";
  if (item.warn) return "dot-warn";
  return "dot-fail";
}
function dotChar(item) {
  if (item.ok) return "✓";
  if (item.warn) return "⚠";
  return "✗";
}
function sectionStatus(items) {
  if (items.every(i => i.ok)) return ["status-ok","OK"];
  if (items.some(i => !i.ok && !i.warn)) return ["status-fail","ISSUES"];
  return ["status-warn","WARNINGS"];
}

function renderSection(id, data) {
  const [cls, label] = sectionStatus(data.items);
  const itemsHtml = data.items.map(item => \`
    <div class="item">
      <div class="dot \${dotClass(item)}">\${dotChar(item)}</div>
      <div class="item-body">
        <div class="item-name">\${item.name}</div>
        \${item.value ? \`<div class="item-value">\${item.value}</div>\` : ""}
        \${item.fix   ? \`<div class="item-fix"><span>Fix:</span> \${item.fix}</div>\` : ""}
      </div>
    </div>
  \`).join("");
  document.getElementById("sec-"+id).innerHTML = \`
    <div class="section-header">
      <span class="section-title">\${data.label}</span>
      <span class="section-status \${cls}">\${label}</span>
    </div>
    \${itemsHtml}
  \`;
}

async function runAll() {
  renderSkeleton();
  document.getElementById("ts").textContent = "Last run: " + new Date().toLocaleTimeString();
  try {
    const res = await fetch("/api/debug");
    const data = await res.json();
    for (const [id, section] of Object.entries(data)) {
      renderSection(id, section);
    }
  } catch (e) {
    document.getElementById("results").innerHTML =
      \`<div style="color:#ff5555;padding:16px">Failed to fetch diagnostics: \${e.message}</div>\`;
  }
}

runAll();
</script>
</body>
</html>`);
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
