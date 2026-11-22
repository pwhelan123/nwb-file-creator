// NWB viewer: reads an NWB (HDF5) file in the browser with h5wasm and draws it with Plotly.
// Usage: import { renderNwb } from "./viewer.js"; await renderNwb(element, Uint8Array, "name.nwb");
import h5wasm from "./vendor/h5wasm/hdf5_hl.js";

const MAX_POINTS = 6000; // per trace, after decimation
const MAX_COLS = 6; // columns drawn from a 2-D series
let fileCounter = 0;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function attrs(obj) {
  const out = {};
  try {
    for (const [k, a] of Object.entries(obj.attrs || {})) {
      try { out[k] = a.value; } catch { out[k] = "(unreadable)"; }
    }
  } catch { /* no attrs */ }
  return out;
}

function get(f, path) {
  try { return f.get(path) || null; } catch { return null; }
}

function val(f, path) {
  const d = get(f, path);
  if (!d || d.type !== "Dataset") return null;
  try {
    const v = d.value;
    if (Array.isArray(v)) return v.map(String).join("; ");
    if (ArrayBuffer.isView(v)) return Array.from(v).join(", ");
    return v;
  } catch { return null; }
}

function keys(g) {
  try { return g && g.type === "Group" ? g.keys() : []; } catch { return []; }
}

// ---------------------------------------------------------------- reading the model

function readMeta(f) {
  const subject = {};
  for (const k of keys(get(f, "general/subject"))) subject[k] = val(f, `general/subject/${k}`);
  const devices = keys(get(f, "general/devices")).map((name) => {
    const a = attrs(get(f, `general/devices/${name}`));
    return { name, description: a.description, manufacturer: a.manufacturer };
  });
  const root = attrs(f);
  return {
    nwb_version: root.nwb_version,
    session_description: val(f, "session_description"),
    session_start_time: val(f, "session_start_time"),
    identifier: val(f, "identifier"),
    experimenter: val(f, "general/experimenter"),
    lab: val(f, "general/lab"),
    institution: val(f, "general/institution"),
    experiment_description: val(f, "general/experiment_description"),
    session_id: val(f, "general/session_id"),
    protocol: val(f, "general/protocol"),
    keywords: val(f, "general/keywords"),
    subject,
    devices,
  };
}

function findSeries(f) {
  const found = [];
  const walk = (path, depth) => {
    if (depth > 5) return;
    for (const k of keys(get(f, path))) {
      const p = path ? `${path}/${k}` : k;
      const g = get(f, p);
      if (!g || g.type !== "Group") continue;
      const ks = keys(g);
      if (ks.includes("data") && (ks.includes("timestamps") || ks.includes("starting_time"))) {
        found.push({ path: p, name: k, type: attrs(g).neurodata_type || "TimeSeries", group: g });
      } else {
        walk(p, depth + 1);
      }
    }
  };
  for (const top of ["acquisition", "processing", "stimulus/presentation", "analysis"]) walk(top, 0);
  return found;
}

function readSeries(f, s) {
  const d = get(f, `${s.path}/data`);
  const shape = d.shape || [];
  const n = shape[0] || 0;
  const ncols = shape.length > 1 ? shape.slice(1).reduce((a, b) => a * b, 1) : 1;
  if (shape.length > 2 || ncols > 64 || n === 0) return { ...s, n, ncols, skipped: true, shape };
  const step = Math.max(1, Math.ceil(n / MAX_POINTS));
  let raw;
  try {
    raw = step === 1 ? d.value : d.slice(shape.length > 1 ? [[0, n, step], []] : [[0, n, step]]);
  } catch {
    raw = d.value; // older files: fall back to reading all, then stride
  }
  const rows = Math.ceil(n / step);
  const da = attrs(d);
  const conv = Number(da.conversion ?? 1) || 1;
  const off = Number(da.offset ?? 0) || 0;
  const strideAll = raw.length >= n * ncols && step > 1; // fallback path read everything
  const cols = [];
  for (let c = 0; c < Math.min(ncols, MAX_COLS); c++) {
    const arr = new Float64Array(rows);
    for (let i = 0; i < rows; i++) {
      const src = strideAll ? i * step * ncols + c : i * ncols + c;
      arr[i] = Number(raw[src]) * conv + off;
    }
    cols.push(arr);
  }
  let t;
  const ts = get(f, `${s.path}/timestamps`);
  if (ts) {
    let tv;
    try { tv = step === 1 ? ts.value : ts.slice([[0, n, step]]); } catch { tv = ts.value; }
    const all = tv.length >= n && step > 1;
    t = new Float64Array(rows);
    for (let i = 0; i < rows; i++) t[i] = Number(tv[all ? i * step : i]);
  } else {
    const st = get(f, `${s.path}/starting_time`);
    const t0 = Number(st.value);
    const rate = Number(attrs(st).rate);
    t = new Float64Array(rows);
    for (let i = 0; i < rows; i++) t[i] = t0 + (i * step) / rate;
  }
  const desc = attrs(s.group).description || "";
  const m = /Columns: (.*)\.$/.exec(desc);
  const colNames = m ? m[1].split(", ") : cols.map((_, i) => (ncols > 1 ? `column ${i + 1}` : s.name));
  return { ...s, n, ncols, shape, step, t, cols, colNames, unit: da.unit || "", description: desc };
}

