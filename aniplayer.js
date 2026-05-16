// ═══════════════════════════
// STATE
// ═══════════════════════════
let tokenizer = null;
let jpSubs = [],
  frSubs = [];
let jpOff = 0,
  frOff = 0;
let showJP = true,
  showFR = true;
let videoFile = null,
  jpFile = null,
  frFile = null;
let activeTok = null;
let rafId = null;
let lastJP = "",
  lastFR = "";
let currentJPSub = null; // full sub object {start, end, text}
let videoPathOverride = ""; // user-typed absolute path for FFmpeg
const dictCache = {};

// ═══════════════════════════
// KUROMOJI
// ═══════════════════════════
kuromoji
  .builder({ dicPath: "https://unpkg.com/kuromoji@0.1.2/dict" })
  .build((err, t) => {
    if (err) {
      console.warn("Tokenizer unavailable:", err);
      return;
    }
    tokenizer = t;
  });

// ═══════════════════════════
// FILE INPUTS
// ═══════════════════════════
function bindFile(inputId, boxId, nameId, type) {
  document.getElementById(inputId).addEventListener("change", function () {
    const f = this.files[0];
    if (!f) return;
    if (type === "video") videoFile = f;
    else if (type === "jp") jpFile = f;
    else frFile = f;
    document.getElementById(boxId).classList.add("loaded");
    document.getElementById(nameId).textContent = f.name;
    checkReady();
  });
}
bindFile("fileVideo", "boxVideo", "nameVideo", "video");
bindFile("fileJP", "boxJP", "nameJP", "jp");
bindFile("fileFR", "boxFR", "nameFR", "fr");

function checkReady() {
  document.getElementById("btnStart").classList.toggle("ready", !!jpFile);
}

// Global drag-drop on drop zone
const dz = document.getElementById("dropZone");
dz.addEventListener("dragover", (e) => {
  e.preventDefault();
  dz.classList.add("drag-over");
});
dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  dz.classList.remove("drag-over");
  [...e.dataTransfer.files].forEach((f) => {
    const ext = f.name.split(".").pop().toLowerCase();
    if (["mp4", "mkv", "webm", "avi", "mov"].includes(ext)) {
      videoFile = f;
      document.getElementById("boxVideo").classList.add("loaded");
      document.getElementById("nameVideo").textContent = f.name;
    } else if (["srt", "vtt", "ass", "ssa"].includes(ext)) {
      const looksJP = !f.name.match(/\b(fr|en|fra|eng)\b/i);
      if (!jpFile && looksJP) {
        jpFile = f;
        document.getElementById("boxJP").classList.add("loaded");
        document.getElementById("nameJP").textContent = f.name;
      } else if (!frFile) {
        frFile = f;
        document.getElementById("boxFR").classList.add("loaded");
        document.getElementById("nameFR").textContent = f.name;
      }
    }
  });
  checkReady();
});

