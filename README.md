# NWB File Creator (Open Science Workshop)

**Live:** https://pwhelan123.github.io/nwb-file-creator/

A static website where workshop attendees turn their own cleaned data into NWB files and then explore them.
Everything runs in the browser; data never leaves the attendee's computer.

* **Create** (`index.html#create`): a five-step wizard: you and your lab, your animal, your session,
  drop in CSV files (live checks, unit pickers, preview plots), then create, validate and download.
  Fields most labs don't record yet are marked "★ NEW".
* **View** (`index.html#view`): open any NWB file. Shows who/when/what/by whom, interactive plots with trials
  shaded, the trials table and the full file structure. Uses h5wasm, so it needs no Python.
* **One-page spreadsheet** (`template/NWB_metadata_sheet.xlsx`): the metadata to collect, colour-coded
  (have it / NEW / change format), plus a page showing how CSV files should look. Drop it into step 0 of
  the wizard to pre-fill the answers.
* **Batch** (`batch.html`): many subjects and sessions at once from a folder or zip (advanced).

## Files
* `app.js`, `style.css`: wizard and page shell. `viewer.js`: the NWB viewer.
* `worker.js`: runs Pyodide (Python) in a Web Worker. `convert.py`: all conversion logic
  (also runs locally: `python convert.py my_dataset out_folder`).
* `wheels/`: pinned pure-Python wheels (pynwb 4.2.0, hdmf 6.2.0, nwbinspector 0.7.2, openpyxl, …).
  Numpy, h5py and pandas come from the Pyodide 0.27.7 CDN.
* `vendor/`: h5wasm 0.7.8 and plotly.js-basic 2.35.2.
* `tools/make_sheet.py`, `tools/make_template.py`: rebuild the spreadsheet and the example dataset.

## Test locally
`python -m http.server` here, then open http://localhost:8000. To work offline, unpack the Pyodide 0.27.7
release into `./pyodide/` and open `http://localhost:8000/?pyodide=pyodide/`.
