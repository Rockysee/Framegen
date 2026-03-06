import { useState, useRef, useEffect, useCallback } from "react";
import { chatStream, startGeneration, pollUntilDone, stitchScenes, db } from "./api.js";
import { MODELS, STYLES, MOODS, DURATION_OPTIONS, buildSystemPrompt, QUICK_REFINES } from "./constants.js";

// ─────────────────────────────────────────────────────────────
// Tiny design system
// ─────────────────────────────────────────────────────────────

const css = Object.assign;   // short alias for style merging

const C = {                  // colour tokens
  bg:       "#080808",
  s1:       "#0f0f0f",
  s2:       "#151515",
  s3:       "#1c1c1c",
  s4:       "#252525",
  b1:       "#222",
  b2:       "#2e2e2e",
  b3:       "#3a3a3a",
  text:     "#ede9e3",
  t2:       "#8a8078",
  t3:       "#4a4440",
  t4:       "#2a2420",
  accent:   "#e8ff6e",
  blue:     "#4da6ff",
  green:    "#4dff9e",
  red:      "#ff5555",
  orange:   "#ff6b35",
};

function Spin({ size = 14 }) {
  return (
    <div style={{
      width: size, height: size, flexShrink: 0,
      border: `2px solid ${C.b3}`,
      borderTopColor: C.accent,
      borderRadius: "50%",
      animation: "spin .7s linear infinite",
    }} />
  );
}

function Badge({ children, color = C.accent }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: ".1em",
      padding: "2px 6px", borderRadius: 4,
      background: color + "22", color, border: `1px solid ${color}44`,
    }}>
      {children}
    </span>
  );
}

function Btn({ onClick, disabled, variant = "primary", size = "md", icon, children, title, style: s = {} }) {
  const base = {
    display: "inline-flex", alignItems: "center", gap: 6,
    border: "none", cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "var(--sans)", fontWeight: 500, letterSpacing: ".03em",
    opacity: disabled ? .4 : 1, transition: "opacity .15s, background .15s",
    borderRadius: 7,
  };
  const sizes   = { sm: { padding: "5px 11px", fontSize: 11 }, md: { padding: "8px 16px", fontSize: 13 }, lg: { padding: "11px 22px", fontSize: 14 } };
  const variants = {
    primary:   { background: C.accent,  color: "#111" },
    secondary: { background: C.s3,      color: C.t2,   border: `1px solid ${C.b2}` },
    ghost:     { background: "none",     color: C.t3 },
    danger:    { background: "none",     color: C.red,  border: `1px solid ${C.red}44` },
    green:     { background: C.green+"22", color: C.green, border: `1px solid ${C.green}44` },
  };
  return (
    <button onClick={disabled ? undefined : onClick} disabled={disabled} title={title}
      style={css({}, base, sizes[size] || sizes.md, variants[variant] || variants.primary, s)}>
      {icon}<span>{children}</span>
    </button>
  );
}

function Toast({ msg, type = "info", onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 5000); return () => clearTimeout(t); }, [onClose]);
  const colors = { success: C.green, error: C.red, info: C.blue, warn: C.orange };
  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24, zIndex: 9999,
      padding: "11px 16px", borderRadius: 9,
      background: C.s2, border: `1px solid ${(colors[type] || C.blue)}55`,
      color: colors[type] || C.blue, fontSize: 13, maxWidth: 380,
      animation: "fadeUp .25s ease", boxShadow: "0 8px 30px #00000088",
    }}>
      {msg}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Scene card
// ─────────────────────────────────────────────────────────────