function readIntervals(f) {
  const out = [];
  for (const name of keys(get(f, "intervals"))) {
    const g = get(f, `intervals/${name}`);
    const ks = keys(g);
    if (!ks.includes("start_time") || !ks.includes("stop_time")) continue;
    const colnames = attrs(g).colnames;
    const names = (Array.isArray(colnames) ? colnames : ks).filter((c) => ks.includes(c));
    const columns = {};
    for (const c of names) {
      const d = get(f, `intervals/${name}/${c}`);
      try {
        // skip ragged / reference columns
        if (keys(g).includes(`${c}_index`)) continue;
        const v = d.value;
        columns[c] = Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v) : [v];
      } catch { /* skip unreadable column */ }
    }
    out.push({ name, columns, n: (columns.start_time || []).length });
  }
  return out;
}

function readTree(f) {
  const node = (path, name, depth) => {
    const obj = get(f, path);
    if (!obj) return null;
    const a = attrs(obj);
    if (obj.type === "Dataset") {
      let preview = "";
      try {
        const n = (obj.shape || []).reduce((x, y) => x * y, 1);
        if (n <= 6) {
          const v = obj.value;
          preview = Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v).join(", ") : String(v);
        }
      } catch { /* ignore */ }
      return { name, path, kind: "dataset", shape: obj.shape, dtype: obj.dtype, attrs: a, preview };
    }
    const children = depth > 8 ? [] : keys(obj).filter((k) => k !== "specifications" || depth > 0)
      .map((k) => node(path === "/" ? k : `${path}/${k}`, k, depth + 1)).filter(Boolean);
    return { name, path, kind: "group", type: a.neurodata_type, attrs: a, children };
  };
  return node("/", "/", 0);
}

// ---------------------------------------------------------------- formatting helpers

const SPECIES_COMMON = {
  "Mus musculus": "Mouse", "Rattus norvegicus": "Rat", "Homo sapiens": "Human",
  "Macaca mulatta": "Rhesus macaque", "Danio rerio": "Zebrafish", "Drosophila melanogaster": "Fruit fly",
  "Callithrix jacchus": "Marmoset",
};
const SEX = { M: "Male", F: "Female", U: "Unknown", O: "Other" };

function prettyAge(age) {
  if (!age) return null;
  const m = /^P(\d+)D$/.exec(age);
  return m ? `${m[1]} days (stored as ${age})` : age;
}

function prettyTime(iso) {
  if (!iso) return null;
  // Show the clock time as recorded (in the session's own time zone), not converted to the viewer's zone.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(iso);
  if (!m) return esc(iso);
  const [, y, mo, d, h, mi, , tz] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d)).toLocaleDateString(undefined, { dateStyle: "long", timeZone: "UTC" });
  const hr = +h % 12 || 12;
  const zone = !tz ? "no time zone!" : tz === "Z" ? "UTC" : `UTC${tz}`;
  return `${esc(date)}, ${hr}:${mi} ${+h < 12 ? "AM" : "PM"} <span class="nv-dim">(${zone}, stored in the file)</span>`;
}

function fmtDuration(s) {
  if (!isFinite(s)) return "–";
  if (s < 120) return `${s.toFixed(1)} s`;
  if (s < 7200) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;
}

const PALETTE = ["#2a6fdb", "#e8590c", "#2b9348", "#9c36b5", "#c92a2a", "#0b7285", "#5c940d", "#d6336c"];
const BAND = ["rgba(42,111,219,.13)", "rgba(232,89,12,.13)", "rgba(43,147,72,.13)", "rgba(156,54,181,.13)",
  "rgba(201,42,42,.13)", "rgba(11,114,133,.13)"];

