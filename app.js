import { renderNwb, VIEWER_CSS } from "./viewer.js?v=2026-11-22b";

const style = document.createElement("style");
style.textContent = VIEWER_CSS;
document.head.appendChild(style);

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ------------------------------------------------------------------ Python worker
const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const params = new URLSearchParams(location.search);
const BUILD = "2026-11-22b"; // bump on every release so browsers fetch the new worker
const worker = new Worker(`worker.js?v=${BUILD}`);
let pyReady = false;
let msgId = 0;
const pending = new Map();
worker.postMessage({
  type: "init",
  pyodideBase: new URL(params.get("pyodide") || PYODIDE_CDN, location.href).href,
  siteBase: new URL(".", location.href).href,
});
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "status") setPy(`<span class="spinner"></span>${esc(m.text)}`);
  if (m.type === "ready") { pyReady = true; setPy("✓ Converter ready"); }
  if (m.type === "error") { setPy(`<span style="color:var(--bad)">Converter problem: ${esc(m.text)}</span>`); for (const r of pending.values()) r.reject(new Error(m.text)); pending.clear(); }
  if (m.type === "result" || m.type === "sheet") setPy("✓ Converter ready");
  if ((m.type === "result" || m.type === "sheet") && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }
};
function ask(type, payload) {
  const id = ++msgId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ type, id, ...payload }); });
}
function setPy(html) { const el = $("#pystatus"); if (el) el.innerHTML = html; }

// ------------------------------------------------------------------ routing
function route() {
  const h = location.hash.replace("#", "") || "home";
  const screen = ["create", "view"].includes(h) ? h : "home";
  document.querySelectorAll("[data-screen]").forEach((s) => s.classList.toggle("hidden", s.id !== screen));
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === screen));
  if (screen === "create") renderStep();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

// ------------------------------------------------------------------ wizard state
const SPECIES = [
  ["Mouse", "Mus musculus"], ["Rat", "Rattus norvegicus"], ["Human", "Homo sapiens"],
  ["Monkey", "Macaca mulatta"], ["Zebrafish", "Danio rerio"], ["Other", ""],
];
const SEXES = [["Male", "M"], ["Female", "F"], ["Unknown", "U"]];
const UNITS = ["", "s", "cm/s", "cm", "mm", "pixels", "degrees", "V", "mV", "µV", "A", "Hz", "%", "a.u.", "°C", "g", "N", "other…"];
const TIME_UNITS = [["seconds", 1], ["milliseconds", 0.001], ["minutes", 60]];
const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const TZS = [...new Set([browserTz, "America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago", "America/New_York",
  "America/Toronto", "America/Sao_Paulo", "Europe/London", "Europe/Paris", "Europe/Berlin", "Africa/Johannesburg", "Asia/Kolkata",
  "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland", "UTC"])];
const today = new Date().toISOString().slice(0, 10);

const st = {
  step: 0,
  experimenter: "", lab: "", institution: "", experiment_description: "",
  subject_id: "", species: "", species_other: "", sex: "", age_days: "", strain: "", weight_g: "",
  session_id: "1", session_date: today, start_time: "", timezone: browserTz, session_description: "",
  device_name: "", device_description: "", device_manufacturer: "",
  files: [],
  result: null,
};

const STEPS = [
  { title: "Let's make an NWB file", sub: "It takes about three minutes. You'll need one or more CSV files of cleaned data." },
  { title: "You and your lab", sub: "Who made this data?" },
  { title: "Your animal", sub: "Every NWB file says exactly who the data came from." },
  { title: "Your session", sub: "When it happened, and with what equipment." },
  { title: "Your data", sub: "Drop in your CSV files. We'll work out the rest and ask about anything unclear." },
  { title: "Check and create", sub: "Here's everything that will go into your file." },
  { title: "Your NWB file is ready", sub: "" },
];

// field definitions: [key, label, opts]
const F = {
  experimenter: ["Your name", { ph: "Jane Doe", hint: "Several people? Separate with a semicolon. We store it as \"Doe, Jane\".", req: true }],
  lab: ["Lab", { ph: "Whelan Lab", isNew: true, req: true }],
  institution: ["Institution", { ph: "University of Somewhere", isNew: true, req: true }],
  experiment_description: ["What is the experiment about?", { ph: "Wheel running and pupil size during a cue task.", isNew: true, area: true }],
  subject_id: ["Animal ID", { ph: "AAX-1", hint: "Letters, numbers and dashes work best for sharing on DANDI.", req: true }],
  age_days: ["Age in days", { ph: "90", type: "number", fmt: "We store it as P90D", hint: "On the day of the session." }],
  strain: ["Strain", { ph: "C57BL/6J" }],
  weight_g: ["Weight (g)", { ph: "25", type: "number" }],
  session_id: ["Session name", { ph: "day1", req: true }],
  session_date: ["Date", { type: "date", req: true }],
  start_time: ["Start time", { type: "time", hint: "When the recording started." }],
  session_description: ["What happened in this session?", { ph: "Cue task, day 1. Wheel speed and pupil recorded.", isNew: true, area: true, req: true }],
  device_name: ["Main instrument", { ph: "Pupil camera", isNew: true }],
  device_description: ["How was it set up?", { ph: "IR camera on the left eye, 30 frames per second", isNew: true }],
  device_manufacturer: ["Made by", { ph: "Basler", isNew: true }],
};

