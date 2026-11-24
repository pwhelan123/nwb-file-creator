import { renderNwb, resolveLink, VIEWER_CSS } from "./viewer.js?v=2026-11-24a";

const style = document.createElement("style");
style.textContent = VIEWER_CSS;
document.head.appendChild(style);

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ------------------------------------------------------------------ Python worker
const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const params = new URLSearchParams(location.search);
const BUILD = "2026-11-24a"; // bump on every release so browsers fetch the new worker
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
  ["Rhesus macaque", "Macaca mulatta"], ["Marmoset", "Callithrix jacchus"], ["Zebrafish", "Danio rerio"],
  ["Fruit fly", "Drosophila melanogaster"], ["Zebra finch", "Taeniopygia guttata"], ["Ferret", "Mustela putorius furo"],
  ["Cat", "Felis catus"], ["Pig", "Sus scrofa"], ["Prairie vole", "Microtus ochrogaster"],
  ["Roundworm (C. elegans)", "Caenorhabditis elegans"], ["Frog (Xenopus)", "Xenopus laevis"],
];
const LATIN_RE = /^[A-Z][a-z]+ [a-z]+( [a-z]+)?$/;
const SEXES = [["Male", "M"], ["Female", "F"], ["Unknown", "U"]];
const UNITS = ["", "s", "cm/s", "cm", "mm", "pixels", "degrees", "V", "mV", "µV", "A", "Hz", "%", "a.u.", "°C", "g", "N", "other…"];
const TIME_UNITS = [["seconds", 1], ["milliseconds", 0.001], ["minutes", 60]];
const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
// [label people recognise, IANA name]. Keep the labels in sync with TIMEZONES in tools/make_sheet.py.
const TZ_LIST = [
  ["US Pacific (Los Angeles)", "America/Los_Angeles"], ["US Mountain (Denver)", "America/Denver"],
  ["US Arizona (Phoenix)", "America/Phoenix"], ["US Central (Chicago)", "America/Chicago"],
  ["US Eastern (New York)", "America/New_York"], ["US Alaska (Anchorage)", "America/Anchorage"],
  ["US Hawaii (Honolulu)", "Pacific/Honolulu"], ["Canada Pacific (British Columbia)", "America/Vancouver"],
  ["Canada Mountain (Alberta)", "America/Edmonton"], ["Canada Saskatchewan (Regina)", "America/Regina"],
  ["Canada Central (Manitoba)", "America/Winnipeg"], ["Canada Eastern (Ontario, Quebec)", "America/Toronto"],
  ["Canada Atlantic (Nova Scotia)", "America/Halifax"], ["Canada Newfoundland (St. John's)", "America/St_Johns"],
  ["Mexico (Mexico City)", "America/Mexico_City"], ["Brazil (Sao Paulo)", "America/Sao_Paulo"],
  ["UK and Ireland (London)", "Europe/London"], ["Central Europe (Paris, Berlin, Madrid)", "Europe/Paris"],
  ["Eastern Europe (Athens, Helsinki)", "Europe/Athens"], ["Israel (Jerusalem)", "Asia/Jerusalem"],
  ["South Africa (Johannesburg)", "Africa/Johannesburg"], ["India (Kolkata)", "Asia/Kolkata"],
  ["China (Shanghai)", "Asia/Shanghai"], ["Singapore", "Asia/Singapore"], ["Korea (Seoul)", "Asia/Seoul"],
  ["Japan (Tokyo)", "Asia/Tokyo"], ["Australia East (Sydney)", "Australia/Sydney"], ["Australia West (Perth)", "Australia/Perth"],
  ["New Zealand (Auckland)", "Pacific/Auckland"], ["UTC", "UTC"],
];
if (!TZ_LIST.some(([, z]) => z === browserTz)) TZ_LIST.unshift([`Your computer (${browserTz})`, browserTz]);
function validTz(z) { try { new Intl.DateTimeFormat("en", { timeZone: z }); return true; } catch { return false; } }
// "9:43", "09:43:00", "9.43", "943", "1:45 PM" -> "09:43" / "13:45"; "" if it isn't a time
function normTime(v) {
  let s = String(v ?? "").trim().toUpperCase().replace(".", ":");
  if (!s) return "";
  if (/^\d{3,4}$/.test(s)) s = s.slice(0, -2) + ":" + s.slice(-2);
  const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(AM|PM)?$/.exec(s);
  if (!m) return "";
  let h = Number(m[1]); const min = Number(m[2]);
  if (m[3]) { if (h < 1 || h > 12) return ""; h = (h % 12) + (m[3] === "PM" ? 12 : 0); }
  if (h > 23 || min > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
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
      <div class="field ${speciesOk() ? "done" : ""}"><label class="lbl">Species <span class="badge-fmt">We store the Latin name</span><span class="ok-tick">✓</span></label>
        <select id="speciesSel">
          <option value="" ${!st.species && !st._otherOn ? "selected" : ""}>Choose…</option>
          ${SPECIES.map(([l, v]) => `<option value="${esc(v)}" ${!st._otherOn && st.species === v ? "selected" : ""}>${esc(l)}</option>`).join("")}
          <option value="__other" ${st._otherOn ? "selected" : ""}>Not in the list…</option></select>
        <div class="${st._otherOn ? "" : "hidden"}" id="otherWrap" style="margin-top:8px"><input data-k="species_other" type="text" value="${esc(st.species_other)}" placeholder="Latin name, e.g. Peromyscus maniculatus"></div>
        <div class="hint" id="speciesHint">${speciesHint()}</div></div>
      <div class="field ${st.sex ? "done" : ""}"><label class="lbl">Sex <span class="badge-fmt">We store M / F / U</span><span class="ok-tick">✓</span></label>
        <div class="choices" data-choice="sex">${SEXES.map(([l, v]) => `<button type="button" class="choice ${st.sex === v ? "on" : ""}" data-v="${v}">${l}</button>`).join("")}</div></div>
      <div class="two">${input("age_days")}${input("weight_g")}</div>${input("strain")}`;
    case 3: return `<div class="two">${input("session_date")}${input("start_time")}</div>
      <div class="field done"><label class="lbl">Time zone <span class="badge-new">★ NEW for most labs</span><span class="ok-tick">✓</span></label>
        <select data-k="timezone">${TZ_LIST.map(([l, z]) => `<option value="${esc(z)}" ${z === st.timezone ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
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

function speciesOk() { return st._otherOn ? LATIN_RE.test(st.species) : !!st.species; }
function speciesHint() {
  if (st._otherOn) return LATIN_RE.test(st.species) ? `Stored as <i>${esc(st.species)}</i>`
    : `<span style="color:var(--bad)">Type the Latin name: Genus species, like <i>Peromyscus maniculatus</i>.</span>`;
  return st.species ? `Stored as <i>${esc(st.species)}</i>` : "Pick one.";
}

function canContinue() {
  const filled = (k) => String(st[k] ?? "").trim() !== "";
  switch (st.step) {
    case 1: return ["experimenter", "lab", "institution"].every(filled);
    case 2: return filled("subject_id") && speciesOk() && filled("sex");
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
  const miss = names.filter(([k]) => (k === "species" ? !speciesOk() : !String(st[k] ?? "").trim())).map(([, n]) => n);
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
      if (el.dataset.k === "species_other") {
        st.species = el.value.trim();
        $("#speciesHint").innerHTML = speciesHint();
        el.closest(".field").classList.toggle("done", speciesOk());
      }
      const f = el.closest(".field");
      if (f) f.classList.toggle("done", el.value.trim() !== "");
      refreshNav();
    });
  });
  $("#speciesSel")?.addEventListener("change", (e) => {
    st._otherOn = e.target.value === "__other";
    st.species = st._otherOn ? st.species_other.trim() : e.target.value;
    renderStep();
    if (st._otherOn) $("#otherWrap input")?.focus();
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
    wiz.querySelectorAll('[data-what="cname"],[data-what="cdesc"]').forEach((el) => el.addEventListener("input", () => {
      const fi = Number(el.dataset.fi), f = st.files[fi], j = Number(el.dataset.col);
      if (el.dataset.what === "cdesc") { f.desc[j] = el.value; return; }
      f.names[j] = el.value;
      checkFile(f);
      wiz.querySelector(`[data-msg="${fi}"]`).innerHTML = fileMsg(f);
      refreshNav();
    }));
    wiz.querySelectorAll("[data-fi]:not([data-what=cname]):not([data-what=cdesc])").forEach((el) => el.addEventListener("change", () => {
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
  f.desc = f.header.map(() => "");
  checkFile(f);
  return f;
}

// Blank cells and the usual "missing" spellings count as empty, not as text.
const MISSING = new Set(["", "nan", "na", "n/a", "none", "null", "-"]);
const isNumCell = (v) => MISSING.has(String(v).trim().toLowerCase()) || isFinite(Number(v));
const dataCols = (f) => f.header.map((_, j) => j).filter((j) => (f.kind === "trials" ? !["start_time", "stop_time"].includes(f.header[j].toLowerCase()) : j !== f.timeCol));
const cleanName = (s) => String(s).replace(/[[\]()]/g, "").trim();

function checkFile(f) {
  f.error = ""; f.warn = "";
  if (f.header.length < 2) { f.error = "Needs at least two columns (time plus one measurement)."; return; }
  if (!f.rows.length) { f.error = "Has a header row but no data."; return; }
  const bad = f.rows.findIndex((r) => r.length !== f.header.length);
  if (bad >= 0) { f.error = `Row ${bad + 2} has ${f.rows[bad].length} values but the header has ${f.header.length}.`; return; }
  f.isText = f.header.map((_, j) => f.rows.some((r) => !isNumCell(r[j])));
  const names = dataCols(f).map((j) => cleanName(f.names[j]).toLowerCase());
  if (names.some((n) => !n)) { f.error = "Every column needs a name."; return; }
  const dup = names.find((n, k) => names.indexOf(n) !== k);
  if (dup) { f.error = `Two columns are both called "${dup}". Give them different names.`; return; }
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
  }
  const missing = dataCols(f).filter((j) => !f.isText[j] && !f.units[j]).length;
  if (missing) f.warn = `Pick a unit for ${missing === 1 ? "the number column" : `${missing} number columns`} below. Units are what make data reusable.`;
}

function fileCard(f, i) {
  const cols = dataCols(f);
  const kindSel = `<select data-fi="${i}" data-what="kind" style="width:auto;padding:4px 8px;font-size:.85rem;border-radius:8px">
      <option value="series" ${f.kind === "series" ? "selected" : ""}>Time series</option>
      <option value="trials" ${f.kind === "trials" ? "selected" : ""}>Trials</option></select>`;
  const nText = cols.filter((j) => f.isText?.[j]).length, nNum = cols.length - nText;
  const colRow = (j) => `<div class="crow">
      <input data-fi="${i}" data-what="cname" data-col="${j}" value="${esc(f.names[j])}" aria-label="Column name" title="Column name">
      <input data-fi="${i}" data-what="cdesc" data-col="${j}" value="${esc(f.desc[j])}" placeholder="e.g. ${f.kind === "trials" ? "which tone was played" : f.isText?.[j] ? "which spout the animal licked" : "running speed from the wheel encoder"}" aria-label="Description">
      ${f.kind === "trials" ? `<span class="pill num">${f.isText?.[j] ? "Text" : "Number"}</span>`
        : f.isText?.[j]
        ? `<span class="pill" title="Text can't go in a time series, so these values are saved as an events table: one row each time the text changes.">Text → events</span>`
        : `<select data-fi="${i}" data-what="unit" data-col="${j}" aria-label="Unit" style="${f.units[j] ? "" : "border-color:var(--warn)"}">
            ${[...new Set([...UNITS, f.units[j]])].map((u) => `<option value="${esc(u)}" ${u === f.units[j] ? "selected" : ""}>${u ? esc(u) : "unit…"}</option>`).join("")}</select>`}
    </div>`;
  let body = "";
  if (f.kind === "series") {
    body = `<div class="cols">
      <div class="col"><label>Time column</label><select data-fi="${i}" data-what="timecol">${f.header.map((h, j) => `<option value="${j}" ${j === f.timeCol ? "selected" : ""}>${esc(h)}</option>`).join("")}</select></div>
      <div class="col"><label>Time is in</label><select data-fi="${i}" data-what="timescale">${TIME_UNITS.map(([l, v]) => `<option value="${v}" ${v === f.timeScale ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    </div>`;
  }
  body += cols.length ? `<div class="ctable"><div class="crow chead"><span>Column name</span><span>What is it? <span style="font-weight:400">(optional, but it helps others)</span></span><span>${f.kind === "trials" ? "Type" : "Unit"}</span></div>
      ${cols.map(colRow).join("")}</div>` : "";
  body += `<div class="hint" style="margin-top:6px">${f.kind === "trials" ? `${f.rows.length} trials`
      : `${f.rows.length.toLocaleString()} rows · ${nNum} number column${nNum === 1 ? "" : "s"}${nText ? ` · ${nText} text column${nText === 1 ? "" : "s"} saved as events` : ""}`}</div>
    ${f.kind === "series" && !f.error && nNum ? `<div class="mini" id="mini${i}"></div>` : ""}`;
  return `<div class="fcard"><div class="fhead"><span class="fname">${esc(f.name)}</span>
      <span style="display:flex;gap:8px;align-items:center">${kindSel}<button class="x" data-rm="${i}" title="Remove" type="button">✕</button></span></div>
    ${body}<div data-msg="${i}">${fileMsg(f)}</div></div>`;
}

function fileMsg(f) {
  return f.error ? `<div class="msg bad">${esc(f.error)}</div>` : f.warn ? `<div class="msg warn">${esc(f.warn)}</div>` : `<div class="msg ok">Looks good.</div>`;
}

function miniPlot(f, i) {
  const el = document.getElementById(`mini${i}`);
  if (!el || !window.Plotly || f.kind !== "series") return;
  const j = dataCols(f).find((k) => !f.isText[k]);
  if (j === undefined) return;
  const step = Math.max(1, Math.ceil(f.rows.length / 800));
  const x = [], y = [];
  for (let r = 0; r < f.rows.length; r += step) { x.push(Number(f.rows[r][f.timeCol]) * f.timeScale); y.push(isFinite(Number(f.rows[r][j])) && f.rows[r][j] !== "" ? Number(f.rows[r][j]) : null); }
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

const SHEET_SPECIES = Object.fromEntries([...SPECIES.map(([l, v]) => [l.toLowerCase(), v]), ["monkey", "Macaca mulatta"],
  ["macaque", "Macaca mulatta"], ["mice", "Mus musculus"], ["c. elegans", "Caenorhabditis elegans"], ["xenopus", "Xenopus laevis"]]);

async function importSheet(file) {
  const out = $("#sheetMsg");
  if (!/\.xlsx$/i.test(file.name)) { out.innerHTML = `<div class="msg bad">Please drop the .xlsx spreadsheet.</div>`; return; }
  out.innerHTML = `<div class="msg"><span class="spinner"></span>${pyReady ? "Reading your spreadsheet…" : "Getting the converter ready, then reading your spreadsheet…"}</div>`;
  try {
    const res = await ask("read_sheet", { bytes: new Uint8Array(await file.arrayBuffer()) });
    if (!res.ok) throw new Error(res.error);
    const v = res.values;
    let n = 0;
    const skipped = [];
    for (const k of Object.keys(F)) if (v[k] && !["start_time", "session_date"].includes(k)) { st[k] = String(v[k]); n++; }
    if (v.timezone) {
      const t = String(v.timezone).trim();
      const hit = TZ_LIST.find(([l, z]) => l.toLowerCase() === t.toLowerCase() || z.toLowerCase() === t.toLowerCase());
      if (hit) { st.timezone = hit[1]; n++; }
      else if (validTz(t)) { st.timezone = t; if (!TZ_LIST.some(([, z]) => z === t)) TZ_LIST.unshift([t, t]); n++; }
      else skipped.push(`time zone "${t}" (pick one from the list in step 3)`);
    }
    if (v.species) {
      const t = String(v.species).trim();
      const sp = SHEET_SPECIES[t.toLowerCase()] || (LATIN_RE.test(t) ? t : "");
      if (sp) { const known = SPECIES.some(([, x]) => x === sp); st._otherOn = !known; st.species = sp; if (!known) st.species_other = sp; n++; }
      else skipped.push(`species "${t}" (pick one from the list in step 2, or type its Latin name)`);
    }
    if (v.sex) {
      const sx = { male: "M", m: "M", female: "F", f: "F", unknown: "U", u: "U" }[String(v.sex).trim().toLowerCase()];
      if (sx) { st.sex = sx; n++; } else skipped.push(`sex "${v.sex}"`);
    }
    if (v.start_time) {
      const t = normTime(v.start_time);
      if (t) { st.start_time = t; n++; } else skipped.push(`start time "${v.start_time}" (use a time like 9:43 or 13:45)`);
    }
    if (v.session_date) {
      const d = String(v.session_date).trim();
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(d) || /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d);
      const iso = !m ? "" : m[1].length === 4 ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
      if (iso) { st.session_date = iso; n++; } else skipped.push(`date "${d}" (use 2026-05-29)`);
    }
    out.innerHTML = (n
      ? `<div class="msg ok">Filled in ${n} answers from ${esc(file.name)}. Press Start to check them.</div>`
      : `<div class="msg warn">Couldn't find any answers in ${esc(file.name)}. Fill in the "Your value" column of the one-page sheet.</div>`)
      + (skipped.length ? `<div class="msg warn">Left blank because we couldn't use them: ${skipped.map(esc).join("; ")}.</div>` : "");
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
    <h4>Session</h4>${r("", "Started", `${st.session_date}${st.start_time ? " " + st.start_time : ""} · ${(TZ_LIST.find(([, z]) => z === st.timezone) || [st.timezone])[0]}`, 3)}${r("", "Name", st.session_id, 3)}${r("", "What happened", st.session_description, 3)}${r("", "Equipment", [st.device_name, st.device_manufacturer].filter(Boolean).join(", "), 3)}
    <h4>Data</h4>${st.files.map((f) => {
      const cols = dataCols(f), txt = cols.filter((j) => f.isText[j]), num = cols.filter((j) => !f.isText[j]);
      const list = (js) => js.map((j) => cleanName(f.names[j])).join(", ");
      const what = f.kind === "trials" ? `${f.rows.length} trials${cols.length ? `: ${list(cols)}` : ""}`
        : [num.length ? `time series: ${list(num)}` : "", txt.length ? `events: ${list(txt)}` : ""].filter(Boolean).join(" · ");
      return r("", f.name, `${what} (${f.rows.length.toLocaleString()} rows)`, 4);
    }).join("")}
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
  const notes = [csvRow(["file", "column", "description"])];
  const note = (file, j, f) => { if (f.desc[j].trim()) notes.push(csvRow([file, cleanName(f.names[j]), f.desc[j].trim()])); };
  for (const f of st.files) {
    const stem = safe(f.name.replace(/\.[^.]+$/, ""));
    if (f.kind === "trials") {
      const low = f.header.map((h) => h.toLowerCase());
      const order = [low.indexOf("start_time"), low.indexOf("stop_time"), ...f.header.map((_, j) => j).filter((j) => !["start_time", "stop_time"].includes(low[j]))];
      const head = order.map((j, k) => (k < 2 ? low[j] : cleanName(f.names[j])));
      files[folder + "trials.csv"] = enc([csvRow(head), ...f.rows.map((r) => csvRow(order.map((j) => r[j])))].join("\n"));
      order.slice(2).forEach((j) => note("trials.csv", j, f));
      continue;
    }
    const groups = {};
    const textCols = dataCols(f).filter((j) => f.isText[j]);
    for (const j of dataCols(f).filter((k) => !f.isText[k])) (groups[f.units[j] || "unknown"] ||= []).push(j);
    const gk = Object.keys(groups);
    for (const unit of gk) {
      let name = gk.length > 1 ? `${stem}_${safe(unit)}` : stem;
      while (used.has(name)) name += "_2";
      used.add(name);
      const cols = groups[unit];
      const head = ["time_s", ...cols.map((j) => (unit === "unknown" ? cleanName(f.names[j]) : `${cleanName(f.names[j])} [${unit}]`))];
      const lines = [csvRow(head)];
      for (const r of f.rows) lines.push(csvRow([Number(r[f.timeCol]) * f.timeScale, ...cols.map((j) => r[j])]));
      files[`${folder}${name}.csv`] = enc(lines.join("\n"));
      cols.forEach((j) => note(`${name}.csv`, j, f));
    }
    if (textCols.length) {
      let name = gk.length ? `${stem}_events` : stem;
      while (used.has(name)) name += "_2";
      used.add(name);
      const lines = [csvRow(["time_s", ...textCols.map((j) => cleanName(f.names[j]))])];
      for (const r of f.rows) lines.push(csvRow([Number(r[f.timeCol]) * f.timeScale, ...textCols.map((j) => r[j])]));
      files[`${folder}${name}.csv`] = enc(lines.join("\n"));
      textCols.forEach((j) => note(`${name}.csv`, j, f));
    }
  }
  if (notes.length > 1) files[folder + "columns.csv"] = enc(notes.join("\n"));
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
  await viewSource(new Uint8Array(bytes), name, target);
}

async function viewSource(source, name, target = $("#viewOut")) {
  try { await renderNwb(target, source, name); }
  catch (e) { target.innerHTML = `<div class="nv-err">Couldn't open ${esc(name)}: ${esc(e.message || e)}</div>`; }
  if (target.id === "viewOut") target.scrollIntoView({ behavior: "smooth" });
}

const IBL_EXAMPLE = "https://api.dandiarchive.org/api/assets/773516a9-bd20-4b46-adad-2a1d5772be5d/download/";

async function openLink(link) {
  const out = $("#viewOut");
  out.innerHTML = `<div class="nv-loading"><span class="spinner"></span>Looking up the file…</div>`;
  try {
    const r = await resolveLink(link);
    const p = new URLSearchParams(location.search);
    p.set("url", link);
    history.replaceState(null, "", `${location.pathname}?${p}#view`);
    await viewSource({ url: r.url, size: r.size }, r.name, out);
  } catch (e) {
    out.innerHTML = `<div class="nv-err">${esc(e.message || e)}</div>`;
  }
}

setupDrop($("#viewDrop"), $("#viewPick"), (files) => viewSource(files[0], files[0].name));
$("#viewUrlForm").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#viewUrl").value.trim(); if (v) openLink(v); });
$("#viewExample").addEventListener("click", async () => {
  const r = await fetch("template/example.nwb");
  viewSource(new Uint8Array(await r.arrayBuffer()), "sub-AAX-1_ses-day1.nwb");
});
$("#viewIbl").addEventListener("click", () => { $("#viewUrl").value = IBL_EXAMPLE; openLink(IBL_EXAMPLE); });
if (params.get("url")) { $("#viewUrl").value = params.get("url"); if ((location.hash || "") === "#view") openLink(params.get("url")); }

route();
