#!/usr/bin/env node
/**
 * FRAMEGEN — Self Debugger
 * Run: npm run debug
 * Interactive console tool to diagnose and test every layer of the stack.
 */

import { createInterface }                    from "readline";
import { existsSync, readFileSync }           from "fs";
import { join, dirname }                      from "path";
import { fileURLToPath }                      from "url";
import { execSync, exec }                     from "child_process";
import { promisify }                          from "util";
import fetch                                  from "node-fetch";
import dotenv                                 from "dotenv";

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, "..");

dotenv.config({ path: join(ROOT, ".env") });

// ─── colours ──────────────────────────────────────────────────
const R  = s => `\x1b[31m${s}\x1b[0m`;
const G  = s => `\x1b[32m${s}\x1b[0m`;
const Y  = s => `\x1b[33m${s}\x1b[0m`;
const C  = s => `\x1b[36m${s}\x1b[0m`;
const B  = s => `\x1b[34m${s}\x1b[0m`;
const W  = s => `\x1b[1m${s}\x1b[0m`;
const DIM= s => `\x1b[2m${s}\x1b[0m`;

const ok   = msg => console.log(`  ${G("✓")} ${msg}`);
const fail = msg => console.log(`  ${R("✗")} ${msg}`);
const warn = msg => console.log(`  ${Y("⚠")} ${msg}`);
const info = msg => console.log(`  ${B("ℹ")} ${msg}`);
const sep  = ()  => console.log(DIM("  " + "─".repeat(54)));

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, res));

// ─── helpers ──────────────────────────────────────────────────
const SERVER_URL = `http://localhost:${process.env.PORT || 3002}`;

async function serverRunning() {
  try {
    await fetch(`${SERVER_URL}/api/health`, { timeout: 2000 });
    return true;
  } catch { return false; }
}

// ─── checks ───────────────────────────────────────────────────

async function checkEnv() {
  console.log(`\n${W("  Environment Variables")}`);
  sep();

  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) {
    fail(".env file not found");
    info("Run: cp .env.example .env  then add your keys");
    return;
  }
  ok(".env file exists");

  const anthropic = process.env.ANTHROPIC_API_KEY;
  const replicate = process.env.REPLICATE_API_KEY;
  const fal       = process.env.FAL_API_KEY;
  const port      = process.env.PORT || "3002 (default)";

  anthropic
    ? ok(`ANTHROPIC_API_KEY  ${DIM(anthropic.slice(0,10) + "...")}`)
    : fail("ANTHROPIC_API_KEY  not set  ← required for blueprint generation");

  replicate
    ? ok(`REPLICATE_API_KEY  ${DIM(replicate.slice(0,8) + "...")}`)
    : warn("REPLICATE_API_KEY  not set  ← video generation disabled");

  fal
    ? ok(`FAL_API_KEY        ${DIM(fal.slice(0,8) + "...")}`)
    : info("FAL_API_KEY        not set  (optional fallback)");

  info(`PORT               ${port}`);
  info(`CLIENT_URL         ${process.env.CLIENT_URL || "http://localhost:5174 (default)"}`);
  console.log();
}

async function checkDeps() {
  console.log(`\n${W("  Dependencies")}`);
  sep();

  // Node version
  const nodeVer = process.version;
  const [major] = nodeVer.slice(1).split(".").map(Number);
  major >= 18
    ? ok(`Node.js ${nodeVer}`)
    : fail(`Node.js ${nodeVer} — requires 18+`);

  // Server node_modules
  existsSync(join(ROOT, "node_modules"))
    ? ok("Server node_modules installed")
    : fail("Server node_modules missing  ← run: npm install");

  // Client node_modules
  existsSync(join(ROOT, "client", "node_modules"))
    ? ok("Client node_modules installed")
    : fail("Client node_modules missing  ← run: npm install --prefix client");

  // FFmpeg
  try {
    execSync("which ffmpeg", { stdio: "ignore" });
    const { stdout } = await execAsync("ffmpeg -version");
    const ver = stdout.split("\n")[0].replace("ffmpeg version ", "").split(" ")[0];
    ok(`FFmpeg ${ver}`);
  } catch {
    fail("FFmpeg not found  ← brew install ffmpeg  |  sudo apt install ffmpeg");
  }

  console.log();
}