function input(key) {
  const [label, o] = F[key];
  const v = esc(st[key]);
  const ctl = o.area
    ? `<textarea data-k="${key}" placeholder="${esc(o.ph || "")}">${v}</textarea>`
    : `<input data-k="${key}" type="${o.type || "text"}" value="${v}" placeholder="${esc(o.ph || "")}" ${o.type === "number" ? 'min="0" step="any" inputmode="decimal"' : ""}>`;
  return `<div class="field ${st[key] ? "done" : ""}" data-f="${key}">
    <label class="lbl">${esc(label)}${o.req ? "" : ' <span style="font-weight:400;color:var(--muted)">optional</span>'}
      ${o.isNew ? '<span class="badge-new">★ NEW for most labs</span>' : ""}${o.fmt ? `<span class="badge-fmt">${esc(o.fmt)}</span>` : ""}
      <span class="ok-tick">✓</span></label>${ctl}${o.hint ? `<div class="hint">${esc(o.hint)}</div>` : ""}</div>`;
}

// ------------------------------------------------------------------ steps
function stepHtml() {
  switch (st.step) {
    case 0: return `
      <div class="center" style="margin-bottom:22px">
        <button class="btn big" data-go="1" type="button">Start</button>
        <div style="margin-top:12px"><button class="btn ghost" id="useExample" type="button">or try it with example data</button></div>
      </div>
      <div class="drop" id="sheetDrop" tabindex="0"><span class="big">📄</span>
        <strong>Filled in the one-page spreadsheet?</strong>Drop it here and we'll fill in steps 1 to 3 for you.
        <input type="file" id="sheetPick" accept=".xlsx" hidden></div>
      <div id="sheetMsg"></div>
      <p class="center" style="color:var(--muted);font-size:.9rem;margin-top:18px">Don't have it yet?
        <a href="template/NWB_metadata_sheet.xlsx" download>Download the one-page sheet</a>.</p>`;
    case 1: return input("experimenter") + `<div class="two">${input("lab")}${input("institution")}</div>` + input("experiment_description");
    case 2: return input("subject_id") + `
      <div class="field ${st.species ? "done" : ""}"><label class="lbl">Species <span class="badge-fmt">We store the Latin name</span><span class="ok-tick">✓</span></label>
        <div class="choices" data-choice="species">${SPECIES.map(([l, v]) => `<button type="button" class="choice ${speciesOn(l, v) ? "on" : ""}" data-label="${l}" data-v="${esc(v)}">${esc(l)}</button>`).join("")}</div>
        <div class="${st._otherOn ? "" : "hidden"}" id="otherWrap" style="margin-top:8px"><input data-k="species_other" type="text" value="${esc(st.species_other)}" placeholder="Latin name, e.g. Mustela putorius furo"></div>
        <div class="hint">${st.species ? `Stored as <i>${esc(st.species)}</i>` : "Pick one."}</div></div>
      <div class="field ${st.sex ? "done" : ""}"><label class="lbl">Sex <span class="badge-fmt">We store M / F / U</span><span class="ok-tick">✓</span></label>
        <div class="choices" data-choice="sex">${SEXES.map(([l, v]) => `<button type="button" class="choice ${st.sex === v ? "on" : ""}" data-v="${v}">${l}</button>`).join("")}</div></div>
      <div class="two">${input("age_days")}${input("weight_g")}</div>${input("strain")}`;
    case 3: return `<div class="two">${input("session_date")}${input("start_time")}</div>
      <div class="field done"><label class="lbl">Time zone <span class="badge-new">★ NEW for most labs</span><span class="ok-tick">✓</span></label>
        <select data-k="timezone">${TZS.map((z) => `<option ${z === st.timezone ? "selected" : ""}>${esc(z)}</option>`).join("")}</select>
        <div class="hint">Detected from your computer. Change it if the data was recorded somewhere else.</div></div>
      ${input("session_id")}${input("session_description")}
      <div class="two">${input("device_name")}${input("device_manufacturer")}</div>${input("device_description")}`;
    case 4: return `
      <div class="drop" id="csvDrop" tabindex="0"><span class="big">📈</span><strong>Drop CSV files here</strong>or click to choose them.
        Each file is one measurement (first column = time). Name one <code>trials.csv</code> if you have trials.
        <input type="file" id="csvPick" accept=".csv,.txt" multiple hidden></div>
      <div id="fileCards">${st.files.map(fileCard).join("")}</div>
      ${st.files.length ? "" : `<p class="center" style="color:var(--muted);font-size:.9rem;margin-top:14px">No data handy? <a href="template/example_csvs.zip" download>Download example CSVs</a>.</p>`}`;
    case 5: return reviewHtml();
    case 6: return doneHtml();
  }
  return "";
}

