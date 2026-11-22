// Runs Python (Pyodide) off the main thread so the page stays responsive.
let pyodide = null;
let ready = null;

const WHEELS = [
  "hdmf-6.2.0-py3-none-any.whl",
  "pynwb-4.2.0-py3-none-any.whl",
  "platformdirs-4.3.6-py3-none-any.whl",
  "et_xmlfile-2.0.0-py3-none-any.whl",
  "openpyxl-3.1.5-py2.py3-none-any.whl",
  "natsort-8.4.0-py3-none-any.whl",
  "isodate-0.7.2-py3-none-any.whl",
  "nwbinspector-0.7.2-py3-none-any.whl",
];
const PYODIDE_PACKAGES = [
  "micropip", "numpy", "h5py", "pandas", "jsonschema", "ruamel.yaml", "python-dateutil",
  "tzdata", "pyyaml", "packaging", "click", "tqdm", "requests", "fsspec", "aiohttp",
];

const say = (type, data) => self.postMessage({ type, ...data });

async function init(pyodideBase, siteBase) {
  say("status", { text: "Downloading Python for your browser (about 30 MB, first visit only)…" });
  importScripts(pyodideBase + "pyodide.js");
  pyodide = await loadPyodide({ indexURL: pyodideBase });
  say("status", { text: "Loading scientific packages (numpy, h5py, pandas)…" });
  await pyodide.loadPackage(PYODIDE_PACKAGES, { messageCallback: () => {} });
  say("status", { text: "Installing pynwb and NWB Inspector…" });
  const micropip = pyodide.pyimport("micropip");
  await micropip.install(WHEELS.map((w) => siteBase + "wheels/" + w), { deps: false });
  const code = await (await fetch(siteBase + "convert.py", { cache: "no-cache" })).text();
  pyodide.FS.writeFile("/home/pyodide/convert.py", code);
  await pyodide.runPythonAsync(`
import sys, warnings
sys.path.insert(0, "/home/pyodide")
warnings.filterwarnings("ignore")
import convert, pynwb
# NWB Inspector imports concurrent.futures' process pool, which Pyodide lacks. It is never used here.
import types
if "_multiprocessing" not in sys.modules:
    _mp = types.ModuleType("_multiprocessing")
    _mp.flags = {}
    _mp.sem_unlink = lambda *a: None
    class SemLock:  # noqa
        def __init__(self, *a, **k):
            raise OSError("multiprocessing is not available in the browser")
    _mp.SemLock = SemLock
    sys.modules["_multiprocessing"] = _mp
`);
  const v = pyodide.runPython("pynwb.__version__");
  say("ready", { text: `Ready (pynwb ${v}).` });
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      ready = init(msg.pyodideBase, msg.siteBase);
      await ready;
      return;
    }
    if (msg.type === "convert") {
      await ready;
      say("status", { text: "Reading your files…" });
      const files = pyodide.toPy(msg.files); // {path: Uint8Array}
      pyodide.globals.set("_files", files);
      const result = await pyodide.runPythonAsync(`
import os, shutil, json, traceback
out = "/home/pyodide/out"
shutil.rmtree(out, ignore_errors=True)
os.makedirs(out)
_in = {k: bytes(v) for k, v in _files.items()}
try:
    paths, lines = convert.build_all(_in, out)
    status = "ok"
except convert.LayoutError as e:
    paths, lines, status = [], [str(e)], "layout"
except Exception as e:
    paths, lines, status = [], ["Unexpected error: " + repr(e), traceback.format_exc()], "crash"
inspect = []
if paths:
    try:
        from nwbinspector import inspect_nwbfile, Importance
        for p in [p for p in paths if p.endswith(".nwb")]:
            for m in inspect_nwbfile(nwbfile_path=p):
                if m is None:
                    continue
                inspect.append({
                    "file": os.path.basename(p),
                    "importance": m.importance.name,
                    "check": m.check_function_name,
                    "where": f"{m.object_type} '{m.object_name}'",
                    "message": m.message,
                })
    except Exception as e:
        inspect.append({"file": "", "importance": "TOOL", "check": "nwbinspector",
                        "where": "", "message": "NWB Inspector could not run: " + repr(e)})
if len(paths) > 1:
    import zipfile
    zp = out + "/nwb_files.zip"
    with zipfile.ZipFile(zp, "w") as zf:
        for p in paths:
            zf.write(p, os.path.basename(p))
    paths.append(zp)
json.dumps({"status": status, "lines": lines, "paths": paths, "inspect": inspect})
`);
      files.destroy();
      const res = JSON.parse(result);
      res.outputs = res.paths.map((p) => {
        const bytes = pyodide.FS.readFile(p);
        return { name: p.split("/").pop(), bytes };
      });
      self.postMessage({ type: "result", ...res }, res.outputs.map((o) => o.bytes.buffer));
    }
  } catch (err) {
    say("error", { text: String(err) });
  }
};