// ---------------------------------------------------------------- rendering

function row(label, value) {
  if (value === null || value === undefined || value === "") return "";
  return `<div class="nv-row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
}

function card(icon, title, body) {
  return `<section class="nv-card"><h3><span class="nv-ico">${icon}</span>${esc(title)}</h3><dl>${body}</dl></section>`;
}

function renderTreeNode(n) {
  if (n.kind === "dataset") {
    const shape = n.shape && n.shape.length ? n.shape.join(" × ") : "scalar";
    const at = Object.entries(n.attrs).filter(([k]) => !["namespace", "object_id"].includes(k));
    return `<li class="nv-ds"><span class="nv-name">${esc(n.name)}</span>
      <span class="nv-meta">${esc(shape)}${n.dtype ? " · " + esc(n.dtype) : ""}</span>
      ${n.preview ? `<span class="nv-prev">= ${esc(String(n.preview).slice(0, 80))}</span>` : ""}
      ${at.length ? `<div class="nv-attrs">${at.map(([k, v]) => `<code>${esc(k)}</code>: ${esc(String(v).slice(0, 120))}`).join(" · ")}</div>` : ""}</li>`;
  }
  const open = n.path === "/" || ["acquisition", "general", "intervals", "processing"].includes(n.path);
  const at = Object.entries(n.attrs).filter(([k]) => !["namespace", "object_id", "neurodata_type", ".specloc"].includes(k));
  return `<li><details ${open ? "open" : ""}><summary><span class="nv-name">${esc(n.name === "/" ? "NWB file" : n.name)}</span>
    ${n.type ? `<span class="nv-badge">${esc(n.type)}</span>` : ""}
    ${n.children.length ? `<span class="nv-meta">${n.children.length} item${n.children.length === 1 ? "" : "s"}</span>` : ""}</summary>
    ${at.length ? `<div class="nv-attrs">${at.map(([k, v]) => `<code>${esc(k)}</code>: ${esc(String(v).slice(0, 160))}`).join(" · ")}</div>` : ""}
    <ul>${n.children.map(renderTreeNode).join("")}</ul></details></li>`;
}

function plotSeries(el, series, trials) {
  const Plotly = window.Plotly;
  const drawn = series.filter((s) => !s.skipped);
  if (!drawn.length || !Plotly) { el.innerHTML = `<p class="nv-dim">No time series to plot.</p>`; return; }
  const gap = 0.04;
  const h = (1 - gap * (drawn.length - 1)) / drawn.length;
  const traces = [];
  const layout = {
    height: Math.max(320, 190 * drawn.length + 40),
    margin: { l: 70, r: 20, t: 34, b: 45 },
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "system-ui, -apple-system, Segoe UI, sans-serif", color: css("--ink"), size: 12 },
    showlegend: true, legend: { orientation: "h", x: 0, xanchor: "left", y: 1.0, yanchor: "bottom" },
    hovermode: "x unified", shapes: [],
    xaxis: { title: { text: "Time (s)" }, gridcolor: css("--line"), zeroline: false, anchor: `y${drawn.length === 1 ? "" : drawn.length}` },
  };
  drawn.forEach((s, i) => {
    const ax = i === 0 ? "" : String(i + 1);
    const top = 1 - i * (h + gap);
    layout[`yaxis${ax}`] = {
      domain: [Math.max(0, top - h), top], gridcolor: css("--line"), zeroline: false,
      title: { text: `${s.name}<br><span style="font-size:10px">${s.unit}</span>`, font: { size: 11 } },
    };
    s.cols.forEach((c, j) => {
      traces.push({
        x: s.t, y: c, type: "scattergl", mode: "lines", xaxis: "x", yaxis: `y${ax}`,
        name: s.ncols > 1 ? `${s.name}: ${s.colNames[j] || j + 1}` : s.name,
        line: { width: 1.3, color: PALETTE[(i + j * 3) % PALETTE.length] },
        hovertemplate: `%{y:.4g} ${esc(s.unit)}<extra>${esc(s.name)}${s.ncols > 1 ? " " + esc(s.colNames[j] || "") : ""}</extra>`,
      });
    });
  });
  // the last axis anchors the shared x-axis at the bottom
  layout.xaxis.anchor = `y${drawn.length === 1 ? "" : drawn.length}`;
  drawn.forEach((_, i) => { if (i > 0) layout[`yaxis${i + 1}`].anchor = "x"; });
  if (trials) {
    const cat = Object.keys(trials.columns).find((c) => !["start_time", "stop_time", "id"].includes(c)
      && trials.columns[c].some((v) => typeof v === "string") && new Set(trials.columns[c]).size <= BAND.length);
    const levels = cat ? [...new Set(trials.columns[cat])] : [null];
    for (let i = 0; i < trials.n; i++) {
      const li = cat ? levels.indexOf(trials.columns[cat][i]) : 0;
      layout.shapes.push({
        type: "rect", xref: "x", yref: "paper", x0: trials.columns.start_time[i], x1: trials.columns.stop_time[i],
        y0: 0, y1: 1, fillcolor: BAND[li % BAND.length], line: { width: 0 }, layer: "below",
      });
    }
    el.dataset.bands = JSON.stringify({ cat, levels });
  }
  Plotly.newPlot(el, traces, layout, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["select2d", "lasso2d"] });
}

export async function renderNwb(el, bytes, filename = "file.nwb") {
  el.innerHTML = `<p class="nv-dim">Opening ${esc(filename)}…</p>`;
  const { FS } = await h5wasm.ready;
  const path = `/nwbview_${++fileCounter}.nwb`;
  FS.writeFile(path, bytes);
  let f;
  try {
    f = new h5wasm.File(path, "r");
  } catch (e) {
    el.innerHTML = `<div class="nv-err">This doesn't look like an NWB (HDF5) file. ${esc(e.message || e)}</div>`;
    return;
  }
  try {
    const meta = readMeta(f);
    const series = findSeries(f).map((s) => { try { return readSeries(f, s); } catch (e) { return { ...s, skipped: true, error: String(e) }; } });
    const intervals = readIntervals(f);
    const trials = intervals.find((i) => i.name === "trials") || intervals[0] || null;
    const tree = readTree(f);

    let tmin = Infinity, tmax = -Infinity, samples = 0;
    for (const s of series) {
      samples += s.n || 0;
      if (s.t && s.t.length) { tmin = Math.min(tmin, s.t[0]); tmax = Math.max(tmax, s.t[s.t.length - 1]); }
    }
    if (trials && trials.n) {
      tmin = Math.min(tmin, ...trials.columns.start_time); tmax = Math.max(tmax, ...trials.columns.stop_time);
    }
    const sub = meta.subject;
    const species = sub.species ? `${esc(SPECIES_COMMON[sub.species] || sub.species)} <span class="nv-dim"><i>${esc(sub.species)}</i></span>` : null;
    const devices = meta.devices.length
      ? meta.devices.map((d) => `<b>${esc(d.name)}</b>${d.manufacturer ? ` <span class="nv-dim">(${esc(d.manufacturer)})</span>` : ""}${d.description ? `<br><span class="nv-dim">${esc(d.description)}</span>` : ""}`).join("<br>")
      : null;

    el.innerHTML = `
      <div class="nv-hero">
        <div><div class="nv-file">${esc(filename)}</div>
          <div class="nv-sub">NWB ${esc(meta.nwb_version || "")} · ${fmtBytes(bytes.length)} · opened in your browser</div></div>
      </div>
      <div class="nv-stats">
        <div class="nv-stat"><b>${series.length}</b><span>time series</span></div>
        <div class="nv-stat"><b>${samples.toLocaleString()}</b><span>data points</span></div>
        <div class="nv-stat"><b>${fmtDuration(tmax - tmin)}</b><span>of recording</span></div>
        <div class="nv-stat"><b>${trials ? trials.n : 0}</b><span>trials</span></div>
      </div>
      <h2 class="nv-h">The file describes itself</h2>
      <p class="nv-dim nv-lead">Everything below was read from inside the file. Anyone who opens it, in any language, sees the same answers.</p>
      <div class="nv-cards">
        ${card("🐭", "Who", row("Subject", esc(sub.subject_id)) + row("Species", species) + row("Sex", esc(SEX[sub.sex] || sub.sex)) + row("Age", esc(prettyAge(sub.age))) + row("Strain", esc(sub.strain)) + row("Genotype", esc(sub.genotype)) + row("Weight", esc(sub.weight)))}
        ${card("🕑", "When", row("Started", prettyTime(meta.session_start_time)) + row("Session", esc(meta.session_id)) + row("Length", esc(fmtDuration(tmax - tmin))))}
        ${card("🔬", "What and how", row("Session", esc(meta.session_description)) + row("Experiment", esc(meta.experiment_description)) + row("Equipment", devices) + row("Protocol", esc(meta.protocol)))}
        ${card("👩‍🔬", "By whom", row("Experimenter", esc(meta.experimenter)) + row("Lab", esc(meta.lab)) + row("Institution", esc(meta.institution)) + row("Keywords", esc(meta.keywords)))}
      </div>
      <h2 class="nv-h">The data</h2>
      <p class="nv-dim nv-lead">Drag to zoom, double-click to reset. ${trials ? "Shaded bands are trials." : ""} Every series shares the same clock, so you can line up behavior across measurements.</p>
      <div class="nv-legend" data-role="bands"></div>
      <div class="nv-plot" data-role="plot"></div>
      ${series.filter((s) => s.skipped).map((s) => `<p class="nv-dim">Not plotted: ${esc(s.path)} (${esc((s.shape || []).join(" × "))}).</p>`).join("")}
      ${trials ? `<h2 class="nv-h">${esc(trials.name === "trials" ? "Trials" : trials.name)} <span class="nv-dim" style="font-weight:400">(${trials.n})</span></h2>
        <div class="nv-tablewrap"><table class="nv-table"><thead><tr>${Object.keys(trials.columns).map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
        <tbody>${Array.from({ length: Math.min(trials.n, 200) }, (_, i) => `<tr>${Object.keys(trials.columns).map((c) => {
          const v = trials.columns[c][i];
          return `<td>${esc(typeof v === "number" ? +v.toFixed(4) : v)}</td>`;
        }).join("")}</tr>`).join("")}</tbody></table></div>` : ""}
      <h2 class="nv-h">Inside the file</h2>
      <p class="nv-dim nv-lead">The structure every NWB file shares. Coloured tags are NWB data types; every dataset carries its own units and descriptions.</p>
      <ul class="nv-tree">${renderTreeNode(tree)}</ul>
      <h2 class="nv-h">Open it in Python</h2>
<pre class="nv-pre">from pynwb import NWBHDF5IO
with NWBHDF5IO("${esc(filename)}") as io:
    nwb = io.read()
    print(nwb.subject.species, nwb.session_start_time)
${series[0] ? `    series = nwb.${series[0].path.startsWith("acquisition/") ? `acquisition["${esc(series[0].name)}"]` : `objects  # see ${esc(series[0].path)}`}
    print(series.data[:10], series.unit)` : ""}${trials ? `
    print(nwb.trials.to_dataframe().head())` : ""}</pre>`;

    plotSeries(el.querySelector('[data-role="plot"]'), series, trials);
    const plotEl = el.querySelector('[data-role="plot"]');
    if (plotEl.dataset.bands) {
      const { cat, levels } = JSON.parse(plotEl.dataset.bands);
      el.querySelector('[data-role="bands"]').innerHTML = cat
        ? `<span class="nv-dim">Trials by <b>${esc(cat)}</b>:</span> ` + levels.map((l, i) => `<span class="nv-chip"><i style="background:${BAND[i % BAND.length].replace(".13", ".55")}"></i>${esc(l)}</span>`).join("")
        : `<span class="nv-chip"><i style="background:${BAND[0].replace(".13", ".55")}"></i>trial</span>`;
    }
  } finally {
    try { f.close(); } catch { /* ignore */ }
    try { FS.unlink(path); } catch { /* ignore */ }
  }
}

export const VIEWER_CSS = `
.nv-hero{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.nv-file{font-size:1.35rem;font-weight:700;word-break:break-all}
.nv-sub,.nv-dim{color:var(--muted)}
.nv-lead{margin:-4px 0 12px}
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
.nv-plot{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px;min-height:200px}
.nv-legend{margin:0 0 8px;font-size:.9rem}
.nv-chip{display:inline-flex;align-items:center;gap:6px;margin-right:12px}
.nv-chip i{width:14px;height:14px;border-radius:4px;display:inline-block}
.nv-tablewrap{overflow:auto;max-height:320px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.nv-table{border-collapse:collapse;width:100%;font-size:.88rem}
.nv-table th,.nv-table td{padding:6px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
.nv-table th{position:sticky;top:0;background:var(--card)}
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
@media (max-width:640px){.nv-stats{grid-template-columns:repeat(2,1fr)}.nv-cards{grid-template-columns:1fr}}
`;