function speciesOn(label, value) {
  if (label === "Other") return !!st._otherOn;
  return !st._otherOn && st.species === value && value !== "";
}

function canContinue() {
  const filled = (k) => String(st[k] ?? "").trim() !== "";
  switch (st.step) {
    case 1: return ["experimenter", "lab", "institution"].every(filled);
    case 2: return filled("subject_id") && filled("species") && filled("sex");
    case 3: return ["session_date", "timezone", "session_id", "session_description"].every(filled);
    case 4: return st.files.length > 0 && st.files.every((f) => !f.error);
    default: return true;
  }
}

function missingText() {
  const names = {
    1: [["experimenter", "your name"], ["lab", "lab"], ["institution", "institution"]],
    2: [["subject_id", "animal ID"], ["species", "species"], ["sex", "sex"]],
    3: [["session_date", "date"], ["session_id", "session name"], ["session_description", "what happened"]],
  }[st.step] || [];
  const miss = names.filter(([k]) => !String(st[k] ?? "").trim()).map(([, n]) => n);
  if (st.step === 4) return !st.files.length ? "Add at least one CSV file." : st.files.some((f) => f.error) ? "Fix or remove the files marked in red." : "";
  return miss.length ? `Still needed: ${miss.join(", ")}.` : "";
}

function renderStep() {
  const bar = $("#stepbar");
  bar.innerHTML = st.step > 0 && st.step < 6 ? [1, 2, 3, 4, 5].map((i) => `<i class="${i <= st.step ? "on" : ""}"></i>`).join("") : "";
  const s = STEPS[st.step];
  const nav = st.step >= 1 && st.step <= 4
    ? `<div class="btns"><button class="btn ghost" data-go="${st.step - 1}" type="button">‹ Back</button>
        <span id="missing" style="color:var(--muted);font-size:.88rem;text-align:center;flex:1">${esc(missingText())}</span>
        <button class="btn" data-go="${st.step + 1}" id="next" type="button" ${canContinue() ? "" : "disabled"}>Continue</button></div>`
    : "";
  $("#wiz").innerHTML = `${st.step > 0 && st.step < 6 ? `<div class="stepno">Step ${st.step} of 5</div>` : ""}
    <h2>${esc(s.title)}</h2>${s.sub ? `<p class="sub">${esc(s.sub)}</p>` : ""}${stepHtml()}${nav}`;
  wireStep();
  if (st.step === 4) st.files.forEach((f, i) => miniPlot(f, i));
}

function refreshNav() {
  const n = $("#next");
  if (n) n.disabled = !canContinue();
  const m = $("#missing");
  if (m) m.textContent = missingText();
}