function SceneCard({ scene, idx, onGenerate, onRegen, busy }) {
  const [expanded, setExpanded] = useState(false);
  const st = scene.genStatus || "idle";
  const statusColor = { idle: C.b2, generating: C.blue, succeeded: C.green, failed: C.red }[st] || C.b2;

  return (
    <div className="fade-up" style={{
      background: C.s1, border: `1px solid ${statusColor}55`,
      borderRadius: 10, overflow: "hidden",
    }}>
      {/* ── header ── */}
      <div style={{
        padding: "10px 14px", display: "flex", alignItems: "center", gap: 10,
        borderBottom: `1px solid ${C.b1}`, cursor: "pointer",
      }} onClick={() => setExpanded(e => !e)}>
        <div style={{
          width: 26, height: 26, flexShrink: 0, borderRadius: 5,
          background: C.s3, border: `1px solid ${statusColor}88`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "var(--mono)", fontSize: 11, color: C.t3,
        }}>
          {idx + 1}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {scene.title}
          </div>
          <div style={{ fontSize: 10, color: C.t3, marginTop: 1 }}>
            {scene.shotType}  ·  {scene.cameraMove}  ·  {scene.durationSec}s
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {st === "generating" && <Spin size={13} />}
          {st === "succeeded"  && <span style={{ color: C.green, fontSize: 13 }}>✓</span>}
          {st === "failed"     && <span style={{ color: C.red,   fontSize: 13 }}>✗</span>}
          <span style={{ fontSize: 9, color: statusColor, letterSpacing: ".12em" }}>{st.toUpperCase()}</span>
          <span style={{ color: C.t4, fontSize: 12 }}>{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {/* ── expanded body ── */}
      {expanded && (
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Prompt */}
          <div>
            <div style={labelStyle}>Video Prompt</div>
            <div style={{
              padding: "9px 12px", background: C.bg, borderRadius: 6,
              fontSize: 11, color: C.t2, lineHeight: 1.7, fontFamily: "var(--mono)",
            }}>
              {scene.videoPrompt}
            </div>
          </div>

          {/* Negative */}
          <div>
            <div style={labelStyle}>Negative</div>
            <div style={{ fontSize: 10, color: C.t4, fontFamily: "var(--mono)" }}>
              {scene.negativePrompt}
            </div>
          </div>

          {/* Narration */}
          {scene.narration && (
            <div>
              <div style={labelStyle}>Voice-over</div>
              <div style={{ fontSize: 12, color: C.t3, fontStyle: "italic" }}>"{scene.narration}"</div>
            </div>
          )}
        </div>
      )}

      {/* ── video preview ── */}
      {scene.videoUrl && (
        <div style={{ padding: "0 14px 10px" }}>
          <video src={scene.videoUrl} controls loop style={{ width: "100%", borderRadius: 7, background: "#000", maxHeight: 220 }} />
        </div>
      )}

      {/* ── progress log ── */}
      {st === "generating" && scene.progressLog && (
        <div style={{ padding: "4px 14px 8px", fontSize: 10, color: C.t4, fontFamily: "var(--mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {scene.progressLog}
        </div>
      )}

      {/* ── actions ── */}
      <div style={{ padding: "8px 14px 12px", display: "flex", gap: 8, alignItems: "center", borderTop: `1px solid ${C.b1}` }}>
        {st === "idle" && (
          <Btn size="sm" onClick={() => onGenerate(idx)} disabled={busy} icon={<span>▶</span>}>Generate</Btn>
        )}
        {(st === "succeeded" || st === "failed") && (
          <Btn size="sm" variant="secondary" onClick={() => onRegen(idx)} disabled={busy} icon={<span>↺</span>}>Regenerate</Btn>
        )}
        {scene.videoUrl && (
          <Btn size="sm" variant="ghost" onClick={() => {
            const a = document.createElement("a");
            a.href = scene.videoUrl; a.download = `scene_${idx + 1}.mp4`; a.click();
          }}>⬇ Download</Btn>
        )}
        <div style={{ marginLeft: "auto", fontSize: 10, color: C.t4 }}>{scene.transition}</div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────

export default function App() {
  // ── config state ───────────────────────────────────────────
  const [model,    setModel]    = useState("wan-480p");
  const [style,    setStyle]    = useState("cinematic");
  const [mood,     setMood]     = useState("Epic");
  const [durIdx,   setDurIdx]   = useState(1);            // index into DURATION_OPTIONS

  // ── project state ──────────────────────────────────────────
  const [projectId,    setProjectId]    = useState(null);
  const [projectTitle, setProjectTitle] = useState("Untitled");
  const [editTitle,    setEditTitle]    = useState(false);
  const [blueprint,    setBlueprint]    = useState(null);    // parsed JSON from Claude
  const [scenes,       setScenes]       = useState([]);      // blueprint.scenes + video status
  const [finalUrl,     setFinalUrl]     = useState(null);

  // ── UI state ───────────────────────────────────────────────
  const [tab,           setTab]           = useState("chat");  // chat | blueprint | timeline
  const [chatLog,       setChatLog]       = useState([]);
  const [input,         setInput]         = useState("");
  const [streaming,     setStreaming]      = useState(false);
  const [genAllBusy,    setGenAllBusy]    = useState(false);
  const [stitchBusy,    setStitchBusy]    = useState(false);
  const [activeGens,    setActiveGens]    = useState(0);
  const [projects,      setProjects]      = useState([]);
  const [showLibrary,   setShowLibrary]   = useState(false);
  const [health,        setHealth]        = useState(null);
  const [toast,         setToast]         = useState(null);

  const bottomRef  = useRef(null);
  const inputRef   = useRef(null);
  const titleRef   = useRef(null);

  const durOpt     = DURATION_OPTIONS[durIdx];
  const modelInfo  = MODELS.find(m => m.id === model) || MODELS[0];
  const styleInfo  = STYLES.find(s => s.id === style) || STYLES[0];
  const doneScenes = scenes.filter(s => s.genStatus === "succeeded").length;
  const totalCost  = scenes.reduce((sum, s) => sum + (s.durationSec || 5) * 0.01, 0);  // rough est

  // ── boot ───────────────────────────────────────────────────
  useEffect(() => {
    db.health().then(setHealth).catch(() => {});
    loadProjects();
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatLog, streaming]);
  useEffect(() => { if (editTitle) titleRef.current?.focus(); }, [editTitle]);

  const toast_ = (msg, type = "success") => setToast({ msg, type });

  // ── project helpers ────────────────────────────────────────
  const loadProjects = async () => {
    try { const r = await db.list(); setProjects(r.projects || []); } catch {}
  };

  const saveProject = useCallback(async (overrides = {}) => {
    try {
      const payload = { id: projectId, title: projectTitle, style, mood, duration: durOpt.label, blueprint, scenes, finalUrl, status: finalUrl ? "complete" : doneScenes > 0 ? "in-progress" : "draft", ...overrides };
      const r = await db.save(payload);
      if (!projectId) setProjectId(r.id);
      loadProjects();
    } catch (e) { console.error("Save failed", e); }
  }, [projectId, projectTitle, style, mood, durOpt, blueprint, scenes, finalUrl, doneScenes]);

  // ── parse Claude JSON ──────────────────────────────────────
  const parseBlueprint = (text) => {
    const clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    try { return JSON.parse(clean); } catch {
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error("Couldn't parse blueprint JSON");
    }
  };

  // ── send chat ──────────────────────────────────────────────
  const handleSend = async () => {
    if (!input.trim() || streaming) return;
    const userText = input.trim();
    setInput("");
    setStreaming(true);

    const userMsg  = { role: "user", content: userText };
    const newLog   = [...chatLog, userMsg];
    setChatLog(newLog);

    const sysPrompt = buildSystemPrompt({
      style, mood,
      duration: durOpt.label,
      sceneCount: durOpt.scenes,
      modelId: model,
    });

    let accumulated = "";

    await chatStream({
      messages:     newLog,
      systemPrompt: sysPrompt,
      onDelta: t  => { accumulated += t; },
      onDone:  async () => {
        setChatLog(prev => [...prev, { role: "assistant", content: accumulated }]);
        try {
          const bp = parseBlueprint(accumulated);
          setBlueprint(bp);
          setProjectTitle(bp.title || "Untitled");
          const init = bp.scenes.map(s => ({ ...s, genStatus: "idle", videoUrl: null, progressLog: "" }));
          setScenes(init);
          setFinalUrl(null);
          setTab("blueprint");
          toast_(`Blueprint ready — ${bp.scenes.length} scenes`, "success");
          await saveProject({ blueprint: bp, scenes: init, title: bp.title });
        } catch (e) {
          toast_("Couldn't parse blueprint — try rephrasing your concept.", "error");
        }
        setStreaming(false);
      },
      onError: msg => { toast_(msg, "error"); setStreaming(false); },
    });
  };

  // ── generate a single scene ────────────────────────────────
  const generateScene = useCallback(async (idx) => {
    const scene = scenes[idx];
    if (!scene) return;

    setScenes(prev => prev.map((s, i) => i === idx ? { ...s, genStatus: "generating", progressLog: "Starting…" } : s));
    setActiveGens(n => n + 1);

    try {
      const result = await startGeneration({
        prompt:         scene.videoPrompt,
        negativePrompt: scene.negativePrompt,
        model,
        numFrames:      modelInfo.numFrames,
        sceneId:        scene.id,
      });

      if (result.error) throw new Error(result.error);

      const provider = result.provider;
      const pollId   = result.predictionId || result.requestId;

      const final = await pollUntilDone(provider, pollId, (status, logs) => {
        setScenes(prev => prev.map((s, i) => i === idx
          ? { ...s, progressLog: logs ? logs.slice(-200) : status }
          : s));
      });

      setScenes(prev => prev.map((s, i) => i === idx
        ? { ...s, genStatus: "succeeded", videoUrl: final.videoUrl, progressLog: "" }
        : s));
      toast_(`Scene ${idx + 1} ready ✓`, "success");
    } catch (err) {
      setScenes(prev => prev.map((s, i) => i === idx
        ? { ...s, genStatus: "failed", progressLog: err.message }
        : s));
      toast_(`Scene ${idx + 1} failed: ${err.message}`, "error");
    } finally {
      setActiveGens(n => n - 1);
      saveProject();
    }
  }, [scenes, model, modelInfo, saveProject]);

  // ── generate all (sequential) ──────────────────────────────
  const generateAll = async () => {
    setGenAllBusy(true);
    for (let i = 0; i < scenes.length; i++) {
      if (scenes[i].genStatus !== "succeeded") await generateScene(i);
    }
    setGenAllBusy(false);
    if (scenes.filter(s => s.genStatus === "succeeded").length >= 2) setTab("timeline");
  };

  // ── stitch final video ─────────────────────────────────────
  const handleStitch = async () => {
    const ready = scenes.filter(s => s.videoUrl);
    if (ready.length < 2) { toast_("Need at least 2 generated scenes", "warn"); return; }
    setStitchBusy(true);
    try {
      const { videoUrl } = await stitchScenes({ sceneFiles: ready.map(s => s.videoUrl), projectTitle });
      setFinalUrl(videoUrl);
      toast_("Final video ready 🎬", "success");
      await saveProject({ finalUrl: videoUrl });
    } catch (e) { toast_("Stitch failed: " + e.message, "error"); }
    setStitchBusy(false);
  };

  // ── load project ───────────────────────────────────────────
  const loadProject = async (id) => {
    try {
      const p = await db.load(id);
      setProjectId(p.id);
      setProjectTitle(p.title || "Untitled");
      setStyle(p.style || "cinematic");
      setMood(p.mood || "Epic");
      const dIdx = DURATION_OPTIONS.findIndex(d => d.label === p.duration);
      if (dIdx >= 0) setDurIdx(dIdx);
      setBlueprint(p.blueprint);
      setScenes(p.scenes || []);
      setFinalUrl(p.finalUrl);
      setShowLibrary(false);
      setTab(p.scenes?.length ? "blueprint" : "chat");
      toast_(`Loaded "${p.title}"`);
    } catch { toast_("Failed to load project", "error"); }
  };

  const newProject = () => {
    if (scenes.length && !confirm("Start a new project?")) return;
    setProjectId(null); setProjectTitle("Untitled"); setBlueprint(null);
    setScenes([]); setFinalUrl(null); setChatLog([]); setTab("chat");
  };

  // ─────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: C.bg, color: C.text }}>

      {/* ── Top bar ───────────────────────────────────────────── */}
      <header style={{ height: 50, display: "flex", alignItems: "center", padding: "0 16px", gap: 12, background: C.s1, borderBottom: `1px solid ${C.b1}`, flexShrink: 0, zIndex: 100 }}>

        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <div style={{ width: 28, height: 28, borderRadius: 7, background: `linear-gradient(135deg, ${C.accent}30, ${C.blue}30)`, border: `1px solid ${C.accent}50`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: C.accent }}>
            ▶
          </div>
          <div>
            <div style={{ fontFamily: "var(--display)", fontSize: 17, letterSpacing: ".1em", color: C.text, lineHeight: 1 }}>FRAMEGEN</div>
            <div style={{ fontSize: 8, color: C.t4, letterSpacing: ".2em" }}>CHAT TO VIDEO</div>
          </div>
        </div>

        {/* Title */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
          {editTitle
            ? <input ref={titleRef} value={projectTitle} onChange={e => setProjectTitle(e.target.value)} onBlur={() => setEditTitle(false)} onKeyDown={e => e.key === "Enter" && setEditTitle(false)} style={{ background: C.s3, border: `1px solid ${C.b2}`, borderRadius: 5, color: C.text, padding: "4px 9px", fontSize: 12, outline: "none", width: 200 }} />
            : <span onClick={() => setEditTitle(true)} style={{ fontSize: 12, color: C.t2, cursor: "text", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{projectTitle}</span>
          }
          {scenes.length > 0 && (
            <span style={{ fontSize: 10, color: C.t4 }}>{doneScenes}/{scenes.length} scenes</span>
          )}
        </div>

        {/* Status pills */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {health && !health.anthropic  && <Badge color={C.red}>No Claude key</Badge>}
          {health && !health.replicate && !health.fal && <Badge color={C.orange}>No Video API</Badge>}
          {activeGens > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: C.blue }}>
              <Spin size={11} /> {activeGens} generating
            </div>
          )}
          {blueprint && <Btn size="sm" variant="secondary" onClick={() => saveProject()}>💾 Save</Btn>}
          <Btn size="sm" variant="ghost" title="Projects" onClick={() => { setShowLibrary(l => !l); loadProjects(); }}>📂</Btn>
          <Btn size="sm" variant="ghost" title="New project" onClick={newProject}>＋</Btn>
        </div>
      </header>

      {/* ── Body ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ── Sidebar ─────────────────────────────────────────── */}
        <aside style={{ width: 240, minWidth: 240, background: C.s1, borderRight: `1px solid ${C.b1}`, overflowY: "auto", display: "flex", flexDirection: "column", gap: 0 }}>
          <div style={{ padding: "14px 14px 20px", display: "flex", flexDirection: "column", gap: 18 }}>

            {/* Model picker */}
            <section>
              <div style={sectionTitle}>Video Model</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {MODELS.map(m => (
                  <button key={m.id} onClick={() => setModel(m.id)} style={{
                    display: "flex", alignItems: "flex-start", gap: 9,
                    padding: "8px 10px", borderRadius: 7, cursor: "pointer", textAlign: "left",
                    background: model === m.id ? C.s3 : "transparent",
                    border: `1px solid ${model === m.id ? C.b3 : "transparent"}`,
                    transition: "all .15s",
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: model === m.id ? C.text : C.t3 }}>{m.name}</span>
                        <Badge color={m.badgeColor}>{m.badge}</Badge>
                      </div>
                      <div style={{ fontSize: 10, color: C.t4, lineHeight: 1.5 }}>{m.cost} · {m.time}</div>
                    </div>
                    {model === m.id && <div style={{ width: 5, height: 5, borderRadius: "50%", background: C.accent, marginTop: 5, flexShrink: 0 }} />}
                  </button>
                ))}
              </div>
            </section>

            {/* Style picker */}
            <section>
              <div style={sectionTitle}>Visual Style</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                {STYLES.map(s => (
                  <button key={s.id} onClick={() => setStyle(s.id)} title={s.hint} style={{
                    padding: "6px 8px", borderRadius: 6, cursor: "pointer", textAlign: "center",
                    background: style === s.id ? s.color + "18" : "transparent",
                    border: `1px solid ${style === s.id ? s.color + "55" : C.b1}`,
                    fontSize: 11, color: style === s.id ? s.color : C.t3, transition: "all .15s",
                  }}>
                    {s.emoji} {s.label}
                  </button>
                ))}
              </div>
            </section>

            {/* Mood */}
            <section>
              <div style={sectionTitle}>Mood</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {MOODS.map(m => (
                  <button key={m} onClick={() => setMood(m)} style={{
                    padding: "4px 9px", borderRadius: 14, cursor: "pointer",
                    background: mood === m ? C.accent + "22" : "transparent",
                    border: `1px solid ${mood === m ? C.accent + "55" : C.b1}`,
                    fontSize: 10, color: mood === m ? C.accent : C.t4, transition: "all .15s",
                  }}>{m}</button>
                ))}
              </div>
            </section>

            {/* Duration */}
            <section>
              <div style={sectionTitle}>Target Duration</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {DURATION_OPTIONS.map((d, i) => (
                  <button key={d.label} onClick={() => setDurIdx(i)} style={{
                    padding: "5px 10px", borderRadius: 6, cursor: "pointer",
                    background: durIdx === i ? C.s4 : "transparent",
                    border: `1px solid ${durIdx === i ? C.b3 : C.b1}`,
                    fontSize: 11, fontFamily: "var(--mono)", color: durIdx === i ? C.text : C.t4,
                  }}>{d.label}</button>
                ))}
              </div>
              <div style={{ fontSize: 10, color: C.t4, marginTop: 5 }}>{durOpt.scenes} scenes · {durOpt.label}</div>
            </section>

            {/* Cost estimate */}
            {scenes.length > 0 && (
              <section style={{ padding: 10, background: C.bg, borderRadius: 7, border: `1px solid ${C.b1}` }}>
                <div style={sectionTitle}>Est. Cost</div>
                <div style={{ fontSize: 16, color: C.green, fontFamily: "var(--mono)" }}>
                  ~${totalCost.toFixed(2)}
                </div>
                <div style={{ fontSize: 9, color: C.t4, marginTop: 3 }}>Replicate · open-source models</div>
              </section>
            )}
          </div>
        </aside>

        {/* ── Main panel ───────────────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Tab bar */}
          <div style={{ height: 42, display: "flex", alignItems: "center", padding: "0 16px", gap: 2, background: C.s1, borderBottom: `1px solid ${C.b1}`, flexShrink: 0 }}>
            {[
              ["chat",      "💬 Chat"],
              ["blueprint", `📋 Blueprint${scenes.length ? ` (${scenes.length})` : ""}`],
              ["timeline",  `🎬 Timeline${doneScenes ? ` (${doneScenes}✓)` : ""}`],
            ].map(([t, label]) => (
              <button key={t} onClick={() => setTab(t)} style={{
                padding: "6px 14px", border: "none",
                borderBottom: `2px solid ${tab === t ? C.accent : "transparent"}`,
                background: "transparent",
                color: tab === t ? C.text : C.t3,
                fontSize: 12, cursor: "pointer", fontFamily: "var(--sans)", transition: "all .2s",
              }}>{label}</button>
            ))}

            {/* Right-side actions */}
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              {tab === "blueprint" && scenes.length > 0 && (
                <Btn size="sm" onClick={generateAll} disabled={genAllBusy || streaming}
                  icon={genAllBusy ? <Spin size={11} /> : <span>▶</span>}>
                  {genAllBusy
                    ? "Generating…"
                    : `Generate All${scenes.filter(s => s.genStatus !== "succeeded").length > 0 ? ` (${scenes.filter(s => s.genStatus !== "succeeded").length})` : ""}`}
                </Btn>
              )}
              {tab === "timeline" && doneScenes >= 2 && (
                <Btn size="sm" variant="green" onClick={handleStitch} disabled={stitchBusy}
                  icon={stitchBusy ? <Spin size={11} /> : <span>✂</span>}>
                  {stitchBusy ? "Stitching…" : `Stitch Final MP4`}
                </Btn>
              )}
            </div>
          </div>

          {/* ── TAB: CHAT ─────────────────────────────────────── */}
          {tab === "chat" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              {/* Messages */}
              <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
                {chatLog.length === 0 ? (
                  <div className="fade-in" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 20 }}>
                    <div style={{ width: 64, height: 64, borderRadius: 16, background: `linear-gradient(135deg, ${C.accent}18, ${C.blue}18)`, border: `1px solid ${C.accent}30`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, color: C.accent }}>▶</div>
                    <div style={{ textAlign: "center", maxWidth: 440 }}>
                      <div style={{ fontFamily: "var(--display)", fontSize: 28, letterSpacing: ".1em", marginBottom: 8 }}>DESCRIBE YOUR VIDEO</div>
                      <div style={{ fontSize: 13, color: C.t2, lineHeight: 1.7 }}>
                        Tell me your concept — a feeling, a story, a product, a dream sequence. Claude will build a full production blueprint, then you generate each scene with open-source AI video models.
                      </div>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", maxWidth: 500 }}>
                      {[
                        "Ancient sage boy maps the stars — origin of Vedic astrology",
                        "A lone astronaut finds a garden on Mars",
                        "Brand film for a sustainable sneaker launch",
                        "Music video — rainy neon city, lost love",
                        "Short documentary on deep sea bioluminescence",
                      ].map(ex => (
                        <button key={ex} onClick={() => setInput(ex)} style={{
                          padding: "7px 14px", background: "none", border: `1px solid ${C.b2}`,
                          borderRadius: 20, fontSize: 11, color: C.t3, cursor: "pointer",
                          fontFamily: "var(--sans)", transition: "border-color .15s",
                        }}>{ex}</button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ maxWidth: 700, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
                    {chatLog.map((m, i) => (
                      <div key={i} className="fade-up" style={{ display: "flex", gap: 10, justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                        {m.role === "assistant" && (
                          <div style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 6, background: C.s3, border: `1px solid ${C.b2}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: C.accent, marginTop: 2 }}>▶</div>
                        )}
                        <div style={{
                          maxWidth: "84%", padding: "10px 14px",
                          borderRadius: m.role === "user" ? "14px 14px 4px 14px" : "4px 14px 14px 14px",
                          background: m.role === "user" ? C.s3 : C.s2,
                          border: `1px solid ${C.b1}`,
                          fontSize: 13, lineHeight: 1.7,
                          color: m.role === "user" ? C.text : C.t2,
                        }}>
                          {m.role === "assistant" ? (
                            blueprint ? (
                              <div>
                                <div style={{ color: C.green, fontSize: 12, marginBottom: 6 }}>✓ Blueprint generated</div>
                                <div style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                                  <b style={{ color: C.text }}>{blueprint.title}</b><br />
                                  <span style={{ color: C.t3 }}>{blueprint.logline}</span><br />
                                  <span style={{ color: C.t4 }}>{blueprint.scenes?.length} scenes · {durOpt.label}</span>
                                </div>
                                <button onClick={() => setTab("blueprint")} style={{ marginTop: 10, padding: "5px 12px", background: C.s4, border: `1px solid ${C.accent}44`, borderRadius: 6, color: C.accent, fontSize: 11, cursor: "pointer", fontFamily: "var(--sans)" }}>
                                  View Blueprint →
                                </button>
                              </div>
                            ) : m.content
                          ) : m.content}
                        </div>
                      </div>
                    ))}
                    {streaming && (
                      <div className="fade-up" style={{ display: "flex", gap: 10 }}>
                        <div style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 6, background: C.s3, border: `1px solid ${C.b2}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <Spin size={12} />
                        </div>
                        <div style={{ padding: "10px 14px", background: C.s2, border: `1px solid ${C.b1}`, borderRadius: "4px 14px 14px 14px", fontSize: 12, color: C.t4 }}>
                          Building blueprint…
                        </div>
                      </div>
                    )}
                    <div ref={bottomRef} />
                  </div>
                )}
              </div>

              {/* Quick refine chips (shows after blueprint) */}
              {blueprint && (
                <div style={{ padding: "6px 24px", borderTop: `1px solid ${C.b1}`, display: "flex", gap: 6, overflowX: "auto" }}>
                  {QUICK_REFINES.map(r => (
                    <button key={r} onClick={() => { setInput(r); setTimeout(() => inputRef.current?.focus(), 50); }} style={{
                      padding: "4px 11px", background: "none", border: `1px solid ${C.b1}`,
                      borderRadius: 14, fontSize: 10, color: C.t4, cursor: "pointer",
                      fontFamily: "var(--sans)", whiteSpace: "nowrap",
                    }}>{r}</button>
                  ))}
                </div>
              )}

              {/* Input */}
              <div style={{ padding: "12px 16px", borderTop: `1px solid ${C.b1}`, background: C.s1, flexShrink: 0 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                    placeholder={blueprint ? "Refine your blueprint… (Enter to generate)" : "Describe your video concept… (Enter to generate)"}
                    rows={2}
                    style={{ flex: 1, background: C.s3, border: `1px solid ${C.b2}`, borderRadius: 9, color: C.text, padding: "10px 14px", fontSize: 13, lineHeight: 1.6, resize: "none", outline: "none" }}
                  />
                  <button onClick={handleSend} disabled={streaming || !input.trim()} style={{
                    padding: "10px 20px", background: C.accent, border: "none",
                    borderRadius: 9, color: "#111", fontSize: 13, fontWeight: 600,
                    cursor: streaming || !input.trim() ? "not-allowed" : "pointer",
                    opacity: streaming || !input.trim() ? .4 : 1,
                    fontFamily: "var(--sans)", whiteSpace: "nowrap",
                  }}>Generate ▶</button>
                </div>
                <div style={{ marginTop: 6, fontSize: 10, color: C.t4, display: "flex", gap: 8 }}>
                  <span>{styleInfo.emoji} {styleInfo.label}</span>
                  <span>·</span><span>{mood}</span>
                  <span>·</span><span>{durOpt.label}</span>
                  <span>·</span><span>{modelInfo.name}</span>
                </div>
              </div>
            </div>
          )}

          {/* ── TAB: BLUEPRINT ────────────────────────────────── */}
          {tab === "blueprint" && (
            <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
              {!blueprint ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 12, color: C.t4 }}>
                  <span style={{ fontSize: 36 }}>📋</span>
                  <div>No blueprint yet — describe your video in the Chat tab</div>
                  <Btn size="sm" onClick={() => setTab("chat")}>Go to Chat</Btn>
                </div>
              ) : (
                <div style={{ maxWidth: 780, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }} className="fade-in">

                  {/* Project meta card */}
                  <div style={{ padding: 18, background: C.s2, border: `1px solid ${C.b2}`, borderRadius: 12 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
                      <div>
                        <div style={{ fontFamily: "var(--display)", fontSize: 22, letterSpacing: ".08em", marginBottom: 4 }}>{blueprint.title}</div>
                        <div style={{ fontSize: 13, color: C.t2 }}>{blueprint.logline}</div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end", flexShrink: 0 }}>
                        <Badge color={styleInfo.color}>{styleInfo.emoji} {styleInfo.label}</Badge>
                        <Badge color={C.t2}>{mood}</Badge>
                        <Badge color={C.t3}>{durOpt.label}</Badge>
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                      <div>
                        <div style={sectionTitle}>Colour Grade</div>
                        <div style={{ fontSize: 12, color: C.t2 }}>{blueprint.colorGrade}</div>
                      </div>
                      <div>
                        <div style={sectionTitle}>Soundtrack</div>
                        <div style={{ fontSize: 12, color: C.t2 }}>{blueprint.soundtrack}</div>
                      </div>
                    </div>
                  </div>

                  {/* Scene cards */}
                  <div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <div style={{ ...sectionTitle, marginBottom: 0 }}>{scenes.length} Scenes</div>
                      <span style={{ fontSize: 11, color: C.t4, fontFamily: "var(--mono)" }}>
                        {doneScenes} generated · {scenes.length - doneScenes} remaining
                      </span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {scenes.map((scene, idx) => (
                        <SceneCard
                          key={`${scene.id}-${idx}`}
                          scene={scene} idx={idx}
                          onGenerate={generateScene}
                          onRegen={generateScene}
                          busy={genAllBusy || scene.genStatus === "generating"}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── TAB: TIMELINE ─────────────────────────────────── */}
          {tab === "timeline" && (
            <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
              <div style={{ maxWidth: 780, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }} className="fade-in">

                {/* Final video */}
                {finalUrl ? (
                  <div style={{ padding: 18, background: C.s2, border: `1px solid ${C.green}44`, borderRadius: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.green }}>✓ Final Video Ready</div>
                        <div style={{ fontSize: 11, color: C.t4, marginTop: 2 }}>{projectTitle} · all scenes stitched</div>
                      </div>
                      <Btn size="sm" variant="green" icon="⬇" onClick={() => { const a = document.createElement("a"); a.href = finalUrl; a.download = `${projectTitle.replace(/\s+/g, "_")}.mp4`; a.click(); }}>
                        Download MP4
                      </Btn>
                    </div>
                    <video src={finalUrl} controls style={{ width: "100%", borderRadius: 9, background: "#000", maxHeight: 400 }} />
                  </div>
                ) : (
                  <div style={{ padding: 18, background: C.s2, border: `1px solid ${C.b2}`, borderRadius: 12 }}>
                    <div style={{ fontSize: 13, color: C.t2, marginBottom: 12 }}>
                      {doneScenes < 2
                        ? `Generate at least 2 scenes to stitch them into a final video. (${doneScenes} ready)`
                        : `${doneScenes} scenes ready — stitch them into one continuous MP4 using FFmpeg.`}
                    </div>
                    {doneScenes >= 2 && (
                      <Btn onClick={handleStitch} disabled={stitchBusy} icon={stitchBusy ? <Spin size={14} /> : "✂"}>
                        {stitchBusy ? "Stitching with FFmpeg…" : `Stitch ${doneScenes} Scenes → Final MP4`}
                      </Btn>
                    )}
                  </div>
                )}

                {/* Scene strip */}
                {scenes.some(s => s.videoUrl) && (
                  <div>
                    <div style={{ ...sectionTitle, marginBottom: 10 }}>Scene Clips</div>
                    <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8 }}>
                      {scenes.map((s, i) => (
                        <div key={i} style={{ flexShrink: 0, width: 140 }}>
                          {s.videoUrl
                            ? <video src={s.videoUrl} loop muted autoPlay style={{ width: 140, height: 79, objectFit: "cover", borderRadius: 6, border: `1px solid ${C.green}44` }} />
                            : <div style={{ width: 140, height: 79, background: C.s3, borderRadius: 6, border: `1px solid ${C.b1}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                                <span style={{ fontSize: 10, color: C.t4 }}>Scene {i + 1}</span>
                              </div>
                          }
                          <div style={{ fontSize: 10, color: C.t4, marginTop: 4, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Download list */}
                {scenes.filter(s => s.videoUrl).length > 0 && (
                  <div>
                    <div style={{ ...sectionTitle, marginBottom: 8 }}>Individual Downloads</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      {scenes.filter(s => s.videoUrl).map((s, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: C.s2, border: `1px solid ${C.b1}`, borderRadius: 7 }}>
                          <span style={{ fontSize: 10, color: C.green, fontFamily: "var(--mono)", flexShrink: 0 }}>SCENE {scenes.indexOf(s) + 1}</span>
                          <span style={{ fontSize: 12, color: C.t2, flex: 1 }}>{s.title}</span>
                          <span style={{ fontSize: 10, color: C.t4, fontFamily: "var(--mono)" }}>{s.durationSec}s</span>
                          <Btn size="sm" variant="ghost" onClick={() => { const a = document.createElement("a"); a.href = s.videoUrl; a.download = `scene_${scenes.indexOf(s) + 1}.mp4`; a.click(); }}>⬇</Btn>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              </div>
            </div>
          )}

        </div>

        {/* ── Library drawer ─────────────────────────────────── */}
        {showLibrary && (
          <div className="fade-in" style={{ position: "fixed", top: 50, right: 0, width: 320, height: "calc(100vh - 50px)", background: C.s1, borderLeft: `1px solid ${C.b1}`, zIndex: 200, overflowY: "auto", padding: 16, boxShadow: "-8px 0 30px #00000066" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Projects ({projects.length})</span>
              <button onClick={() => setShowLibrary(false)} style={{ background: "none", border: "none", color: C.t3, cursor: "pointer", fontSize: 18 }}>×</button>
            </div>
            {projects.length === 0
              ? <div style={{ fontSize: 12, color: C.t4 }}>No saved projects yet.</div>
              : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {projects.map(p => (
                    <div key={p.id} style={{ padding: 12, background: C.s2, border: `1px solid ${C.b1}`, borderRadius: 9 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 3 }}>{p.title}</div>
                      <div style={{ fontSize: 10, color: C.t4, marginBottom: 8 }}>{p.sceneCount} scenes · {p.status} · {new Date(p.updatedAt).toLocaleDateString()}</div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <Btn size="sm" onClick={() => loadProject(p.id)}>Load</Btn>
                        <Btn size="sm" variant="danger" onClick={async () => { if (confirm(`Delete "${p.title}"?`)) { await db.delete(p.id); loadProjects(); } }}>Delete</Btn>
                      </div>
                    </div>
                  ))}
                </div>
              )
            }
          </div>
        )}

      </div>

      {toast && <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Shared micro-styles
// ─────────────────────────────────────────────────────────────
const sectionTitle = {
  fontSize: 9, fontWeight: 700, letterSpacing: ".18em",
  textTransform: "uppercase", color: "#2a2420", marginBottom: 8,
};
const labelStyle = {
  fontSize: 9, fontWeight: 700, letterSpacing: ".15em",
  textTransform: "uppercase", color: "#2a2420", marginBottom: 5,
};