// ═══════════════════════════
// PARSERS
// ═══════════════════════════
function parseTime(s) {
  s = s.trim().replace(",", ".");
  const p = s.split(":");
  return +p[0] * 3600 + +p[1] * 60 + parseFloat(p[2]);
}
function strip(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\[Nn]/g, " ")
    .trim();
}
function parseSRT(txt) {
  const blocks = txt
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n{2,}/);
  const out = [];
  for (const b of blocks) {
    const lines = b.trim().split("\n");
    let ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, b2] = lines[ti].split("-->");
    const text = lines
      .slice(ti + 1)
      .map(strip)
      .join(" ")
      .trim();
    if (text) out.push({ start: parseTime(a), end: parseTime(b2), text });
  }
  return out;
}
function parseVTT(txt) {
  return parseSRT(
    txt.replace(/^WEBVTT[^\n]*\n/, "").replace(/NOTE[^\n]*/g, ""),
  );
}
function parseASS(txt) {
  const out = [];
  const lines = txt.split(/\r?\n/);
  let inEv = false,
    fmt = [];
  for (const l of lines) {
    if (l.startsWith("[Events]")) {
      inEv = true;
      continue;
    }
    if (l.startsWith("[") && inEv) break;
    if (!inEv) continue;
    if (l.startsWith("Format:")) {
      fmt = l
        .replace("Format:", "")
        .split(",")
        .map((s) => s.trim());
      continue;
    }
    if (!l.startsWith("Dialogue:")) continue;
    const vals = l.replace("Dialogue:", "").split(",");
    const get = (k) => {
      const i = fmt.indexOf(k);
      return i < 0 ? "" : k === "Text" ? vals.slice(i).join(",") : vals[i];
    };
    const t = get("Text")
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\[Nn]/g, " ")
      .trim();
    if (!t) continue;
    const pt = (s) => {
      const p = s.trim().split(":");
      return +p[0] * 3600 + +p[1] * 60 + parseFloat(p[2]);
    };
    out.push({ start: pt(get("Start")), end: pt(get("End")), text: t });
  }
  return out;
}
function parseSubs(txt, name) {
  const ext = (name || "").split(".").pop().toLowerCase();
  if (ext === "vtt") return parseVTT(txt);
  if (ext === "ass" || ext === "ssa") return parseASS(txt);
  return parseSRT(txt);
}

// ═══════════════════════════
// START
// ═══════════════════════════
async function startPlayer() {
  if (!jpFile) return;
  jpSubs = await readSub(jpFile);
  if (frFile) frSubs = await readSub(frFile);
  const vid = document.getElementById("vid");
  if (videoFile) vid.src = URL.createObjectURL(videoFile);
  document.getElementById("dropZone").classList.add("hidden");
  document.getElementById("playerWrap").classList.add("active");
  vid.addEventListener("loadedmetadata", updateProg);
  document.getElementById("progressWrap").addEventListener("click", seekTo);
  document.addEventListener("keydown", onKey);
  if (videoFile) vid.play();
  tick();
}

function readSub(f) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = (e) => res(parseSubs(e.target.result, f.name));
    r.readAsText(f, "utf-8");
  });
}

// ═══════════════════════════
// TICK
// ═══════════════════════════
function tick() {
  const vid = document.getElementById("vid");
  const t = vid.currentTime;
  const jpT = t - jpOff,
    frT = t - frOff;
  const jpSub = jpSubs.find((s) => jpT >= s.start && jpT <= s.end);
  const frSub = frSubs.find((s) => frT >= s.start && frT <= s.end);
  currentJPSub = jpSub || null;
  const jpTxt = jpSub ? jpSub.text : "";
  const frTxt = frSub ? frSub.text : "";
  if (jpTxt !== lastJP) {
    lastJP = jpTxt;
    renderJP(jpTxt);
    if (aiOpen) updateAIContext();
  }
  if (frTxt !== lastFR) {
    lastFR = frTxt;
    renderFR(frTxt);
    if (aiOpen) updateAIContext();
  }
  updateProg();
  rafId = requestAnimationFrame(tick);
}

