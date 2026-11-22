// Reads NWB (HDF5) files off the main thread with h5wasm.
// Local files are mounted with WORKERFS and remote files are read lazily with HTTP range requests,
// so a multi-gigabyte file on DANDI opens by fetching only the bytes that are actually needed.
self.importScripts("vendor/h5wasm/h5wasm.iife.js");

const CHUNK = 512 * 1024; // bytes per range request
const MAX_CACHE_CHUNKS = 400; // ~200 MB of cached chunks, least recently used dropped first
let FS = null;
let file = null;
let mounted = false;
let remote = null; // {url, size, requests, bytes}
let fileNo = 0;
let lastProgress = 0;

const post = (id, ok, data) => self.postMessage({ id, ok, ...data });

// ------------------------------------------------------------------ remote lazy file

function makeRemote(url, size) {
  const cache = new Map();
  const stats = { requests: 0, bytes: 0 };
  function chunk(n) {
    let c = cache.get(n);
    if (c) { cache.delete(n); cache.set(n, c); return c; }
    const from = n * CHUNK;
    const to = Math.min(size, from + CHUNK) - 1;
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    xhr.setRequestHeader("Range", `bytes=${from}-${to}`);
    xhr.responseType = "arraybuffer";
    xhr.send(null);
    if (xhr.status !== 206 && !(xhr.status === 200 && from === 0 && to === size - 1)) {
      throw new Error(`The server did not return a byte range (HTTP ${xhr.status}). It may not allow streaming.`);
    }
    c = new Uint8Array(xhr.response);
    stats.requests++; stats.bytes += c.length;
    const now = Date.now();
    if (now - lastProgress > 400) { lastProgress = now; self.postMessage({ progress: true, net: { ...stats } }); }
    cache.set(n, c);
    if (cache.size > MAX_CACHE_CHUNKS) cache.delete(cache.keys().next().value);
    return c;
  }
  const contents = {
    length: size,
    get(i) { return chunk(Math.floor(i / CHUNK))[i % CHUNK]; },
    copy(buffer, offset, length, position) {
      let done = 0;
      while (done < length) {
        const pos = position + done;
        const c = chunk(Math.floor(pos / CHUNK));
        const start = pos % CHUNK;
        const take = Math.min(length - done, c.length - start);
        buffer.set(c.subarray(start, start + take), offset + done);
        done += take;
      }
      return done;
    },
  };
  return { contents, stats };
}

function createRemoteFile(path, url, size) {
  const { contents, stats } = makeRemote(url, size);
  const parts = path.split("/");
  const name = parts.pop();
  const node = FS.createFile(parts.join("/") || "/", name, {}, true, false);
  node.contents = contents;
  Object.defineProperty(node, "usedBytes", { get: () => size });
  const ops = { ...node.stream_ops };
  ops.read = (stream, buffer, offset, length, position) => {
    if (position >= size) return 0;
    return contents.copy(buffer, offset, Math.min(size - position, length), position);
  };
  node.stream_ops = ops;
  return stats;
}

// ------------------------------------------------------------------ helpers

function attrs(obj) {
  const out = {};
  try {
    for (const [k, a] of Object.entries(obj.attrs || {})) {
      try {
        let v = a.value;
        if (ArrayBuffer.isView(v)) v = Array.from(v, (x) => (typeof x === "bigint" ? Number(x) : x));
        if (typeof v === "bigint") v = Number(v);
        out[k] = v;
      } catch { out[k] = "(unreadable)"; }
    }
  } catch { /* none */ }
  return out;
}
const get = (p) => { try { return file.get(p) || null; } catch { return null; } };
const keys = (g) => { try { return g && g.type === "Group" ? g.keys() : []; } catch { return []; } };
function plain(v) {
  if (typeof v === "bigint") return Number(v);
  if (ArrayBuffer.isView(v)) return Array.from(v, (x) => (typeof x === "bigint" ? Number(x) : x));
  if (Array.isArray(v)) return v.map(plain);
  return v;
}
function val(p) {
  const d = get(p);
  if (!d || d.type !== "Dataset") return null;
  try {
    const n = (d.shape || []).reduce((a, b) => a * b, 1);
    if (n > 1000) return `(${d.shape.join(" × ")} values)`;
    const v = plain(d.value);
    return Array.isArray(v) ? v.join("; ") : v;
  } catch { return null; }
}
function sliceVals(d, ranges) {
  return plain(d.slice(ranges));
}

