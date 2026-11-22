// NWB viewer UI. All file reading happens in h5worker.js; this module draws and navigates.
// renderNwb(el, source, name): source is a Uint8Array, a File, or {url, size}.

const VERSION = "2026-11-22d";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const PALETTE = ["#2a6fdb", "#e8590c", "#2b9348", "#9c36b5", "#c92a2a", "#0b7285", "#5c940d", "#d6336c"];
const BAND = ["rgba(42,111,219,.14)", "rgba(232,89,12,.14)", "rgba(43,147,72,.14)", "rgba(156,54,181,.14)", "rgba(201,42,42,.14)", "rgba(11,114,133,.14)"];
const MAX_SELECTED = 6;

// ------------------------------------------------------------------ worker plumbing
let worker = null, seq = 0, onProgress = null;
function resetWorker() {
  if (worker) worker.terminate();
  worker = null;
  for (const w of waiting.values()) w.reject(new Error("stopped"));
  waiting.clear();
}
const waiting = new Map();
function call(op, payload = {}) {
  if (!worker) {
    worker = new Worker(`h5worker.js?v=${VERSION}`);
    worker.onmessage = (e) => {
      if (e.data.progress) { onProgress?.(e.data.net); return; }
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      e.data.ok ? w.resolve(e.data.result) : w.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => { for (const w of waiting.values()) w.reject(new Error(e.message || "viewer worker failed")); waiting.clear(); };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage({ id, op, ...payload }); });
}

// ------------------------------------------------------------------ links: DANDI, Neurosift, plain URLs
export async function resolveLink(input) {
  let url = input.trim();
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("neurosift.app") && u.searchParams.get("url")) url = u.searchParams.get("url");
  } catch { throw new Error("That doesn't look like a web address."); }
  const m = /api\.dandiarchive\.org\/api\/(?:dandisets\/[^/]+\/versions\/[^/]+\/)?assets\/([0-9a-f-]{36})/i.exec(url);
  if (m) {
    const r = await fetch(`https://api.dandiarchive.org/api/assets/${m[1]}/`);
    if (!r.ok) throw new Error(`DANDI could not find that file (HTTP ${r.status}).`);
    const meta = await r.json();
    const s3 = (meta.contentUrl || []).find((x) => /s3[.-].*amazonaws\.com/.test(x)) || (meta.contentUrl || [])[0];
    if (!s3 || !meta.contentSize) throw new Error("DANDI didn't say where the file is stored.");
    const name = (meta.path || "").split("/").pop() || `${m[1]}.nwb`;
    return { url: s3, size: Number(meta.contentSize), name, dandi: meta };
  }
  const head = await fetch(url, { method: "HEAD" });
  const size = Number(head.headers.get("content-length"));
  if (!head.ok || !size) throw new Error("Couldn't get the file size from that server. Try a DANDI or Neurosift link.");
  return { url: head.url || url, size, name: decodeURIComponent(new URL(url).pathname.split("/").pop() || "remote.nwb") };
}

// ------------------------------------------------------------------ formatting
const SPECIES_COMMON = { "Mus musculus": "Mouse", "Rattus norvegicus": "Rat", "Homo sapiens": "Human", "Macaca mulatta": "Rhesus macaque",
  "Danio rerio": "Zebrafish", "Drosophila melanogaster": "Fruit fly", "Callithrix jacchus": "Marmoset" };
const SEX = { M: "Male", F: "Female", U: "Unknown", O: "Other" };
function prettyAge(age) { if (!age) return null; const m = /^P(\d+)D$/.exec(age); return m ? `${m[1]} days (stored as ${age})` : age; }
function prettyTime(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(iso);
  if (!m) return esc(iso);
  const [, y, mo, d, h, mi, , tz] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d)).toLocaleDateString(undefined, { dateStyle: "long", timeZone: "UTC" });
  const zone = !tz ? "no time zone!" : tz === "Z" ? "UTC" : `UTC${tz}`;
  return `${esc(date)}, ${+h % 12 || 12}:${mi} ${+h < 12 ? "AM" : "PM"} <span class="nv-dim">(${zone}, stored in the file)</span>`;
}
function fmtDur(s) {
  if (!isFinite(s)) return "–";
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
  if (s < 120) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  if (s < 7200) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(2)} h`;
}
function fmtT(t) { return Math.abs(t) >= 1000 ? t.toFixed(0) : Math.abs(t) >= 10 ? t.toFixed(1) : t.toFixed(2); }
function fmtBytes(b) { if (b < 1024) return `${b} B`; if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`; if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`; return `${(b / 1073741824).toFixed(2)} GB`; }
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || undefined;
const row = (label, value) => (value === null || value === undefined || value === "" ? "" : `<div class="nv-row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`);
const card = (icon, title, body) => `<section class="nv-card"><h3><span class="nv-ico">${icon}</span>${esc(title)}</h3><dl>${body || '<span class="nv-dim">Not recorded in this file.</span>'}</dl></section>`;