// ═══════════════════════════
// RENDER SUBS
// ═══════════════════════════
function toHira(s) {
  return (s || "").replace(/[\u30a1-\u30f6]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0x60),
  );
}
function esc(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderJP(txt) {
  const el = document.getElementById("jpSubDisplay");
  hidePopup();
  if (!txt || !showJP) {
    el.innerHTML = "";
    return;
  }
  if (!tokenizer) {
    el.innerHTML = `<span class="jp-token"><span class="token-furi"></span><span class="token-text">${esc(txt)}</span></span>`;
    return;
  }
  const tokens = tokenizer.tokenize(txt);
  el.innerHTML = tokens
    .map((tok, i) => {
      const surf = tok.surface_form;
      const read = tok.reading || "";
      const hasKanji = /[\u4e00-\u9faf]/.test(surf);
      const furi = hasKanji ? toHira(read) : "";
      return (
        `<span class="jp-token" data-surf="${esc(surf)}" data-read="${esc(read)}" data-pos="${esc(tok.pos || "")}" data-base="${esc(tok.basic_form || surf)}"
      onmouseenter="showPopup(this,event)" onmouseleave="delayHidePopup()">` +
        `<span class="token-furi">${esc(furi)}</span>` +
        `<span class="token-text">${esc(surf)}</span>` +
        `</span>`
      );
    })
    .join("");
}

function renderFR(txt) {
  document.getElementById("frSubDisplay").textContent =
    showFR && txt ? txt : "";
}

// ═══════════════════════════
// POPUP
// ═══════════════════════════
let popTimer = null;

async function showPopup(el, ev) {
  clearTimeout(popTimer);
  if (activeTok) activeTok.classList.remove("active-tok");
  activeTok = el;
  el.classList.add("active-tok");

  const surf = el.dataset.surf,
    read = el.dataset.read;
  const pos = el.dataset.pos,
    base = el.dataset.base;

  document.getElementById("popWord").textContent = surf;
  document.getElementById("popReading").textContent = toHira(read);
  document.getElementById("popPos").textContent = pos;
  document.getElementById("popMeanings").innerHTML =
    '<div class="pop-m" style="color:var(--text-dim)">…</div>';

  const popup = document.getElementById("popup");
  popup.classList.add("vis");
  posPopup(ev);

  // for particles/aux, skip Jisho and go straight to posHint
  let meanings = [];
  if (!SKIP_POS.has(pos)) {
    // prefer base form (dictionary form) over surface for lookup
    const query = base && base !== "*" && base !== surf ? base : surf;
    meanings = await lookup(query);
  }
  if (el !== activeTok) return;

  let displayMeaning = "";
  if (meanings.length) {
    displayMeaning = meanings[0];
    document.getElementById("popMeanings").innerHTML = meanings
      .slice(0, 5)
      .map((m) => `<div class="pop-m">${esc(m)}</div>`)
      .join("");
  } else {
    const hint = posHint(pos, surf);
    displayMeaning = hint || "";
    document.getElementById("popMeanings").innerHTML =
      `<div class="pop-m" style="color:var(--text-dim)">${hint || "—"}</div>`;
  }

  // ── Populate Anki context ─────────────────────────────────────────
  const vid = document.getElementById("vid");
  const timestamp = fmt(vid.currentTime || 0);
  const sourceName = videoFile
    ? videoFile.name.replace(/\.[^.]+$/, "")
    : "unknown";
  ankiContext = {
    jp: lastJP,
    jp_html: buildFuriganaHtml(lastJP), // ruby HTML for JP sentence field
    fr: lastFR,
    word: surf, // plain text for dedup (Word field = first field)
    meaning: displayMeaning,
    audio: "",
    image: "",
    source: `${sourceName}_${timestamp}`,
    video_path: videoPathOverride,
    start_time: currentJPSub ? currentJPSub.start : vid.currentTime || 0,
    end_time: currentJPSub ? currentJPSub.end : vid.currentTime || 0,
    screenshot: captureFrame(),
  };
  // Reset button state
  const btn = document.getElementById("popAnki");
  btn.classList.remove("sent", "error", "sending");
  btn.querySelector("span:last-child").textContent = "Ajouter à Anki";

  // Update AI panel selected word context
  aiSelectedWord = surf;
  aiSelectedMeaning = displayMeaning;
  if (aiOpen) updateAIContext();
}

// ── Furigana HTML builder ─────────────────────────────────────────────────────
// Generates <ruby> HTML from a Japanese string using Kuromoji
// Output: <ruby>学校<rt>がっこう</rt></ruby>へ<ruby>行<rt>い</rt></ruby>った
function buildFuriganaHtml(text) {
  if (!text || !tokenizer) return esc(text);
  const tokens = tokenizer.tokenize(text);
  return tokens
    .map((tok) => {
      const surf = tok.surface_form;
      const read = tok.reading || "";
      const hasKanji = /[\u4e00-\u9faf]/.test(surf);
      if (!hasKanji || !read) return esc(surf);
      const hira = toHira(read);
      // Only add furigana if reading differs from surface
      if (hira === surf) return esc(surf);
      return `<ruby>${esc(surf)}<rt>${esc(hira)}</rt></ruby>`;
    })
    .join("");
}

function posPopup(ev) {
  const popup = document.getElementById("popup");
  const pw = 300,
    ph = 210;
  let x = ev.clientX + 14,
    y = ev.clientY - ph - 14;
  if (x + pw > window.innerWidth) x = ev.clientX - pw - 14;
  if (y < 0) y = ev.clientY + 20;
  popup.style.left = x + "px";
  popup.style.top = y + "px";
}

function delayHidePopup() {
  popTimer = setTimeout(hidePopup, 400);
}
function cancelHidePopup() {
  clearTimeout(popTimer);
}
function hidePopup() {
  document.getElementById("popup").classList.remove("vis");
  if (activeTok) {
    activeTok.classList.remove("active-tok");
    activeTok = null;
  }
}

// POS hints for grammar tokens
function posHint(pos, surf) {
  const map = {
    助詞: "Particule grammaticale",
    助動詞: "Auxiliaire verbal",
    接続詞: "Conjonction",
    感動詞: "Interjection",
    記号: "Ponctuation",
  };
  const particleMap = {
    は: "marqueur de thème",
    が: "marqueur de sujet",
    を: "marqueur d'objet",
    に: "direction / lieu / temps",
    で: "lieu d'action / moyen",
    と: "et / avec",
    も: "aussi",
    の: "possession / nominalisation",
    か: "question",
    よ: "emphase",
    ね: "approbation / accord",
    へ: "direction",
    から: "depuis / parce que",
    まで: "jusqu'à",
    より: "que (comparaison)",
    けど: "mais",
    し: "et puis",
  };
  if (particleMap[surf]) return particleMap[surf];
  return map[pos] || null;
}

// ═══════════════════════════
// DICTIONARY — via local proxy (server.py)
// Falls back to kuromoji POS hint if server not running
// ═══════════════════════════
const SERVER = "http://localhost:8766";
const SKIP_POS = new Set(["助詞", "助動詞", "記号", "空白", "BOS/EOS"]);

async function lookup(word) {
  if (!word || word.length < 2) return [];
  if (dictCache[word] !== undefined) return dictCache[word];
  try {
    const r = await fetch(`${SERVER}/lookup?w=${encodeURIComponent(word)}`, {
      signal: AbortSignal.timeout(4000),
    });
    const d = await r.json();
    dictCache[word] = d.meanings || [];
    return dictCache[word];
  } catch {
    dictCache[word] = [];
    return [];
  }
}

// ═══════════════════════════
// CONTROLS
// ═══════════════════════════
function togglePlay() {
  const vid = document.getElementById("vid");
  if (vid.paused) vid.play();
  else vid.pause();
  document.getElementById("btnPlay").textContent = vid.paused ? "▶" : "⏸";
}

function updateProg() {
  const vid = document.getElementById("vid");
  if (!vid.duration) return;
  document.getElementById("progressFill").style.width =
    (vid.currentTime / vid.duration) * 100 + "%";
  document.getElementById("timeDisp").textContent =
    `${fmt(vid.currentTime)} / ${fmt(vid.duration)}`;
  document.getElementById("btnPlay").textContent = vid.paused ? "▶" : "⏸";
}

function seekTo(e) {
  const vid = document.getElementById("vid");
  if (!vid.duration) return;
  const r = document.getElementById("progressWrap").getBoundingClientRect();
  vid.currentTime =
    Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * vid.duration;
}

function fmt(s) {
  return `${Math.floor(s / 60)}:${Math.floor(s % 60)
    .toString()
    .padStart(2, "0")}`;
}

function adjOff(track, delta) {
  if (track === "jp") {
    jpOff = Math.round((jpOff + delta) * 10) / 10;
    document.getElementById("jpOff").textContent = jpOff.toFixed(1) + "s";
  } else {
    frOff = Math.round((frOff + delta) * 10) / 10;
    document.getElementById("frOff").textContent = frOff.toFixed(1) + "s";
  }
  lastJP = "";
  lastFR = ""; // force re-render
}

function togSub(track) {
  if (track === "jp") {
    showJP = !showJP;
    document.getElementById("togJP").classList.toggle("on", showJP);
    if (!showJP) document.getElementById("jpSubDisplay").innerHTML = "";
    else lastJP = "";
  } else {
    showFR = !showFR;
    document.getElementById("togFR").classList.toggle("on", showFR);
    if (!showFR) document.getElementById("frSubDisplay").textContent = "";
    else lastFR = "";
  }
}

function goBack() {
  const vid = document.getElementById("vid");
  vid.pause();
  vid.src = "";
  cancelAnimationFrame(rafId);
  document.removeEventListener("keydown", onKey);
  jpSubs = [];
  frSubs = [];
  lastJP = "";
  lastFR = "";
  jpOff = 0;
  frOff = 0;
  document.getElementById("jpOff").textContent = "0.0s";
  document.getElementById("frOff").textContent = "0.0s";
  document.getElementById("jpSubDisplay").innerHTML = "";
  document.getElementById("frSubDisplay").textContent = "";
  ["boxVideo", "boxJP", "boxFR"].forEach((id) =>
    document.getElementById(id).classList.remove("loaded"),
  );
  ["nameVideo", "nameJP", "nameFR"].forEach(
    (id) => (document.getElementById(id).textContent = ""),
  );
  videoFile = null;
  jpFile = null;
  frFile = null;
  document.getElementById("btnStart").classList.remove("ready");
  document.getElementById("playerWrap").classList.remove("active");
  document.getElementById("dropZone").classList.remove("hidden");
}

// ── Canvas screenshot capture ─────────────────────────────────────────────────
function captureFrame() {
  const vid = document.getElementById("vid");
  const canvas = document.getElementById("snapCanvas");
  try {
    const w = vid.videoWidth || 1280;
    const h = vid.videoHeight || 720;
    // cap at 1280px wide
    const scale = Math.min(1, 1280 / w);
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85); // data:image/jpeg;base64,...
  } catch (e) {
    console.warn("Canvas capture failed:", e);
    return "";
  }
}