// Element access to big 1-D datasets (timestamps, spike times) in cached blocks, so binary searches
// decompress and download each block once instead of once per probe.
const BLOCK = 65536;
const blockCache = new Map(); // `${path}#${n}` -> Float64Array
function element(path, i) {
  const n = Math.floor(i / BLOCK);
  const key = `${path}#${n}`;
  let b = blockCache.get(key);
  if (!b) {
    const d = get(path);
    const len = d.shape[0];
    b = Float64Array.from(sliceVals(d, [[n * BLOCK, Math.min(len, (n + 1) * BLOCK)]]), Number);
    blockCache.set(key, b);
    if (blockCache.size > 300) blockCache.delete(blockCache.keys().next().value);
  } else { blockCache.delete(key); blockCache.set(key, b); }
  return b[i - n * BLOCK];
}

// ------------------------------------------------------------------ model

function meta() {
  const subject = {};
  for (const k of keys(get("general/subject"))) subject[k] = val(`general/subject/${k}`);
  const devices = keys(get("general/devices")).map((name) => {
    const a = attrs(get(`general/devices/${name}`));
    return { name, description: a.description, manufacturer: a.manufacturer };
  });
  return {
    nwb_version: attrs(file).nwb_version,
    session_description: val("session_description"),
    session_start_time: val("session_start_time"),
    experimenter: val("general/experimenter"),
    lab: val("general/lab"),
    institution: val("general/institution"),
    experiment_description: val("general/experiment_description"),
    session_id: val("general/session_id"),
    protocol: val("general/protocol"),
    keywords: val("general/keywords"),
    subject,
    devices,
  };
}

function seriesInfo(path, g) {
  const d = get(`${path}/data`);
  const a = attrs(g);
  const da = attrs(d);
  const shape = d.shape || [];
  const n = shape[0] || 0;
  const info = {
    kind: "series", path, name: path.split("/").pop(), type: a.neurodata_type || "TimeSeries",
    description: a.description || "", unit: da.unit || "", conversion: Number(da.conversion ?? 1) || 1,
    offset: Number(da.offset ?? 0) || 0, shape, dtype: String(d.dtype || ""), n,
  };
  const ts = get(`${path}/timestamps`);
  if (ts) {
    info.timestamps = true;
    try {
      info.t0 = n ? Number(sliceVals(ts, [[0, 1]])[0]) : 0;
      info.t1 = n ? Number(sliceVals(ts, [[n - 1, n]])[0]) : 0;
    } catch { info.t0 = 0; info.t1 = 0; }
  } else {
    const st = get(`${path}/starting_time`);
    info.start = st ? Number(plain(st.value)) : 0;
    info.rate = st ? Number(attrs(st).rate) : 1;
    info.t0 = info.start;
    info.t1 = info.start + (n - 1) / info.rate;
  }
  const m = /Columns: (.*)\.$/.exec(info.description);
  info.colNames = m ? m[1].split(", ") : null;
  info.plottable = shape.length >= 1 && shape.length <= 2 && n > 0 && /^[<>|=!]?[dfeiIhHbBqQlL?]/.test(info.dtype);
  return info;
}

function tableInfo(path, g) {
  const ks = keys(g);
  const a = attrs(g);
  const colnames = Array.isArray(a.colnames) ? a.colnames : ks.filter((k) => k !== "id" && !k.endsWith("_index"));
  let n = 0;
  try { n = get(`${path}/id`).shape[0]; } catch { /* ignore */ }
  const isIntervals = ks.includes("start_time") && ks.includes("stop_time");
  return { kind: "table", path, name: path.split("/").pop(), type: a.neurodata_type || "Table",
    description: a.description || "", n, colnames, isIntervals, isUnits: a.neurodata_type === "Units" };
}