async function checkServer() {
  console.log(`\n${W("  Server Health")}`);
  sep();

  const running = await serverRunning();
  if (!running) {
    fail(`Server not reachable at ${SERVER_URL}`);
    info("Start it with: npm run dev");
    console.log();
    return;
  }

  try {
    const res  = await fetch(`${SERVER_URL}/api/health`);
    const data = await res.json();

    ok(`Server running at ${SERVER_URL}`);
    data.anthropic ? ok("Claude API key  configured") : fail("Claude API key  missing in server env");
    data.replicate ? ok("Replicate key   configured") : warn("Replicate key   not configured");
    data.fal       ? ok("FAL.ai key      configured") : info("FAL.ai key      not configured (optional)");
    info(`Version: ${data.version}`);
  } catch (e) {
    fail(`Health check error: ${e.message}`);
  }
  console.log();
}

async function testAnthropicAPI() {
  console.log(`\n${W("  Testing Anthropic API")}`);
  sep();

  if (!process.env.ANTHROPIC_API_KEY) {
    fail("ANTHROPIC_API_KEY not set — skipping");
    console.log();
    return;
  }

  info("Sending test message to Claude...");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 32,
        messages:   [{ role: "user", content: "Reply with only: OK" }],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      fail(`API error ${res.status}: ${err.error?.message || "unknown"}`);
    } else {
      const data = await res.json();
      const text = data.content?.[0]?.text || "";
      ok(`Claude responded: "${text.trim()}"`);
      info(`Model: ${data.model}  |  Tokens used: ${data.usage?.input_tokens}+${data.usage?.output_tokens}`);
    }
  } catch (e) {
    fail(`Network error: ${e.message}`);
  }
  console.log();
}

async function testReplicateAPI() {
  console.log(`\n${W("  Testing Replicate API")}`);
  sep();

  if (!process.env.REPLICATE_API_KEY) {
    fail("REPLICATE_API_KEY not set — skipping");
    info("Get a free key at https://replicate.com/account/api-tokens");
    console.log();
    return;
  }

  info("Checking Replicate account...");
  try {
    const res = await fetch("https://api.replicate.com/v1/account", {
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_KEY}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      fail(`API error ${res.status}: ${err.detail || "invalid key?"}`);
    } else {
      const data = await res.json();
      ok(`Authenticated as: ${data.username || data.name || "unknown"}`);
      info("Replicate key is valid — video generation ready");
    }
  } catch (e) {
    fail(`Network error: ${e.message}`);
  }
  console.log();
}

