# NWB File Creator (workshop tool)

A static web page that converts a cleaned dataset (metadata.xlsx + CSV files) into NWB files, entirely in the
browser using Pyodide. Hosted on GitHub Pages; no server, attendee data never leaves their machine.

* `index.html`, `worker.js` – the page; Python runs in a Web Worker.
* `convert.py` – all conversion logic. Also runs locally: `python convert.py my_dataset out_folder`.
* `wheels/` – pinned pure-Python wheels (pynwb 4.2.0, hdmf 6.2.0, nwbinspector 0.7.2, openpyxl…), served from
  this site so a workshop does not depend on PyPI. Numpy, h5py and pandas come from the Pyodide 0.27.7 CDN.
* `template/` – the attendee template (example dataset, blank workbook, README). Rebuild with
  `python tools/make_template.py .` (needs numpy and openpyxl).

## Deploy
Push this folder to a GitHub repository, then Settings > Pages > Deploy from branch > `main` / root.

## Test locally
`python -m http.server` in this folder, then open http://localhost:8000. To test offline, unpack the Pyodide
0.27.7 release into `./pyodide/` and open `http://localhost:8000/?pyodide=pyodide/`.