function wireStep() {
  const wiz = $("#wiz");
  wiz.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => {
    const to = Number(b.dataset.go);
    if (to > st.step && !canContinue()) return;
    st.step = to; renderStep(); window.scrollTo({ top: 0, behavior: "smooth" });
  }));
  wiz.querySelectorAll("[data-k]").forEach((el) => {
    const ev = el.tagName === "SELECT" ? "change" : "input";
    el.addEventListener(ev, () => {
      st[el.dataset.k] = el.value;
      if (el.dataset.k === "species_other") st.species = el.value.trim();
      const f = el.closest(".field");
      if (f) f.classList.toggle("done", el.value.trim() !== "");
      refreshNav();
    });
  });
  wiz.querySelectorAll("[data-choice]").forEach((row) => row.addEventListener("click", (e) => {
    const b = e.target.closest(".choice");
    if (!b) return;
    const key = row.dataset.choice;
    if (key === "species") {
      st._otherOn = b.dataset.label === "Other";
      st.species = st._otherOn ? st.species_other.trim() : b.dataset.v;
    } else {
      st[key] = b.dataset.v;
    }
    renderStep();
  }));
  if (st.step === 0) {
    $("#useExample").addEventListener("click", loadExample);
    setupDrop($("#sheetDrop"), $("#sheetPick"), (files) => importSheet(files[0]));
  }
  if (st.step === 4) {
    setupDrop($("#csvDrop"), $("#csvPick"), addCsvFiles);
    wiz.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => { st.files.splice(Number(b.dataset.rm), 1); renderStep(); }));
    wiz.querySelectorAll("[data-fi]").forEach((el) => el.addEventListener("change", () => {
      const f = st.files[Number(el.dataset.fi)];
      const what = el.dataset.what;
      if (what === "unit") {
        if (el.value === "other…") {
          const u = prompt("Unit for this column (e.g. N/m, lux):", "") || "";
          f.units[Number(el.dataset.col)] = u.trim();
        } else f.units[Number(el.dataset.col)] = el.value;
      }
      if (what === "timecol") f.timeCol = Number(el.value);
      if (what === "timescale") f.timeScale = Number(el.value);
      if (what === "kind") f.kind = el.value;
      checkFile(f);
      renderStep();
    }));
  }
  if (st.step === 5) {
    $("#createBtn").addEventListener("click", create);
    wiz.querySelectorAll("[data-edit]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); st.step = Number(a.dataset.edit); renderStep(); }));
  }
  if (st.step === 6 && st.result) {
    wiz.querySelectorAll("[data-dl]").forEach((b) => b.addEventListener("click", () => {
      const o = st.result.outputs[Number(b.dataset.dl)];
      download(o.name, o.bytes);
    }));
    $("#viewMine")?.addEventListener("click", () => {
      const o = st.result.outputs.find((x) => x.name.endsWith(".nwb"));
      viewBytes(o.bytes, o.name);
    });
    $("#again")?.addEventListener("click", () => { st.step = 2; st.files = []; st.result = null; st.subject_id = ""; renderStep(); });
  }
}

function setupDrop(zone, picker, onFiles) {
  zone.addEventListener("click", (e) => { if (!e.target.closest("button,a,input")) picker.click(); });
  zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); picker.click(); } });
  picker.addEventListener("change", () => { if (picker.files.length) onFiles([...picker.files]); picker.value = ""; });
  ["dragenter", "dragover"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove("over"); }));
  zone.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); });
}

// ------------------------------------------------------------------ CSV handling
function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const delim = (text.split("\n")[0].match(/;/g) || []).length > (text.split("\n")[0].match(/,/g) || []).length ? ";"
    : (text.split("\n")[0].includes("\t") && !text.split("\n")[0].includes(",") ? "\t" : ",");
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row.map((x) => x.trim()));
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row.map((x) => x.trim()));
  return rows;
}

const UNIT_RE = /^(.*?)\s*[[(]\s*(.+?)\s*[\])]\s*$/;
function splitUnit(h) { const m = UNIT_RE.exec(h); return m ? [m[1].trim(), m[2]] : [h.trim(), ""]; }

function analyse(name, text) {
  const rows = parseCsv(text);
  const f = { name, header: rows[0] || [], rows: rows.slice(1), units: [], timeCol: 0, timeScale: 1, kind: "series", error: "", warn: "" };
  const low = f.header.map((h) => h.toLowerCase());
  if (low.includes("start_time") && low.includes("stop_time")) f.kind = "trials";
  else if (/^trials?\b/i.test(name)) f.kind = "trials";
  const tIdx = low.findIndex((h) => /^(time|t|timestamp|timestamps|sec|seconds|time_s|time_ms)\b/.test(h));
  f.timeCol = tIdx >= 0 ? tIdx : 0;
  if (/ms\b|millisec/.test(low[f.timeCol] || "")) f.timeScale = 0.001;
  f.names = f.header.map((h) => splitUnit(h)[0]);
  f.units = f.header.map((h) => splitUnit(h)[1]);
  checkFile(f);
  return f;
}