// ═══════════════════════════
// ANKI INTEGRATION
// ═══════════════════════════

// Tracks the last popup context so addToAnki() knows what to send
let ankiContext = { jp: "", fr: "", word: "", meaning: "", source: "" };

async function addToAnki() {
  // Always read path fresh from input at send time
  const pathInput = document.getElementById("videoPathInput");
  if (pathInput) videoPathOverride = pathInput.value.trim();

  const btn = document.getElementById("popAnki");
  if (!ankiContext.jp) {
    showToast("Aucune phrase sélectionnée", false);
    return;
  }
  if (!videoPathOverride)
    showToast("⚠ Pas de chemin vidéo — audio ignoré", false);

  btn.classList.add("sending");
  btn.querySelector("span:last-child").textContent = "Envoi…";

  try {
    const resp = await fetch(`${SERVER}/anki/add-card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...ankiContext,
        video_path: videoPathOverride, // always use latest value from input
      }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await resp.json();

    if (data.success) {
      btn.classList.remove("sending");
      btn.classList.add("sent");
      btn.querySelector("span:last-child").textContent = "✓ Ajouté !";
      const extras = [data.has_audio ? "🔊" : "", data.has_image ? "🖼" : ""]
        .filter(Boolean)
        .join(" ");
      showToast(
        `Carte ajoutée ${extras} — ${ankiContext.word || ankiContext.jp.slice(0, 14)}`,
        true,
      );
      setTimeout(() => {
        btn.classList.remove("sent");
        btn.querySelector("span:last-child").textContent = "Ajouter à Anki";
      }, 2000);
    } else {
      throw new Error(data.error || "Erreur inconnue");
    }
  } catch (err) {
    btn.classList.remove("sending");
    btn.classList.add("error");
    btn.querySelector("span:last-child").textContent = "✗ Erreur";
    const msg =
      err.name === "TimeoutError" || err.message.includes("fetch")
        ? "Anki fermé ou serveur arrêté"
        : err.message;
    showToast(msg, false);
    console.error("Anki error:", err);
    setTimeout(() => {
      btn.classList.remove("error");
      btn.querySelector("span:last-child").textContent = "Ajouter à Anki";
    }, 3000);
  }
}

let toastTimer;
function showToast(msg, ok) {
  const t = document.getElementById("toast");
  clearTimeout(toastTimer);
  t.textContent = ok ? `✓  ${msg}` : `✗  ${msg}`;
  t.className = ok ? "show ok" : "show err";
  toastTimer = setTimeout(() => (t.className = ""), 3000);
}

// ═══════════════════════════════════════
// AI CHAT PANEL
// ═══════════════════════════════════════

let aiOpen = false;
let aiMessages = [];
let aiStreaming = false;
let aiSelectedWord = "";
let aiSelectedMeaning = "";
const AI_MAX_HISTORY = 6; // keep last 6 messages (3 exchanges) to limit tokens

function toggleAIPanel() {
  aiOpen = !aiOpen;
  document.getElementById("aiPanel").classList.toggle("open", aiOpen);
  document.getElementById("aiToggleBtn").classList.toggle("on", aiOpen);
  // Block video clicks from bleeding through the panel
  document.getElementById("videoWrap").style.pointerEvents = aiOpen
    ? "none"
    : "";
  if (aiOpen) {
    updateAIContext();
    document.getElementById("aiInput").focus();
  } else {
    aiMessages = [];
    aiSelectedWord = "";
    aiSelectedMeaning = "";
    document.getElementById("aiMessages").innerHTML = "";
  }
}

function checkApiKey() {
  const row = document.getElementById("aiKeyRow");
  row.classList.toggle("visible", !aiApiKey);
}

function saveApiKey() {
  const val = document.getElementById("aiKeyInput").value.trim();
  if (val) {
    aiApiKey = val;
    localStorage.setItem("ai_api_key", val);
    document.getElementById("aiKeyRow").classList.remove("visible");
    document.getElementById("aiKeyInput").value = "";
  }
}

function updateAIContext() {
  // Update context bar with current subtitle
  document.getElementById("aiCtxJP").textContent = lastJP || "—";
  document.getElementById("aiCtxFR").textContent = lastFR || "";
  document.getElementById("aiCtxWord").textContent = aiSelectedWord
    ? `mot sélectionné : 「${aiSelectedWord}」 — ${aiSelectedMeaning}`
    : "";
}

// Collect ±5 subtitle lines around current time for context
function getContextSubs() {
  if (!currentJPSub || !jpSubs.length) return [];
  const idx = jpSubs.indexOf(currentJPSub);
  if (idx < 0) return [];
  const result = [];
  for (
    let i = Math.max(0, idx - 4);
    i <= Math.min(jpSubs.length - 1, idx + 4);
    i++
  ) {
    const jp = jpSubs[i];
    // Find matching FR sub by overlap
    const fr = frSubs.find((s) => s.start < jp.end && s.end > jp.start);
    result.push({
      jp: jp.text,
      fr: fr ? fr.text : "",
      offset: i - idx,
    });
  }
  return result;
}

function quickAsk(prompt) {
  const ta = document.getElementById("aiInput");
  ta.value = prompt;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 100) + "px";
  setTimeout(sendChat, 0);
}

async function sendChat() {
  if (aiStreaming) return;
  const input = document.getElementById("aiInput");
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  input.style.height = "auto";

  // Trim history to last N messages before sending (keeps token cost low)
  if (aiMessages.length > AI_MAX_HISTORY) {
    aiMessages = aiMessages.slice(-AI_MAX_HISTORY);
  }

  // Snapshot context at send time
  updateAIContext();
  const contextSubs = getContextSubs();

  // Add user message to UI + history
  aiMessages.push({ role: "user", content: text });
  appendMessage("user", text);

  // Create assistant bubble for streaming (pass text as userText for Anki btn)
  const assistantEl = appendMessage("assistant", "", text);
  const bodyEl = assistantEl.querySelector(".ai-msg-body");

  aiStreaming = true;
  document.getElementById("aiSendBtn").disabled = true;
  document.getElementById("aiDot").classList.add("active");

  let fullResponse = "";

  try {
    const resp = await fetch(`${SERVER}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        current_jp: lastJP,
        current_fr: lastFR,
        context_subs: contextSubs,
        selected_word: aiSelectedWord,
        selected_meaning: aiSelectedMeaning,
        messages: aiMessages,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || resp.statusText);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    outer: while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") break outer;
        try {
          const chunk = JSON.parse(data);
          if (chunk.error) throw new Error(chunk.error);
          if (chunk.text) {
            fullResponse += chunk.text;
            bodyEl.textContent = fullResponse;
            document.getElementById("aiMessages").scrollTop = 99999;
          }
        } catch (e) {
          /* ignore partial chunks */
        }
      }
    }

    if (fullResponse) {
      aiMessages.push({ role: "assistant", content: fullResponse });
    }
  } catch (err) {
    bodyEl.textContent = `Erreur : ${err.message}`;
    bodyEl.style.color = "#f77e7e";
    aiMessages.pop(); // remove failed user message
    console.error("Chat error:", err);
  } finally {
    aiStreaming = false;
    const sendBtn = document.getElementById("aiSendBtn");
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.style.opacity = "";
      sendBtn.style.pointerEvents = "";
    }
    document.getElementById("aiDot").classList.remove("active");
    document.getElementById("aiInput").focus();
  }
}