function inventory() {
  const items = [];
  const seen = new Set();
  const walk = (path, depth) => {
    if (depth > 6) return;
    for (const k of keys(get(path))) {
      const p = path ? `${path}/${k}` : k;
      if (seen.has(p)) continue;
      seen.add(p);
      const g = get(p);
      if (!g || g.type !== "Group") continue;
      const ks = keys(g);
      const t = attrs(g).neurodata_type;
      try {
        if (ks.includes("data") && (ks.includes("timestamps") || ks.includes("starting_time"))) items.push(seriesInfo(p, g));
        else if (ks.includes("id") && (attrs(g).colnames !== undefined || t === "Units" || t === "TimeIntervals")) items.push(tableInfo(p, g));
        else walk(p, depth + 1);
      } catch (e) {
        items.push({ kind: "other", path: p, name: k, type: t || "", error: String(e) });
      }
    }
  };
  for (const top of ["acquisition", "processing", "stimulus/presentation", "stimulus/templates", "intervals", "units", "analysis"]) {
    const g = get(top);
    if (!g) continue;
    if (top === "units") { try { items.push(tableInfo("units", g)); } catch { /* ignore */ } continue; }
    walk(top, 0);
  }
  return items;
}

function children(path) {
  const g = get(path);
  return keys(g).map((k) => {
    const p = path === "/" ? k : `${path}/${k}`;
    const o = get(p);
    if (!o) return { name: k, path: p, kind: "unknown" };
    const a = attrs(o);
    delete a.namespace; delete a.object_id;
    if (o.type === "Dataset") {
      let preview = "";
      try {
        const n = (o.shape || []).reduce((x, y) => x * y, 1);
        if (n <= 6) { const v = plain(o.value); preview = Array.isArray(v) ? v.join(", ") : String(v); }
      } catch { /* ignore */ }
      return { name: k, path: p, kind: "dataset", shape: o.shape, dtype: String(o.dtype || ""), attrs: a, preview };
    }
    const t = a.neurodata_type; delete a.neurodata_type; delete a[".specloc"];
    return { name: k, path: p, kind: "group", type: t, attrs: a, count: keys(o).length };
  });
}

// ------------------------------------------------------------------ reading data windows