function checkFile(f) {
  f.error = ""; f.warn = "";
  if (f.header.length < 2) { f.error = "Needs at least two columns (time plus one measurement)."; return; }
  if (!f.rows.length) { f.error = "Has a header row but no data."; return; }
  const bad = f.rows.findIndex((r) => r.length !== f.header.length);
  if (bad >= 0) { f.error = `Row ${bad + 2} has ${f.rows[bad].length} values but the header has ${f.header.length}.`; return; }
  if (f.kind === "trials") {
    const low = f.header.map((h) => h.toLowerCase());
    const si = low.indexOf("start_time"), ei = low.indexOf("stop_time");
    if (si < 0 || ei < 0) { f.error = "A trials file needs columns called start_time and stop_time (in seconds)."; return; }
    for (let i = 0; i < f.rows.length; i++) {
      const s = Number(f.rows[i][si]), e = Number(f.rows[i][ei]);
      if (!isFinite(s) || !isFinite(e)) { f.error = `Row ${i + 2}: start_time and stop_time must be numbers.`; return; }
      if (e < s) { f.error = `Row ${i + 2}: stop_time is before start_time.`; return; }
    }
    return;
  }
  let prev = -Infinity;
  for (let i = 0; i < f.rows.length; i++) {
    const r = f.rows[i];
    const t = Number(r[f.timeCol]);
    if (r[f.timeCol] === "" || !isFinite(t)) { f.error = `Row ${i + 2}: the time value "${r[f.timeCol]}" isn't a number.`; return; }
    if (t <= prev) { f.error = `Row ${i + 2}: time must go up on every row (sort the file and remove duplicates).`; return; }
    prev = t;
    for (let j = 0; j < r.length; j++) {
      if (j !== f.timeCol && r[j] !== "" && !isFinite(Number(r[j]))) { f.error = `Row ${i + 2}, column "${f.header[j]}": "${r[j]}" isn't a number.`; return; }
    }
  }
  const missing = f.units.filter((u, j) => j !== f.timeCol && !u).length;
  if (missing) f.warn = `Pick a unit for ${missing === 1 ? "the column" : `${missing} columns`} below. Units are what make data reusable.`;
}

function fileCard(f, i) {
  const dataCols = f.header.map((_, j) => j).filter((j) => j !== f.timeCol);
  const kindSel = `<select data-fi="${i}" data-what="kind" style="width:auto;padding:4px 8px;font-size:.85rem;border-radius:8px">
      <option value="series" ${f.kind === "series" ? "selected" : ""}>Time series</option>
      <option value="trials" ${f.kind === "trials" ? "selected" : ""}>Trials</option></select>`;
  let body = "";
  if (f.kind === "trials") {
    body = `<div class="hint" style="margin-top:6px">${f.rows.length} trials · columns: ${esc(f.header.join(", "))}</div>`;
  } else {
    body = `<div class="cols">
      <div class="col"><label>Time column</label><select data-fi="${i}" data-what="timecol">${f.header.map((h, j) => `<option value="${j}" ${j === f.timeCol ? "selected" : ""}>${esc(h)}</option>`).join("")}</select></div>
      <div class="col"><label>Time is in</label><select data-fi="${i}" data-what="timescale">${TIME_UNITS.map(([l, v]) => `<option value="${v}" ${v === f.timeScale ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      ${dataCols.map((j) => `<div class="col"><label>Unit of “${esc(f.names[j])}”</label>
        <select data-fi="${i}" data-what="unit" data-col="${j}" style="${f.units[j] ? "" : "border-color:var(--warn)"}">
        ${[...new Set([...UNITS, f.units[j]])].map((u) => `<option value="${esc(u)}" ${u === f.units[j] ? "selected" : ""}>${u ? esc(u) : "choose…"}</option>`).join("")}</select></div>`).join("")}
    </div>
    <div class="hint" style="margin-top:6px">${f.rows.length.toLocaleString()} rows · ${dataCols.length} measurement${dataCols.length === 1 ? "" : "s"}</div>
    ${f.error ? "" : `<div class="mini" id="mini${i}"></div>`}`;
  }
  return `<div class="fcard"><div class="fhead"><span class="fname">${esc(f.name)}</span>
      <span style="display:flex;gap:8px;align-items:center">${kindSel}<button class="x" data-rm="${i}" title="Remove" type="button">✕</button></span></div>
    ${body}${f.error ? `<div class="msg bad">${esc(f.error)}</div>` : f.warn ? `<div class="msg warn">${esc(f.warn)}</div>` : `<div class="msg ok">Looks good.</div>`}</div>`;
}

function miniPlot(f, i) {
  const el = document.getElementById(`mini${i}`);
  if (!el || !window.Plotly || f.kind !== "series") return;
  const j = f.header.map((_, k) => k).find((k) => k !== f.timeCol);
  const step = Math.max(1, Math.ceil(f.rows.length / 800));
  const x = [], y = [];
  for (let r = 0; r < f.rows.length; r += step) { x.push(Number(f.rows[r][f.timeCol]) * f.timeScale); y.push(Number(f.rows[r][j])); }
  const cs = getComputedStyle(document.documentElement);
  Plotly.newPlot(el, [{ x, y, type: "scatter", mode: "lines", line: { width: 1.2, color: cs.getPropertyValue("--accent").trim() }, hoverinfo: "skip" }], {
    margin: { l: 40, r: 6, t: 4, b: 22 }, height: 110, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { size: 10, color: cs.getPropertyValue("--muted").trim() },
    xaxis: { gridcolor: cs.getPropertyValue("--line").trim(), zeroline: false, ticksuffix: " s" },
    yaxis: { gridcolor: cs.getPropertyValue("--line").trim(), zeroline: false },
  }, { staticPlot: true, responsive: true });
}

async function addCsvFiles(files) {
  for (const file of files) {
    if (!/\.(csv|txt|tsv)$/i.test(file.name)) {
      alertMsg(`${file.name} isn't a CSV file. In Excel: File > Save As > CSV UTF-8.`);
      continue;
    }
    const f = analyse(file.name, await file.text());
    const existing = st.files.findIndex((x) => x.name === f.name);
    if (existing >= 0) st.files[existing] = f; else st.files.push(f);
  }
  renderStep();
}