function appendMessage(role, text, userText) {
  const msgs = document.getElementById("aiMessages");
  const div = document.createElement("div");
  div.className = `ai-msg ${role}`;

  const roleLabel = document.createElement("div");
  roleLabel.className = "ai-msg-role";
  roleLabel.textContent = role === "user" ? "Vous" : "AI";

  const body = document.createElement("div");
  body.className = "ai-msg-body";
  body.textContent = text;

  div.appendChild(roleLabel);
  div.appendChild(body);

  // Add Anki button on assistant messages (userText = the question that prompted this)
  if (role === "assistant") {
    const ankiBtn = document.createElement("button");
    ankiBtn.className = "msg-anki-btn";
    ankiBtn.textContent = "＋ Anki";
    ankiBtn.addEventListener("click", () =>
      openLLMModal(userText || "", body.textContent, ankiBtn),
    );
    div.appendChild(ankiBtn);
  }

  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

// ═══════════════════════════════════════
// LLM → ANKI MODAL
// ═══════════════════════════════════════

let llmModalSourceBtn = null;
let llmMediaContext = {}; // snapshot of timing/screenshot at modal open time

function openLLMModal(question, answer, triggerBtn) {
  llmModalSourceBtn = triggerBtn || null;

  // Snapshot media at open time (subtitle timing + screenshot)
  const vid = document.getElementById("vid");
  llmMediaContext = {
    screenshot: captureFrame(),
    video_path: videoPathOverride,
    start_time: currentJPSub ? currentJPSub.start : vid.currentTime || 0,
    end_time: currentJPSub ? currentJPSub.end : vid.currentTime || 0,
  };

  document.getElementById("llmQ").value = question;
  document.getElementById("llmA").value = answer;

  const ts = fmt(vid.currentTime || 0);
  const src =
    (videoFile ? videoFile.name.replace(/\.[^.]+$/, "") : "unknown") + "_" + ts;
  document.getElementById("llmSrc").value = src;

  document.getElementById("llmAnkiModal").classList.add("open");
  document.getElementById("llmQ").focus();
}

function closeLLMModal() {
  document.getElementById("llmAnkiModal").classList.remove("open");
  llmModalSourceBtn = null;
}

async function sendLLMCard() {
  const question = document.getElementById("llmQ").value.trim();
  const answer = document.getElementById("llmA").value.trim();
  const source = document.getElementById("llmSrc").value.trim();

  if (!question || !answer) {
    showToast("Question et Réponse sont requis", false);
    return;
  }

  const btn = document.getElementById("llmSendBtn");
  btn.disabled = true;
  btn.textContent = "Envoi…";

  try {
    const resp = await fetch(`${SERVER}/anki/add-llm-card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        answer,
        source,
        screenshot: llmMediaContext.screenshot || "",
        video_path: llmMediaContext.video_path || videoPathOverride,
        start_time: llmMediaContext.start_time || 0,
        end_time: llmMediaContext.end_time || 0,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json();

    if (data.success) {
      const extras = [data.has_audio ? "🔊" : "", data.has_image ? "🖼" : ""]
        .filter(Boolean)
        .join(" ");
      showToast(`Carte LLM ajoutée ${extras} — #${data.note_id}`, true);
      if (llmModalSourceBtn) llmModalSourceBtn.classList.add("sent");
      closeLLMModal();
    } else {
      throw new Error(data.error || "Erreur inconnue");
    }
  } catch (err) {
    const msg =
      err.name === "TimeoutError"
        ? "Anki fermé ou serveur arrêté"
        : err.message;
    showToast(msg, false);
    console.error("LLM card error:", err);
  } finally {
    btn.disabled = false;
    btn.textContent = "＋ Ajouter à Anki";
  }
}

// Wire modal buttons immediately
(function wireLLMModal() {
  document
    .getElementById("llmModalClose")
    .addEventListener("click", closeLLMModal);
  document
    .getElementById("llmCancelBtn")
    .addEventListener("click", closeLLMModal);
  document.getElementById("llmSendBtn").addEventListener("click", sendLLMCard);
  // Close on backdrop click
  document
    .getElementById("llmAnkiModal")
    .addEventListener("click", function (e) {
      if (e.target === this) closeLLMModal();
    });
  // Ctrl+Enter to send
  document
    .getElementById("llmAnkiModal")
    .addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeLLMModal();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendLLMCard();
    });
})();