// ------------------------------------------------------------------ main entry
export async function renderNwb(el, source, filename = "file.nwb") {
  const src = source instanceof Uint8Array || ArrayBuffer.isView(source) ? { bytes: source } : source instanceof File ? { file: source } : source;
  const sizeBytes = src.bytes ? src.bytes.length : src.file ? src.file.size : src.size;
  el.innerHTML = `<div class="nv-loading"><span class="spinner"></span>Opening ${esc(filename)}${src.url ? ` (${fmtBytes(sizeBytes)}, reading only what's needed)` : ""}…</div>`;
  let info;
  try {
    resetWorker();
    const payload = src.bytes ? { bytes: src.bytes.slice().buffer } : src.file ? { file: src.file } : { url: src.url, size: src.size };
    info = await call("open", payload);
  } catch (e) {
    el.innerHTML = `<div class="nv-err">Couldn't open this as an NWB file: ${esc(e.message)}</div>`;
    return;
  }
  const v = new View(el, info, filename, sizeBytes, !!src.url);
  v.payload = src.bytes ? { bytes: src.bytes } : src.file ? { file: src.file } : { url: src.url, size: src.size };
  onProgress = (net) => v.showNet(net);
  v.render();
  return v;
}

class View {
  constructor(el, info, filename, size, isRemote) {
    Object.assign(this, { el, info, filename, size, isRemote });
    this.series = info.items.filter((i) => i.kind === "series" && i.plottable);
    this.tables = info.items.filter((i) => i.kind === "table");
    this.others = info.items.filter((i) => (i.kind === "series" && !i.plottable) || i.kind === "other");
    this.units = this.tables.find((t) => t.isUnits && t.colnames.includes("spike_times"));
    this.trialsInfo = this.tables.find((t) => t.name === "trials") || this.tables.find((t) => t.isIntervals);
    this.trials = null;
    this.selected = [];
    // prefer small, behaviour-like series first; skip huge multichannel arrays by default
    const pref = (s) => (/wheel|pupil|lick|speed|velocity|running|position/i.test(s.name) ? 0 : 1);
    const small = this.series.filter((s) => (s.shape[1] || 1) <= 8 && s.n <= 5e7).sort((a, b) => pref(a) - pref(b) || /smooth/i.test(a.name) - /smooth/i.test(b.name));
    this.selected = (small.length ? small : this.series).slice(0, 3).map((s) => s.path);
    if (this.units && this.selected.length < 3) this.selected.push("__raster__");
    const ts = this.series.flatMap((s) => [s.t0, s.t1]).filter(isFinite);
    this.T0 = ts.length ? Math.min(...ts) : 0;
    this.T1 = ts.length ? Math.max(...ts) : 1;
    if (this.T1 <= this.T0) this.T1 = this.T0 + 1;
    const span = this.T1 - this.T0;
    this.win = [this.T0, this.T0 + Math.min(span, isRemote ? 30 : span > 600 ? 60 : span)];
    this.trialIdx = -1;
    this.loadToken = 0;
  }

  render() {
    const { meta } = this.info;
    const sub = meta.subject || {};
    const species = sub.species ? `${esc(SPECIES_COMMON[sub.species] || sub.species)} <span class="nv-dim"><i>${esc(sub.species)}</i></span>` : null;
    const devices = (meta.devices || []).length ? meta.devices.map((d) => `<b>${esc(d.name)}</b>${d.manufacturer ? ` <span class="nv-dim">(${esc(d.manufacturer)})</span>` : ""}${d.description ? `<br><span class="nv-dim">${esc(d.description)}</span>` : ""}`).join("<br>") : null;
    const samples = this.series.reduce((a, s) => a + s.n * (s.shape[1] || 1), 0);
    this.el.innerHTML = `
      <div class="nv-hero"><div><div class="nv-file">${esc(this.filename)}</div>
        <div class="nv-sub">NWB ${esc(meta.nwb_version || "")} · ${fmtBytes(this.size)} · ${this.isRemote ? "streamed from the web, only the parts you look at" : "opened in your browser"}</div></div>
        <div class="nv-net nv-dim" data-r="net"></div></div>
      <div class="nv-stats">
        <div class="nv-stat"><b>${this.series.length}</b><span>time series</span></div>
        <div class="nv-stat"><b>${samples > 1e9 ? (samples / 1e9).toFixed(1) + " bn" : samples > 1e6 ? (samples / 1e6).toFixed(1) + " M" : samples.toLocaleString()}</b><span>data points</span></div>
        <div class="nv-stat"><b>${fmtDur(this.T1 - this.T0)}</b><span>of recording</span></div>
        <div class="nv-stat"><b>${this.tables.length}</b><span>table${this.tables.length === 1 ? "" : "s"}${this.trialsInfo ? ` · ${this.trialsInfo.n} ${esc(this.trialsInfo.name)}` : ""}</span></div>
      </div>
      <h2 class="nv-h">The file describes itself</h2>
      <p class="nv-dim nv-lead">Everything below was read from inside the file. Anyone who opens it, in any language, sees the same answers.</p>
      <div class="nv-cards">
        ${card("🐭", "Who", row("Subject", esc(sub.subject_id)) + row("Species", species) + row("Sex", esc(SEX[sub.sex] || sub.sex)) + row("Age", esc(prettyAge(sub.age))) + row("Strain", esc(sub.strain)) + row("Genotype", esc(sub.genotype)) + row("Weight", esc(sub.weight)))}
        ${card("🕑", "When", row("Started", prettyTime(meta.session_start_time)) + row("Session", esc(meta.session_id)) + row("Length", esc(fmtDur(this.T1 - this.T0))))}
        ${card("🔬", "What and how", row("Session", esc(meta.session_description)) + row("Experiment", esc(meta.experiment_description)) + row("Equipment", devices) + row("Protocol", esc(meta.protocol)))}
        ${card("👩‍🔬", "By whom", row("Experimenter", esc(meta.experimenter)) + row("Lab", esc(meta.lab)) + row("Institution", esc(meta.institution)) + row("Keywords", esc(meta.keywords)))}
      </div>

      <h2 class="nv-h">Explore the data</h2>
      <p class="nv-dim nv-lead">Tick anything in the list to plot it. Drag on the plot to zoom, use the buttons to move through time${this.trialsInfo ? ", or step through trials" : ""}.</p>
      <div class="ex">
        <aside class="ex-list">
          <div class="ex-head">What's in this file</div>
          ${this.series.length + this.tables.length > 10 ? `<input class="ex-search" type="search" placeholder="Filter…" data-r="filter">` : ""}
          <div data-r="list">${this.listHtml()}</div>
        </aside>
        <div class="ex-main">
          <div class="ex-bar">
            <button class="ex-btn" data-act="all" title="Show the whole recording">⤢ Whole recording</button>
            <span class="ex-grp"><button class="ex-btn" data-act="out" title="Zoom out">−</button><button class="ex-btn" data-act="in" title="Zoom in">+</button></span>
            <span class="ex-grp"><button class="ex-btn" data-act="prev" title="Earlier">◀</button><button class="ex-btn" data-act="next" title="Later">▶</button></span>
            ${this.trialsInfo ? `<span class="ex-grp ex-trial"><button class="ex-btn" data-act="tprev" title="Previous trial">‹</button><span data-r="tlabel">Trials</span><button class="ex-btn" data-act="tnext" title="Next trial">›</button></span>` : ""}
          </div>
          <div class="ex-time"><label>From <input type="number" step="any" data-r="from"></label><label>to <input type="number" step="any" data-r="to"></label> s
            <span class="nv-dim" data-r="span"></span></div>
          <div class="ex-timeline" data-r="timeline" title="Click to jump here"><div class="ex-ticks" data-r="ticks"></div><div class="ex-window" data-r="window"></div></div>
          <div class="nv-legend" data-r="bands"></div>
          <div class="nv-plot" data-r="plot"></div>
          <div class="ex-note nv-dim" data-r="note"></div>
        </div>
      </div>
      <div data-r="tableArea"></div>
      ${this.others.length ? `<p class="nv-dim" style="font-size:.88rem;margin-top:10px">Not shown here: ${this.others.map((o) => `${esc(o.path)}${o.shape ? ` (${o.shape.join(" × ")})` : ""}`).join(", ")}. Open them in <a href="https://neurosift.app" target="_blank" rel="noopener">Neurosift</a> or Python.</p>` : ""}

      <h2 class="nv-h">Inside the file</h2>
      <p class="nv-dim nv-lead">The structure every NWB file shares. Coloured tags are NWB data types. Click a folder to look inside.</p>
      <ul class="nv-tree" data-r="tree"><li><details open data-path="/"><summary><span class="nv-name">NWB file</span><span class="nv-badge">NWBFile</span></summary><ul></ul></details></li></ul>

      <h2 class="nv-h">Open it in Python</h2>
<pre class="nv-pre">from pynwb import NWBHDF5IO
with NWBHDF5IO("${esc(this.filename)}") as io:
    nwb = io.read()
    print(nwb.subject, nwb.session_start_time)${this.series[0] ? `
    series = nwb.objects  # or: nwb.acquisition / nwb.processing["..."]
    # "${esc(this.series[0].path)}"` : ""}${this.trialsInfo ? `
    print(nwb.${this.trialsInfo.name === "trials" ? "trials" : `intervals["${esc(this.trialsInfo.name)}"]`}.to_dataframe().head())` : ""}</pre>`;
    this.r = (n) => this.el.querySelector(`[data-r="${n}"]`);
    this.wire();
    this.loadTree(this.el.querySelector('[data-path="/"]'));
    this.init();
  }

  listHtml(filter = "") {
    const f = filter.toLowerCase();
    const match = (it) => !f || it.path.toLowerCase().includes(f) || (it.type || "").toLowerCase().includes(f);
    const sRows = this.series.filter(match).map((s) => {
      const cols = s.shape[1] || 1;
      return `<label class="ex-item" title="${esc(s.path)}${s.description ? "\n" + esc(s.description) : ""}">
        <input type="checkbox" data-series="${esc(s.path)}" ${this.selected.includes(s.path) ? "checked" : ""}>
        <span><b>${esc(s.name)}</b> <span class="nv-badge">${esc(s.type)}</span><br>
        <span class="nv-dim">${s.n.toLocaleString()}${cols > 1 ? ` × ${cols}` : ""} · ${esc(s.unit || "no unit")} · ${fmtDur(s.t1 - s.t0)}${s.path.split("/").length > 2 ? ` · ${esc(s.path.split("/").slice(0, -1).join("/"))}` : ""}</span></span></label>`;
    }).join("");
    const raster = this.units ? `<label class="ex-item"><input type="checkbox" data-series="__raster__" ${this.selected.includes("__raster__") ? "checked" : ""}>
        <span><b>Spike raster</b> <span class="nv-badge">Units</span><br><span class="nv-dim">${this.units.n.toLocaleString()} units, first 60 shown</span></span></label>` : "";
    const tRows = this.tables.filter(match).map((t) => `<button class="ex-item ex-table" data-table="${esc(t.path)}">
        <span>📋</span><span><b>${esc(t.name)}</b> <span class="nv-badge">${esc(t.type)}</span><br><span class="nv-dim">${t.n.toLocaleString()} rows · ${t.colnames.length} columns</span></span></button>`).join("");
    return `${sRows || raster ? `<div class="ex-sec">Time series <span class="nv-dim">(tick to plot)</span></div>${sRows}${raster}` : ""}
      ${tRows ? `<div class="ex-sec">Tables <span class="nv-dim">(click to view)</span></div>${tRows}` : ""}
      ${!sRows && !tRows ? `<p class="nv-dim">Nothing matches.</p>` : ""}`;
  }

  wire() {
    this.el.querySelector(".ex-bar").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const [a, z] = this.win, w = z - a, c = (a + z) / 2;
      const act = b.dataset.act;
      if (act === "all") this.setWin(this.T0, this.T1);
      if (act === "in") this.setWin(c - w / 4, c + w / 4);
      if (act === "out") this.setWin(c - w, c + w);
      if (act === "prev") this.setWin(a - w * 0.8, z - w * 0.8);
      if (act === "next") this.setWin(a + w * 0.8, z + w * 0.8);
      if (act === "tprev") this.gotoTrial(this.trialIdx - 1);
      if (act === "tnext") this.gotoTrial(this.trialIdx + 1);
    });
    const list = this.r("list");
    list.addEventListener("change", (e) => {
      const cb = e.target.closest("[data-series]");
      if (!cb) return;
      const p = cb.dataset.series;
      if (cb.checked) {
        if (this.selected.length >= MAX_SELECTED) { cb.checked = false; this.note(`Up to ${MAX_SELECTED} at once. Untick one first.`); return; }
        this.selected.push(p);
        this.lastAdded = p;
      } else this.selected = this.selected.filter((x) => x !== p);
      this.load();
    });
    list.addEventListener("click", (e) => {
      const b = e.target.closest("[data-table]");
      if (b) this.showTable(b.dataset.table);
    });
    this.r("filter")?.addEventListener("input", (e) => { list.innerHTML = this.listHtml(e.target.value); });
    const onTime = () => { const a = Number(this.r("from").value), z = Number(this.r("to").value); if (isFinite(a) && isFinite(z) && z > a) this.setWin(a, z); };
    this.r("from").addEventListener("change", onTime);
    this.r("to").addEventListener("change", onTime);
    this.r("timeline").addEventListener("click", (e) => {
      const rect = this.r("timeline").getBoundingClientRect();
      const t = this.T0 + ((e.clientX - rect.left) / rect.width) * (this.T1 - this.T0);
      const w = this.win[1] - this.win[0];
      this.setWin(t - w / 2, t + w / 2);
    });
    this.r("tree").addEventListener("toggle", (e) => { const d = e.target; if (d.open && d.dataset.path && !d.dataset.loaded) this.loadTree(d); }, true);
  }

  async init() {
    if (this.trialsInfo) {
      try {
        const t = await call("table", { path: this.trialsInfo.path, maxRows: 5000 });
        this.trials = t;
        this.updateTrialLabel();
        this.drawTicks();
      } catch { /* trials are optional */ }
    }
    this.load();
  }

  setWin(a, z) {
    const span = this.T1 - this.T0;
    let w = Math.min(z - a, span);
    if (w <= 0) return;
    a = Math.max(this.T0, Math.min(a, this.T1 - w));
    this.win = [a, a + w];
    this.load();
  }

  gotoTrial(i) {
    if (!this.trials) return;
    const n = this.trials.shown;
    if (!n) return;
    i = (i + n) % n;
    this.trialIdx = i;
    const s = Number(this.trials.columns.start_time[i]), e = Number(this.trials.columns.stop_time[i]);
    const pad = Math.max((e - s) * 0.5, 0.25);
    this.setWin(s - pad, e + pad);
    this.updateTrialLabel();
  }

  updateTrialLabel() {
    const l = this.r("tlabel");
    if (!l || !this.trials) return;
    const name = this.trialsInfo.name === "trials" ? "Trial" : this.trialsInfo.name;
    l.textContent = this.trialIdx >= 0 ? `${name} ${this.trialIdx + 1} of ${this.trials.n}` : `${this.trials.n} ${this.trialsInfo.name}`;
  }

  drawTicks() {
    if (!this.trials) return;
    const span = this.T1 - this.T0;
    const st = this.trials.columns.start_time || [];
    const step = Math.max(1, Math.ceil(st.length / 400));
    let html = "";
    for (let i = 0; i < st.length; i += step) html += `<i style="left:${((Number(st[i]) - this.T0) / span) * 100}%"></i>`;
    this.r("ticks").innerHTML = html;
  }

  note(text) { this.r("note").innerHTML = text; }

  updateChrome() {
    const [a, z] = this.win, span = this.T1 - this.T0;
    this.r("from").value = fmtT(a);
    this.r("to").value = fmtT(z);
    this.r("span").textContent = `showing ${fmtDur(z - a)} of ${fmtDur(span)}`;
    const w = this.r("window");
    w.style.left = `${((a - this.T0) / span) * 100}%`;
    w.style.width = `${Math.max(0.6, ((z - a) / span) * 100)}%`;
  }

  async load() {
    this.updateChrome();
    const token = ++this.loadToken;
    const plotEl = this.r("plot");
    const [a, z] = this.win;
    const paths = this.selected.filter((p) => p === "__raster__" || this.series.some((s) => s.path === p));
    if (!paths.length) { window.Plotly?.purge(plotEl); plotEl.innerHTML = `<p class="nv-dim" style="padding:16px">Tick something in the list to plot it.</p>`; this.note(""); return; }
    plotEl.classList.add("busy");
    this.note(`<span class="spinner"></span>Loading ${fmtDur(z - a)} of data… <button class="ex-btn" data-stop type="button">Stop</button>`);
    this.r("note").querySelector("[data-stop]").onclick = () => this.stop();
    const maxPoints = Math.max(600, Math.min(3000, Math.round(plotEl.clientWidth * 2)));
    const results = [];
    let sampled = false;
    try {
      for (const p of paths) {
        if (p === "__raster__") {
          const r = await call("spikes", { path: this.units.path, t0: a, t1: z });
          results.push({ raster: true, ...r });
          if (r.net) this.showNet(r.net);
          continue;
        }
        const s = this.series.find((x) => x.path === p);
        const ncols = s.shape[1] || 1;
        const cols = Array.from({ length: Math.min(ncols, ncols > 8 ? 4 : 8) }, (_, i) => i);
        const r = await call("window", { path: p, t0: a, t1: z, maxPoints, cols });
        if (r.net) this.showNet(r.net);
        sampled = sampled || r.sampled;
        results.push({ s, r, cols, ncols });
        if (token !== this.loadToken) return; // the window moved while we were loading
      }
    } catch (e) {
      if (e.message === "stopped" || token !== this.loadToken) return;
      plotEl.classList.remove("busy");
      this.note(`<span style="color:var(--bad)">Couldn't read the data: ${esc(e.message)}</span>`);
      return;
    }
    if (token !== this.loadToken) return;
    plotEl.classList.remove("busy");
    this.goodWin = [...this.win];
    this.lastAdded = null;
    this.draw(results);
    const exact = results.every((x) => x.raster || x.r.exact);
    this.note(sampled ? "Zoomed out a long way: showing the highs and lows of short samples spread across this window. Zoom in to see every sample."
      : exact ? "Showing every sample in this window." : "Showing the highs and lows of every sample in this window (zoom in for individual samples).");
  }

  // Abandon a slow load: restart the reader, drop the item added last, and go back to the last window that worked.
  async stop() {
    this.loadToken++;
    resetWorker();
    this.note(`<span class="spinner"></span>Stopping…`);
    const payload = this.payload.bytes ? { bytes: this.payload.bytes.slice().buffer } : this.payload;
    try { await call("open", payload); } catch (e) { this.note(`<span style="color:var(--bad)">${esc(e.message)}</span>`); return; }
    if (this.lastAdded && this.selected.includes(this.lastAdded)) {
      this.selected = this.selected.filter((p) => p !== this.lastAdded);
      const cb = this.el.querySelector(`[data-series="${CSS.escape(this.lastAdded)}"]`);
      if (cb) cb.checked = false;
    }
    this.lastAdded = null;
    if (this.goodWin) this.win = [...this.goodWin];
    this.r("plot").classList.remove("busy");
    await this.load();
    this.note(this.r("note").innerHTML + " (stopped the slow request)");
  }

  showNet(net) {
    const el = this.r("net");
    if (el && net) el.textContent = `downloaded ${fmtBytes(net.bytes)} of ${fmtBytes(this.size)} (${(100 * net.bytes / this.size).toFixed(net.bytes / this.size < 0.01 ? 2 : 1)}%)`;
  }

  draw(results) {
    const Plotly = window.Plotly;
    const plotEl = this.r("plot");
    const n = results.length, gap = 0.05, h = (1 - gap * (n - 1)) / n;
    const traces = [];
    const layout = {
      height: Math.max(300, 170 * n + 60), margin: { l: 72, r: 16, t: 30, b: 42 },
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "system-ui, -apple-system, Segoe UI, sans-serif", color: css("--ink"), size: 12 },
      showlegend: true, legend: { orientation: "h", x: 0, xanchor: "left", y: 1, yanchor: "bottom" },
      hovermode: "x unified", shapes: [], dragmode: "zoom",
      xaxis: { range: [...this.win], title: { text: "Time (s)" }, gridcolor: css("--line"), zeroline: false, anchor: n === 1 ? "y" : `y${n}` },
    };
    results.forEach((res, i) => {
      const ax = i === 0 ? "" : String(i + 1);
      const top = 1 - i * (h + gap);
      const yaxis = { domain: [Math.max(0, top - h), top], gridcolor: css("--line"), zeroline: false, anchor: "x", fixedrange: false };
      if (res.raster) {
        yaxis.title = { text: "unit", font: { size: 11 } };
        yaxis.autorange = "reversed";
        layout[`yaxis${ax}`] = yaxis;
        traces.push({ x: res.x, y: res.y, type: "scattergl", mode: "markers", xaxis: "x", yaxis: `y${ax}`, name: "spikes",
          marker: { size: 3, color: css("--ink"), symbol: "line-ns-open" }, hovertemplate: "unit %{y} at %{x:.3f} s<extra></extra>" });
        return;
      }
      const { s, r, cols, ncols } = res;
      yaxis.title = { text: `${esc(s.name)}<br><span style="font-size:10px">${esc(s.unit)}</span>`, font: { size: 11 } };
      layout[`yaxis${ax}`] = yaxis;
      r.cols.forEach((c, j) => {
        const cname = s.colNames?.[cols[j]] || (ncols > 1 ? `ch ${cols[j]}` : "");
        traces.push({ x: r.t, y: c, type: "scattergl", mode: "lines", xaxis: "x", yaxis: `y${ax}`,
          name: ncols > 1 ? `${s.name}: ${cname}` : s.name, line: { width: 1.2, color: PALETTE[(i + j * 3) % PALETTE.length] },
          hovertemplate: `%{y:.4g} ${esc(s.unit)}<extra>${esc(s.name)}${cname ? " " + esc(cname) : ""}</extra>` });
      });
      if (ncols > cols.length) traces[traces.length - 1].name += ` (+${ncols - cols.length} more channels not drawn)`;
    });
    // trial bands inside the window
    const legend = this.r("bands");
    if (this.trials) {
      const cols = this.trials.columns;
      const cat = Object.keys(cols).find((c) => !["start_time", "stop_time", "id"].includes(c) && cols[c].some((v) => typeof v === "string") && new Set(cols[c]).size <= BAND.length);
      const levels = cat ? [...new Set(cols[cat])] : [null];
      const [a, z] = this.win;
      let shown = 0;
      for (let i = 0; i < this.trials.shown && shown < 500; i++) {
        const s = Number(cols.start_time[i]), e = Number(cols.stop_time[i]);
        if (e < a || s > z) continue;
        shown++;
        const li = cat ? levels.indexOf(cols[cat][i]) : 0;
        layout.shapes.push({ type: "rect", xref: "x", yref: "paper", x0: s, x1: e, y0: 0, y1: 1, layer: "below", line: { width: i === this.trialIdx ? 2 : 0, color: PALETTE[0] },
          fillcolor: BAND[li % BAND.length] });
      }
      const nm = this.trialsInfo.name;
      legend.innerHTML = cat
        ? `<span class="nv-dim">Shaded: ${esc(nm)} by <b>${esc(cat)}</b>:</span> ${levels.map((l, i) => `<span class="nv-chip"><i style="background:${BAND[i % BAND.length].replace(".14", ".6")}"></i>${esc(l)}</span>`).join("")}`
        : `<span class="nv-chip"><i style="background:${BAND[0].replace(".14", ".6")}"></i>${esc(nm)}</span>`;
    }
    Plotly.react(plotEl, traces, layout, { responsive: true, displaylogo: false, scrollZoom: false, modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d"] });
    if (!plotEl._nvWired) {
      plotEl._nvWired = true;
      plotEl.on("plotly_relayout", (ev) => {
        const a = ev["xaxis.range[0]"], z = ev["xaxis.range[1]"];
        if (a !== undefined && z !== undefined) { clearTimeout(this._t); this._t = setTimeout(() => this.setWin(Number(a), Number(z)), 150); }
        else if (ev["xaxis.autorange"]) this.setWin(this.T0, this.T1);
      });
    }
  }

  async showTable(path) {
    const area = this.r("tableArea");
    area.innerHTML = `<div class="nv-loading"><span class="spinner"></span>Loading table…</div>`;
    try {
      const t = path === this.trialsInfo?.path && this.trials ? this.trials : await call("table", { path, maxRows: 2000 });
      const cols = Object.keys(t.columns);
      const clickable = t.isIntervals;
      area.innerHTML = `<h3 class="nv-h" style="margin-top:20px">${esc(t.name)} <span class="nv-dim" style="font-weight:400">${t.n.toLocaleString()} rows${t.shown < t.n ? `, first ${t.shown} shown` : ""}${clickable ? " · click a row to jump to it" : ""}</span>
        <button class="ex-btn" data-close style="float:right">Close</button></h3>
        ${t.description ? `<p class="nv-dim" style="margin:-4px 0 8px">${esc(t.description)}</p>` : ""}
        <div class="nv-tablewrap"><table class="nv-table"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>
        ${Array.from({ length: t.shown }, (_, i) => `<tr ${clickable ? `data-row="${i}" class="clickable"` : ""}>${cols.map((c) => { const v = t.columns[c][i]; return `<td>${esc(typeof v === "number" ? +v.toFixed(4) : v)}</td>`; }).join("")}</tr>`).join("")}
        </tbody></table></div>`;
      area.querySelector("[data-close]").onclick = () => { area.innerHTML = ""; };
      if (clickable) area.querySelector("tbody").addEventListener("click", (e) => {
        const tr = e.target.closest("[data-row]");
        if (!tr) return;
        const i = Number(tr.dataset.row);
        if (path === this.trialsInfo?.path) { this.gotoTrial(i); }
        else { const s = Number(t.columns.start_time[i]), e2 = Number(t.columns.stop_time[i]); const pad = Math.max((e2 - s) * 0.5, 0.25); this.setWin(s - pad, e2 + pad); }
        this.r("plot").scrollIntoView({ behavior: "smooth", block: "center" });
      });
      area.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      area.innerHTML = `<div class="nv-err">Couldn't read that table: ${esc(e.message)}</div>`;
    }
  }

  async loadTree(details) {
    details.dataset.loaded = "1";
    const ul = details.querySelector(":scope > ul");
    ul.innerHTML = `<li class="nv-dim">loading…</li>`;
    try {
      const { children, net } = await call("children", { path: details.dataset.path });
      if (net) this.showNet(net);
      ul.innerHTML = children.map((c) => {
        const at = Object.entries(c.attrs || {}).filter(([k]) => k !== ".specloc");
        const atHtml = at.length ? `<div class="nv-attrs">${at.map(([k, v]) => `<code>${esc(k)}</code>: ${esc(String(v).slice(0, 160))}`).join(" · ")}</div>` : "";
        if (c.kind === "dataset") {
          return `<li class="nv-ds"><span class="nv-name">${esc(c.name)}</span><span class="nv-meta">${c.shape && c.shape.length ? esc(c.shape.join(" × ")) : "scalar"}${c.dtype ? " · " + esc(c.dtype) : ""}</span>
            ${c.preview ? `<span class="nv-prev">= ${esc(String(c.preview).slice(0, 80))}</span>` : ""}${atHtml}</li>`;
        }
        if (c.kind !== "group") return `<li class="nv-dim">${esc(c.name)}</li>`;
        return `<li><details data-path="${esc(c.path)}"><summary><span class="nv-name">${esc(c.name)}</span>${c.type ? `<span class="nv-badge">${esc(c.type)}</span>` : ""}
          <span class="nv-meta">${c.count} item${c.count === 1 ? "" : "s"}</span></summary>${atHtml}<ul></ul></details></li>`;
      }).join("") || `<li class="nv-dim">empty</li>`;
      // open the most interesting folders at the top level
      if (details.dataset.path === "/") for (const p of ["acquisition", "processing", "intervals"]) {
        const d = ul.querySelector(`[data-path="${p}"]`);
        if (d) d.open = true;
      }
    } catch (e) {
      ul.innerHTML = `<li class="nv-err">${esc(e.message)}</li>`;
    }
  }
}