function alertMsg(text) {
  const cards = $("#fileCards");
  if (cards) cards.insertAdjacentHTML("afterbegin", `<div class="msg bad">${esc(text)}</div>`);
}

// ------------------------------------------------------------------ example + spreadsheet import
const EXAMPLE = {
  experimenter: "Jane Doe", lab: "Example Lab", institution: "University of Somewhere",
  experiment_description: "Wheel running and pupil size during a cue task.",
  subject_id: "AAX-1", species: "Mus musculus", sex: "M", age_days: "90", strain: "C57BL/6J", weight_g: "25.1",
  session_id: "day1", session_date: "2026-05-29", start_time: "13:45", timezone: "America/Denver",
  session_description: "Cue task, day 1. Wheel speed and pupil recorded.",
  device_name: "Pupil camera", device_description: "IR camera on the left eye, 30 frames per second", device_manufacturer: "Basler",
};
const EXAMPLE_FILES = ["wheel.csv", "pupil_diameter.csv", "pupil_position.csv", "trials.csv"];

async function loadExample() {
  Object.assign(st, EXAMPLE, { _otherOn: false });
  const base = "template/example_dataset/sub-AAX_1/ses-01/";
  st.files = [];
  for (const n of EXAMPLE_FILES) {
    const r = await fetch(base + n);
    st.files.push(analyse(n, await r.text()));
  }
  st.step = 1;
  renderStep();
}

const SHEET_SPECIES = { mouse: "Mus musculus", rat: "Rattus norvegicus", human: "Homo sapiens", "rhesus macaque": "Macaca mulatta",
  monkey: "Macaca mulatta", zebrafish: "Danio rerio", "fruit fly": "Drosophila melanogaster", marmoset: "Callithrix jacchus" };

async function importSheet(file) {
  const out = $("#sheetMsg");
  if (!/\.xlsx$/i.test(file.name)) { out.innerHTML = `<div class="msg bad">Please drop the .xlsx spreadsheet.</div>`; return; }
  out.innerHTML = `<div class="msg"><span class="spinner"></span>${pyReady ? "Reading your spreadsheet…" : "Getting the converter ready, then reading your spreadsheet…"}</div>`;
  try {
    const res = await ask("read_sheet", { bytes: new Uint8Array(await file.arrayBuffer()) });
    if (!res.ok) throw new Error(res.error);
    const v = res.values;
    let n = 0;
    for (const k of Object.keys(F)) if (v[k]) { st[k] = String(v[k]); n++; }
    if (v.timezone) { st.timezone = v.timezone; if (!TZS.includes(v.timezone)) TZS.unshift(v.timezone); n++; }
    if (v.species) {
      const sp = SHEET_SPECIES[v.species.toLowerCase()] || v.species;
      const known = SPECIES.find(([, x]) => x === sp);
      st._otherOn = !known; st.species = sp; if (!known) st.species_other = sp; n++;
    }
    if (v.sex) { st.sex = { male: "M", m: "M", female: "F", f: "F" }[v.sex.toLowerCase()] || "U"; n++; }
    if (v.start_time) st.start_time = v.start_time.slice(0, 5);
    if (v.session_date) st.session_date = v.session_date.slice(0, 10);
    out.innerHTML = n
      ? `<div class="msg ok">Filled in ${n} answers from ${esc(file.name)}. Press Start to check them.</div>`
      : `<div class="msg warn">Couldn't find any answers in ${esc(file.name)}. Fill in the "Your value" column of the one-page sheet.</div>`;
  } catch (e) {
    out.innerHTML = `<div class="msg bad">Couldn't read that spreadsheet: ${esc(e.message || e)}</div>`;
  }
}