async function testBlueprintGeneration() {
  console.log(`\n${W("  Test Blueprint Generation (via local server)")}`);
  sep();

  const running = await serverRunning();
  if (!running) {
    fail(`Server not running. Start it first: npm run dev`);
    console.log();
    return;
  }

  info("Sending test concept to Claude via local server...");
  try {
    const messages   = [{ role: "user", content: "A 15-second clip of a lone astronaut floating in deep space" }];
    const systemPrompt = `You are a video director. Respond ONLY with: {"title":"Test","logline":"test","colorGrade":"dark","soundtrack":"ambient","scenes":[{"id":1,"title":"Space","durationSec":5,"shotType":"WIDE","cameraMove":"STATIC","videoPrompt":"A lone astronaut floating in dark space, stars glimmering, Earth visible in background, deep silence, cinematic wide shot, cold blue light, sense of isolation and wonder","negativePrompt":"text, watermark","narration":"","transition":"cut"}]}`;

    let fullText = "";
    const res = await fetch(`${SERVER_URL}/api/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ messages, systemPrompt }),
    });

    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      fail(`Server error ${res.status}: ${e.error || "unknown"}`);
      console.log();
      return;
    }

    // Read SSE stream
    const decoder = new TextDecoder();
    const reader  = res.body.getReader();
    let buf = "", evt = null, done = false;

    while (!done) {
      const { done: d, value } = await reader.read();
      if (d) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith("event: ")) { evt = line.slice(7).trim(); continue; }
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (evt === "delta") fullText += data.text;
          if (evt === "done")  done = true;
          if (evt === "error") { fail(`Stream error: ${data.message}`); done = true; }
        } catch {}
      }
    }

    try {
      const parsed = JSON.parse(fullText.trim());
      ok("Blueprint JSON received and parsed successfully");
      info(`Title: "${parsed.title}"`);
      info(`Logline: "${parsed.logline}"`);
      info(`Scenes: ${parsed.scenes?.length || 0}`);
    } catch {
      warn("Response received but JSON parse failed");
      info(`Raw (first 200 chars): ${fullText.slice(0, 200)}`);
    }

  } catch (e) {
    fail(`Error: ${e.message}`);
  }
  console.log();
}

async function checkStoragePaths() {
  console.log(`\n${W("  Storage")}`);
  sep();

  const storage = join(ROOT, "storage");
  const videos  = join(storage, "videos");
  const db      = join(storage, "db.json");

  existsSync(storage) ? ok("storage/ directory exists") : warn("storage/ directory missing (auto-created on first run)");
  existsSync(videos)  ? ok("storage/videos/ exists")    : warn("storage/videos/ missing (auto-created on first run)");

  if (existsSync(db)) {
    try {
      const data     = JSON.parse(readFileSync(db, "utf8"));
      const projects = data.projects?.length || 0;
      ok(`storage/db.json  —  ${projects} project(s) saved`);
    } catch {
      fail("storage/db.json exists but is corrupted (invalid JSON)");
    }
  } else {
    info("storage/db.json not yet created (normal on first run)");
  }
  console.log();
}

async function runFullDiagnostic() {
  console.log(`\n${C(W("  ══ FRAMEGEN FULL DIAGNOSTIC ══"))}`);
  await checkEnv();
  await checkDeps();
  await checkServer();
  await checkStoragePaths();
  await testAnthropicAPI();
  await testReplicateAPI();
}

// ─── menu ─────────────────────────────────────────────────────
function printMenu() {
  console.log(`\n${W("  FRAMEGEN DEBUGGER")}`);
  sep();
  console.log(`  ${C("1")}  Full diagnostic (run all checks)`);
  console.log(`  ${C("2")}  Check environment variables`);
  console.log(`  ${C("3")}  Check dependencies & FFmpeg`);
  console.log(`  ${C("4")}  Check server health`);
  console.log(`  ${C("5")}  Test Anthropic API`);
  console.log(`  ${C("6")}  Test Replicate API`);
  console.log(`  ${C("7")}  Test blueprint generation (end-to-end)`);
  console.log(`  ${C("8")}  Check storage paths`);
  sep();
  console.log(`  ${C("q")}  Quit`);
  console.log();
}

async function main() {
  while (true) {
    printMenu();
    const choice = (await ask(`  ${W("Choose an option:")} `)).trim().toLowerCase();
    switch (choice) {
      case "1": await runFullDiagnostic();          break;
      case "2": await checkEnv();                   break;
      case "3": await checkDeps();                  break;
      case "4": await checkServer();                break;
      case "5": await testAnthropicAPI();           break;
      case "6": await testReplicateAPI();           break;
      case "7": await testBlueprintGeneration();    break;
      case "8": await checkStoragePaths();          break;
      case "q":
      case "quit":
      case "exit":
        console.log(`\n  ${G("Goodbye!")}\n`);
        rl.close();
        process.exit(0);
      default:
        warn("Unknown option — enter 1–8 or q");
    }
  }
}

main().catch(e => { console.error(R(`\nFatal: ${e.message}`)); process.exit(1); });
