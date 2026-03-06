// ─── streaming chat (SSE) ──────────────────────────────────────
export async function chatStream({ messages, systemPrompt, onDelta, onDone, onError }) {
  const res = await fetch("/api/chat", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ messages, systemPrompt }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    onError?.(e.error || `Server error ${res.status}`);
    return;
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", evt = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      if (line.startsWith("event: ")) { evt = line.slice(7).trim(); continue; }
      if (!line.startsWith("data: "))  continue;
      try {
        const d = JSON.parse(line.slice(6));
        if (evt === "delta") onDelta?.(d.text);
        if (evt === "done")  onDone?.();
        if (evt === "error") onError?.(d.message);
      } catch {}
    }
  }
}

// ─── video generation ──────────────────────────────────────────
export async function startGeneration({ prompt, negativePrompt, model, numFrames, sceneId }) {
  const r = await fetch("/api/generate-scene", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ prompt, negativePrompt, model, numFrames, sceneId }),
  });
  return r.json();
}

// poll until succeeded/failed
export async function pollUntilDone(provider, id, onProgress) {
  for (let i = 0; i < 150; i++) {
    await delay(4000);
    const r    = await fetch(`/api/poll/${provider}/${id}`);
    const data = await r.json();
    onProgress?.(data.status, data.logs);
    if (data.status === "succeeded") return data;
    if (data.status === "failed")    throw new Error(data.error || "Generation failed");
  }
  throw new Error("Timed out after 10 minutes");
}

// ─── stitch ────────────────────────────────────────────────────
export async function stitchScenes({ sceneFiles, projectTitle }) {
  const r = await fetch("/api/stitch", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ sceneFiles, projectTitle }),
  });
  if (!r.ok) throw new Error("Stitch failed");
  return r.json();
}

// ─── projects ──────────────────────────────────────────────────
export const db = {
  health:  ()     => fetch("/api/health").then(r => r.json()),
  list:    ()     => fetch("/api/projects").then(r => r.json()),
  save:    (data) => fetch("/api/projects", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(data) }).then(r => r.json()),
  load:    (id)   => fetch(`/api/projects/${id}`).then(r => r.json()),
  delete:  (id)   => fetch(`/api/projects/${id}`, { method: "DELETE" }),
};

const delay = ms => new Promise(r => setTimeout(r, ms));