function indexAtTime(s, t) {
  if (!s.timestamps) return Math.min(s.n, Math.max(0, Math.round((t - s.start) * s.rate)));
  const tp = `${s.path}/timestamps`;
  let lo = 0, hi = s.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const v = element(tp, mid);
    if (v < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function readRows(s, i0, i1, cols) {
  const d = get(`${s.path}/data`);
  const twoD = s.shape.length > 1;
  const ncolsAll = twoD ? s.shape[1] : 1;
  const c0 = cols[0], c1 = cols[cols.length - 1] + 1;
  const raw = sliceVals(d, twoD ? [[i0, i1], [c0, c1]] : [[i0, i1]]);
  const width = twoD ? c1 - c0 : 1;
  const out = cols.map(() => new Float64Array(i1 - i0));
  for (let i = 0; i < i1 - i0; i++) {
    cols.forEach((c, j) => { out[j][i] = Number(raw[i * width + (c - c0)]) * s.conversion + s.offset; });
  }
  let t;
  if (s.timestamps) {
    t = Float64Array.from(sliceVals(get(`${s.path}/timestamps`), [[i0, i1]]), Number);
  } else {
    t = new Float64Array(i1 - i0);
    for (let i = 0; i < t.length; i++) t[i] = s.start + (i0 + i) / s.rate;
  }
  void ncolsAll;
  return { t, cols: out };
}

// min/max decimation so spikes and peaks survive downsampling
function decimate(t, cols, maxPts) {
  const n = t.length;
  if (n <= maxPts) return { t: Array.from(t), cols: cols.map((c) => Array.from(c)) };
  const buckets = Math.floor(maxPts / 2);
  const per = n / buckets;
  const tt = [], cc = cols.map(() => []);
  for (let b = 0; b < buckets; b++) {
    const a = Math.floor(b * per), z = Math.min(n, Math.floor((b + 1) * per));
    // use the first column to choose min/max positions
    let lo = a, hi = a;
    const c0 = cols[0];
    for (let i = a; i < z; i++) { if (c0[i] < c0[lo]) lo = i; if (c0[i] > c0[hi]) hi = i; }
    for (const i of lo < hi ? [lo, hi] : [hi, lo]) {
      tt.push(t[i]);
      cols.forEach((c, j) => cc[j].push(c[i]));
    }
  }
  return { t: tt, cols: cc };
}

function readWindow({ path, t0, t1, maxPoints = 4000, cols = [0] }) {
  const s = window_series.get(path);
  if (!s) throw new Error("Unknown series " + path);
  const i0 = Math.max(0, indexAtTime(s, t0) - 1);
  const i1 = Math.min(s.n, indexAtTime(s, t1) + 1);
  const count = i1 - i0;
  if (count <= 0) return { t: [], cols: cols.map(() => []), exact: true, count: 0 };
  const budget = Math.max(50000, maxPoints * 8); // read every sample up to this many per column
  if (count <= budget) {
    const r = readRows(s, i0, i1, cols);
    const d = decimate(r.t, r.cols, maxPoints);
    return { ...d, exact: count <= maxPoints, count };
  }
  // Too many samples: read short blocks spread across the window and keep each block's min and max.
  // Few blocks: each block can cost a whole compressed chunk (and, for remote files, a download).
  const blocks = Math.min(Math.floor(maxPoints / 2), remote ? 60 : 400);
  const blockLen = Math.max(1, Math.min(32, Math.floor(budget / blocks)));
  const tt = [], cc = cols.map(() => []);
  for (let b = 0; b < blocks; b++) {
    const a = i0 + Math.floor((b * count) / blocks);
    const z = Math.min(i1, a + blockLen);
    const r = readRows(s, a, z, cols);
    let lo = 0, hi = 0;
    for (let i = 0; i < r.t.length; i++) { if (r.cols[0][i] < r.cols[0][lo]) lo = i; if (r.cols[0][i] > r.cols[0][hi]) hi = i; }
    for (const i of lo < hi ? [lo, hi] : [hi, lo]) { tt.push(r.t[i]); r.cols.forEach((c, j) => cc[j].push(c[i])); }
  }
  return { t: tt, cols: cc, exact: false, count, sampled: true };
}

function readTable({ path, maxRows = 2000 }) {
  const g = get(path);
  const info = tableInfo(path, g);
  const ks = keys(g);
  const n = Math.min(info.n, maxRows);
  const columns = {};
  const order = ["id", ...info.colnames.filter((c) => c !== "id")];
  for (const c of order) {
    if (!ks.includes(c)) continue;
    const d = get(`${path}/${c}`);
    try {
      if (ks.includes(`${c}_index`)) {
        // ragged column: show how many values each row has (e.g. spike counts)
        const idx = sliceVals(get(`${path}/${c}_index`), [[0, n]]).map(Number);
        columns[`${c} (count)`] = idx.map((v, i) => v - (i ? idx[i - 1] : 0));
        continue;
      }
      if ((d.shape || []).length > 1) { columns[c] = Array(n).fill(`(${d.shape.slice(1).join("×")} values)`); continue; }
      const v = sliceVals(d, [[0, n]]);
      columns[c] = Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? "(ref)" : x)) : [v];
    } catch { columns[c] = Array(n).fill("(unreadable)"); }
  }
  return { ...info, columns, shown: n };
}