// ------------------------------------------------------------------ review + create
function reviewHtml() {
  const r = (k, label, v, step) => `<div class="rrow"><span class="k">${esc(label)}</span><span>${v ? esc(v) : '<span style="color:var(--muted)">–</span>'}</span><a href="#" class="edit" data-edit="${step}">Edit</a></div>`;
  const sp = SPECIES.find(([, v]) => v === st.species);
  return `<div class="review">
    <h4>You and your lab</h4>${r("", "Experimenter", st.experimenter, 1)}${r("", "Lab", st.lab, 1)}${r("", "Institution", st.institution, 1)}${r("", "Experiment", st.experiment_description, 1)}
    <h4>Animal</h4>${r("", "ID", st.subject_id, 2)}${r("", "Species", st.species ? `${sp ? sp[0] + " · " : ""}${st.species}` : "", 2)}${r("", "Sex", st.sex, 2)}${r("", "Age", st.age_days ? `${st.age_days} days (P${st.age_days}D)` : "", 2)}${r("", "Strain", st.strain, 2)}
    <h4>Session</h4>${r("", "Started", `${st.session_date}${st.start_time ? " " + st.start_time : ""} · ${st.timezone}`, 3)}${r("", "Name", st.session_id, 3)}${r("", "What happened", st.session_description, 3)}${r("", "Equipment", [st.device_name, st.device_manufacturer].filter(Boolean).join(", "), 3)}
    <h4>Data</h4>${st.files.map((f) => r("", f.kind === "trials" ? "Trials" : "Time series", `${f.name} (${f.rows.length.toLocaleString()} rows)`, 4)).join("")}
  </div>
  <div class="center" style="margin-top:26px">
    <button class="btn big" id="createBtn" type="button">Create my NWB file</button>
    <div id="createMsg" style="margin-top:14px"></div>
    <div style="margin-top:10px"><button class="btn ghost" data-go="4" type="button">‹ Back</button></div>
  </div>`;
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (cells) => cells.map(csvCell).join(",");
const enc = (s) => new TextEncoder().encode(s);
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "data";

function experimenterList() {
  return st.experimenter.split(/;| and /).map((p) => p.trim()).filter(Boolean)
    .map((p) => (p.includes(",") || !p.includes(" ") ? p : `${p.split(" ").slice(-1)[0]}, ${p.split(" ").slice(0, -1).join(" ")}`)).join("; ");
}

function buildFiles() {
  const files = {};
  const sid = st.subject_id.trim(), ses = st.session_id.trim();
  files["dataset.csv"] = enc([csvRow(["field", "value"]), csvRow(["institution", st.institution]), csvRow(["lab", st.lab]),
    csvRow(["experiment_description", st.experiment_description])].join("\n"));
  files["subjects.csv"] = enc([csvRow(["subject_id", "species", "sex", "age_days", "strain", "weight_g"]),
    csvRow([sid, st.species, st.sex, st.age_days, st.strain, st.weight_g])].join("\n"));
  const dev = st.device_name.trim();
  files["sessions.csv"] = enc([csvRow(["session_id", "subject_id", "session_date", "start_time", "timezone", "session_description", "experimenter", "devices"]),
    csvRow([ses, sid, st.session_date, st.start_time, st.timezone, st.session_description, experimenterList(), dev])].join("\n"));
  if (dev) files["devices.csv"] = enc([csvRow(["name", "description", "manufacturer"]), csvRow([dev, st.device_description, st.device_manufacturer])].join("\n"));
  const folder = `sub-${sid}/ses-${ses}/`;
  const used = new Set();
  for (const f of st.files) {
    const stem = safe(f.name.replace(/\.[^.]+$/, ""));
    if (f.kind === "trials") {
      const low = f.header.map((h) => h.toLowerCase());
      const order = [low.indexOf("start_time"), low.indexOf("stop_time"), ...f.header.map((_, j) => j).filter((j) => !["start_time", "stop_time"].includes(low[j]))];
      const head = order.map((j) => (j < 2 && order.indexOf(j) < 2 ? low[j] : f.header[j]));
      files[folder + "trials.csv"] = enc([csvRow(head), ...f.rows.map((r) => csvRow(order.map((j) => r[j])))].join("\n"));
      continue;
    }
    const dataCols = f.header.map((_, j) => j).filter((j) => j !== f.timeCol);
    const groups = {};
    for (const j of dataCols) (groups[f.units[j] || "unknown"] ||= []).push(j);
    const gk = Object.keys(groups);
    for (const unit of gk) {
      let name = gk.length > 1 ? `${stem}_${safe(unit)}` : stem;
      while (used.has(name)) name += "_2";
      used.add(name);
      const cols = groups[unit];
      const head = ["time_s", ...cols.map((j) => (unit === "unknown" ? f.names[j] : `${f.names[j]} [${unit}]`))];
      const lines = [csvRow(head)];
      for (const r of f.rows) lines.push(csvRow([Number(r[f.timeCol]) * f.timeScale, ...cols.map((j) => r[j])]));
      files[`${folder}${name}.csv`] = enc(lines.join("\n"));
    }
  }
  return files;
}

async function create() {
  const btn = $("#createBtn"), msg = $("#createMsg");
  btn.disabled = true;
  msg.innerHTML = `<span class="spinner"></span>${pyReady ? "Building and checking your file…" : "Getting the converter ready (first time takes about 20 seconds)…"}`;
  try {
    const res = await ask("convert", { files: buildFiles() });
    if (res.status !== "ok" || !res.outputs.length) {
      const text = res.status === "layout" ? res.lines[0] : res.lines.join("\n");
      msg.innerHTML = `<div class="msg bad" style="text-align:left;white-space:pre-wrap">${esc(text)}</div>`;
      btn.disabled = false;
      return;
    }
    st.result = res;
    st.step = 6;
    renderStep();
    const o = res.outputs.find((x) => x.name.endsWith(".nwb"));
    if (o) viewBytes(o.bytes, o.name, $("#inlineView"));
  } catch (e) {
    msg.innerHTML = `<div class="msg bad">${esc(e.message || e)}</div>`;
    btn.disabled = false;
  }
}

function doneHtml() {
  const res = st.result;
  if (!res) return "";
  const nwb = res.outputs.map((o, i) => [o, i]).filter(([o]) => o.name.endsWith(".nwb"));
  const failed = res.lines.some((l) => l.includes("FAILED"));
  const issues = res.inspect || [];
  const serious = issues.filter((i) => !["BEST_PRACTICE_SUGGESTION"].includes(i.importance));
  const lvl = (imp) => imp === "BEST_PRACTICE_SUGGESTION" ? ["s", "suggestion"] : imp === "BEST_PRACTICE_VIOLATION" ? ["v", "fix before sharing"] : ["c", "important"];
  return `<div class="center"><div class="donecheck">✓</div>
      <p style="margin:0 0 18px;color:var(--muted)">${failed ? "Created, but the NWB format check found problems (below)." : "Created and checked against the NWB standard."}</p>
      ${nwb.map(([o, i]) => `<button class="btn big" data-dl="${i}" type="button">Download ${esc(o.name)}</button>`).join(" ")}
      <div style="margin-top:12px"><button class="btn soft" id="viewMine" type="button">Open it in the viewer</button>
      <button class="btn ghost" id="again" type="button">Make another</button></div></div>
    <h4 style="margin:26px 0 4px">Quality check for sharing on DANDI</h4>
    ${issues.length === 0 ? `<div class="msg ok">No issues found. This file follows NWB best practices.</div>`
      : `<div class="msg ${serious.length ? "warn" : "ok"}">${serious.length ? `${serious.length} thing${serious.length === 1 ? "" : "s"} to fix before uploading to DANDI.` : "Only suggestions. Nothing blocks sharing."}</div>
        <ul class="issues">${issues.map((i) => `<li><span class="lvl ${lvl(i.importance)[0]}">${lvl(i.importance)[1]}</span>${esc(i.message)} <span style="color:var(--muted)">(${esc(i.where)})</span></li>`).join("")}</ul>`}
    <details style="margin-top:14px"><summary style="cursor:pointer;color:var(--muted)">What went into the file</summary><pre class="nv-pre">${esc(res.lines.join("\n"))}</pre></details>
    <div id="inlineView" style="margin-top:28px"></div>`;
}

function download(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/x-hdf5" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ------------------------------------------------------------------ viewer screen
async function viewBytes(bytes, name, target) {
  if (!target) {
    location.hash = "#view";
    target = $("#viewOut");
  }
  try { await renderNwb(target, new Uint8Array(bytes), name); }
  catch (e) { target.innerHTML = `<div class="nv-err">Couldn't open ${esc(name)}: ${esc(e.message || e)}</div>`; }
  if (target.id === "viewOut") target.scrollIntoView({ behavior: "smooth" });
}

setupDrop($("#viewDrop"), $("#viewPick"), async (files) => {
  const f = files[0];
  viewBytes(new Uint8Array(await f.arrayBuffer()), f.name, $("#viewOut"));
});
$("#viewExample").addEventListener("click", async (e) => {
  e.stopPropagation();
  const r = await fetch("template/example.nwb");
  viewBytes(new Uint8Array(await r.arrayBuffer()), "sub-AAX-1_ses-day1.nwb", $("#viewOut"));
});

route();