// Wire up AI input — runs immediately since script is at end of body
(function wireAIInput() {
  const ta = document.getElementById("aiInput");
  const btn = document.getElementById("aiSendBtn");

  if (ta) {
    ta.addEventListener("input", function () {
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 100) + "px";
    });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        sendChat();
      }
    });
  }

  if (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      sendChat();
    });
  }
})();

// ═══════════════════════════
// KEYBOARD
// ═══════════════════════════
function onKey(e) {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  const vid = document.getElementById("vid");
  if (e.code === "Space") {
    e.preventDefault();
    togglePlay();
  }
  if (e.code === "ArrowLeft")
    vid.currentTime = Math.max(0, vid.currentTime - 5);
  if (e.code === "ArrowRight") vid.currentTime += 5;
  if (e.code === "ArrowUp") {
    vid.volume = Math.min(1, vid.volume + 0.1);
    document.getElementById("volSlider").value = vid.volume;
  }
  if (e.code === "ArrowDown") {
    vid.volume = Math.max(0, vid.volume - 0.1);
    document.getElementById("volSlider").value = vid.volume;
  }
  if (e.key === "j") adjOff("jp", -0.5);
  if (e.key === "k") adjOff("jp", +0.5);
  if (e.key === "f") adjOff("fr", -0.5);
  if (e.key === "g") adjOff("fr", +0.5);
  if (e.key === "1") togSub("jp");
  if (e.key === "2") togSub("fr");
  if (e.key === "a") toggleAIPanel();
}

// ═══════════════════════════
// CURSOR
// ═══════════════════════════
const cur = document.getElementById("customCursor");
let curT;
document.addEventListener("mousemove", (e) => {
  cur.style.left = e.clientX + "px";
  cur.style.top = e.clientY + "px";
  cur.style.opacity = "1";
  clearTimeout(curT);
  curT = setTimeout(() => (cur.style.opacity = "0"), 2500);
});