// spikes for a raster: unit rows within [t0, t1]
const spikeCache = new Map(); // path -> {idx, times (Float64Array) or null}
function readSpikes({ path = "units", t0, t1, maxUnits = 60, maxSpikes = 30000 }) {
  const g = get(path);
  if (!keys(g).includes("spike_times_index")) throw new Error("No spike times in this table.");
  let c = spikeCache.get(path);
  if (!c) {
    const ix = get(`${path}/spike_times_index`);
    const idx = sliceVals(ix, [[0, ix.shape[0]]]).map(Number);
    const st = get(`${path}/spike_times`);
    const total = st.shape[0];
    // keep all spike times in memory when that is cheap (up to ~3 million spikes, 24 MB)
    const times = total <= 3e6 ? Float64Array.from(sliceVals(st, [[0, total]]), Number) : null;
    c = { idx, times, st };
    spikeCache.set(path, c);
  }
  const { idx, times, st } = c;
  const stPath = `${path}/spike_times`;
  const at = (i) => (times ? times[i] : element(stPath, i));
  const units = Math.min(idx.length, maxUnits);
  const xs = [], ys = [];
  for (let u = 0; u < units && xs.length < maxSpikes; u++) {
    const a = u ? idx[u - 1] : 0, z = idx[u];
    if (z <= a) continue;
    const find = (t) => { let lo = a, hi = z; while (lo < hi) { const m = (lo + hi) >> 1; if (at(m) < t) lo = m + 1; else hi = m; } return lo; };
    const s0 = find(t0), s1 = Math.min(find(t1), s0 + (maxSpikes - xs.length));
    if (s1 <= s0) continue;
    const vals = times ? times.subarray(s0, s1) : Array.from({ length: s1 - s0 }, (_, k) => element(stPath, s0 + k));
    for (const v of vals) { xs.push(Number(v)); ys.push(u); }
  }
  return { x: xs, y: ys, units, totalUnits: idx.length, truncated: xs.length >= maxSpikes };
}

// ------------------------------------------------------------------ messages

const window_series = new Map();

function closeCurrent() {
  try { if (file) file.close(); } catch { /* ignore */ }
  file = null;
  if (mounted) { try { FS.unmount("/local"); } catch { /* ignore */ } mounted = false; }
  window_series.clear();
  spikeCache.clear();
  blockCache.clear();
}

async function open(msg) {
  const h5 = self.h5wasm;
  if (!FS) { FS = (await h5.ready).FS; try { FS.mkdir("/local"); } catch { /* exists */ } try { FS.mkdir("/remote"); } catch { /* exists */ } }
  closeCurrent();
  remote = null;
  let p;
  if (msg.file) {
    FS.mount(FS.filesystems.WORKERFS, { files: [msg.file] }, "/local");
    mounted = true;
    p = `/local/${msg.file.name}`;
  } else if (msg.bytes) {
    p = `/remote/mem_${++fileNo}.nwb`;
    FS.writeFile(p, new Uint8Array(msg.bytes));
  } else if (msg.url) {
    p = `/remote/url_${++fileNo}.nwb`;
    remote = { url: msg.url, size: msg.size, stats: createRemoteFile(p, msg.url, msg.size) };
  }
  file = new h5.File(p, "r");
  const items = inventory();
  for (const it of items) if (it.kind === "series") window_series.set(it.path, it);
  return { meta: meta(), items, net: remote ? { ...remote.stats } : null };
}

self.onmessage = async (e) => {
  const { id, op } = e.data;
  try {
    let out;
    if (op === "open") out = await open(e.data);
    else if (op === "window") out = readWindow(e.data);
    else if (op === "table") out = readTable(e.data);
    else if (op === "spikes") out = readSpikes(e.data);
    else if (op === "children") out = { children: children(e.data.path) };
    else throw new Error("unknown op " + op);
    if (remote) out.net = { ...remote.stats };
    post(id, true, { result: out });
  } catch (err) {
    post(id, false, { error: String(err && err.message ? err.message : err) });
  }
};