export const VIEWER_CSS = `
.nv-hero{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.nv-file{font-size:1.35rem;font-weight:700;word-break:break-all}
.nv-sub,.nv-dim{color:var(--muted)}
.nv-net{font-size:.85rem}
.nv-lead{margin:-4px 0 12px}
.nv-loading{padding:18px;color:var(--muted)}
.nv-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:8px 0 22px}
.nv-stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 12px;text-align:center}
.nv-stat b{display:block;font-size:1.5rem;letter-spacing:-.02em}
.nv-stat span{color:var(--muted);font-size:.85rem}
.nv-h{font-size:1.15rem;margin:26px 0 8px}
.nv-cards{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.nv-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.nv-card h3{margin:0 0 8px;font-size:1rem;display:flex;align-items:center;gap:8px}
.nv-ico{font-size:1.2rem}
.nv-card dl{margin:0}
.nv-row{display:grid;grid-template-columns:96px 1fr;gap:8px;padding:4px 0;border-top:1px solid var(--line);font-size:.92rem}
.nv-row:first-child{border-top:0}
.nv-row dt{color:var(--muted)}
.nv-row dd{margin:0;overflow-wrap:anywhere}
.ex{display:grid;grid-template-columns:270px 1fr;gap:14px;align-items:start}
.ex-list{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px;max-height:640px;overflow:auto;position:sticky;top:64px}
.ex-head{font-weight:700;padding:4px 6px 8px}
.ex-search{width:100%;margin:0 0 8px;padding:8px 10px!important;font-size:.9rem!important;border-radius:10px!important}
.ex-sec{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:10px 6px 4px}
.ex-item{display:flex;gap:8px;align-items:flex-start;padding:7px 6px;border-radius:10px;cursor:pointer;font-size:.88rem;line-height:1.35;width:100%;text-align:left;background:none;border:0;color:inherit;font-family:inherit}
.ex-item:hover{background:var(--bg)}
.ex-item input{margin-top:3px;accent-color:var(--accent)}
.ex-item .nv-badge{font-size:.68rem}
.ex-main{min-width:0}
.ex-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
.ex-grp{display:inline-flex;align-items:center;gap:2px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:2px}
.ex-grp .ex-btn{border:0}
.ex-btn{font:inherit;font-size:.9rem;padding:6px 12px;border-radius:9px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
.ex-btn:hover{color:var(--accent)}
.ex-trial span{font-size:.88rem;padding:0 6px;min-width:96px;text-align:center}
.ex-time{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:.9rem;margin-bottom:8px}
.ex-time input{width:110px;padding:6px 8px!important;border-radius:8px!important;font-size:.9rem!important}
.ex-timeline{position:relative;height:22px;border-radius:8px;background:var(--code);cursor:pointer;margin-bottom:10px;overflow:hidden}
.ex-window{position:absolute;top:0;bottom:0;background:color-mix(in srgb,var(--accent) 35%,transparent);border:1.5px solid var(--accent);border-radius:6px;min-width:4px}
.ex-ticks i{position:absolute;top:5px;bottom:5px;width:1px;background:var(--muted);opacity:.5}
.ex-note{font-size:.85rem;margin-top:6px;min-height:1.3em}
.nv-plot{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px;min-height:200px;transition:opacity .15s}
.nv-plot.busy{opacity:.55}
.nv-legend{margin:0 0 8px;font-size:.9rem;min-height:1em}
.nv-chip{display:inline-flex;align-items:center;gap:6px;margin-right:12px}
.nv-chip i{width:14px;height:14px;border-radius:4px;display:inline-block}
.nv-tablewrap{overflow:auto;max-height:360px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.nv-table{border-collapse:collapse;width:100%;font-size:.88rem}
.nv-table th,.nv-table td{padding:6px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
.nv-table th{position:sticky;top:0;background:var(--card)}
.nv-table tr.clickable{cursor:pointer}
.nv-table tr.clickable:hover td{background:color-mix(in srgb,var(--accent) 8%,transparent)}
.nv-tree,.nv-tree ul{list-style:none;padding-left:18px;margin:0}
.nv-tree{padding:10px 14px;background:var(--card);border:1px solid var(--line);border-radius:14px;font-size:.9rem}
.nv-tree summary{cursor:pointer;padding:3px 0}
.nv-tree li{padding:1px 0}
.nv-name{font-weight:600}
.nv-ds .nv-name{font-weight:500;font-family:ui-monospace,Menlo,monospace;font-size:.85rem}
.nv-badge{background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);border-radius:6px;padding:1px 7px;font-size:.75rem;font-weight:700;margin-left:6px}
.nv-meta{color:var(--muted);font-size:.8rem;margin-left:8px}
.nv-prev{color:var(--muted);font-size:.8rem;margin-left:6px;font-family:ui-monospace,Menlo,monospace}
.nv-attrs{color:var(--muted);font-size:.78rem;margin:2px 0 4px 2px;overflow-wrap:anywhere}
.nv-pre{background:var(--code);border-radius:12px;padding:14px;overflow-x:auto;font:.85rem/1.5 ui-monospace,Menlo,monospace}
.nv-err{background:var(--bad-bg);color:var(--bad);padding:12px 14px;border-radius:12px}
@media (max-width:820px){.ex{grid-template-columns:1fr}.ex-list{position:static;max-height:300px}}
@media (max-width:640px){.nv-stats{grid-template-columns:repeat(2,1fr)}.nv-cards{grid-template-columns:1fr}}
`;
