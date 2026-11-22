"""Turn a folder of cleaned data into NWB files, one per session.

Runs in the browser (Pyodide) and on a normal Python install:

    python convert.py path/to/my_dataset  output_folder

Expected layout (the template README explains every column):

    my_dataset/
        metadata.xlsx                 sheets: Dataset, Subjects, Sessions, Devices
        sub-<subject_id>/
            ses-<session_id>/
                <anything>.csv        a time series: first column time_s, then data columns "name [unit]"
                trials.csv            optional: start_time, stop_time, then any columns

Instead of metadata.xlsx you may provide dataset.csv, subjects.csv, sessions.csv and devices.csv.
"""

import csv
import io
import re
import uuid
import zipfile
from datetime import date, datetime, time, timedelta, timezone
from pathlib import PurePosixPath

import numpy as np

TIME_COLUMN = "time_s"
SHEETS = ["Dataset", "Subjects", "Sessions", "Devices"]

# Friendly vocabulary -> NWB / DANDI vocabulary. Matches the lab's existing entries.
SPECIES = {
    "mouse": "Mus musculus", "mice": "Mus musculus",
    "rat": "Rattus norvegicus", "human": "Homo sapiens",
    "rhesus macaque": "Macaca mulatta", "macaque": "Macaca mulatta",
    "zebrafish": "Danio rerio", "fruit fly": "Drosophila melanogaster",
    "marmoset": "Callithrix jacchus", "ferret": "Mustela putorius furo",
}
SEX = {"m": "M", "male": "M", "f": "F", "female": "F", "u": "U", "unknown": "U", "o": "O", "other": "O"}

DATASET_FIELDS = {
    "institution", "lab", "experiment_description", "keywords", "related_publications",
    "experiment_id",
}


class LayoutError(Exception):
    """A problem in the attendee's files that they need to fix. The message is shown to them."""


# ------------------------------------------------------------------ reading files

def normalise(files):
    """{relative path: bytes}, zips unpacked, OS junk dropped, one shared top folder removed."""
    out = {}
    for name, data in files.items():
        if name.lower().endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                for info in zf.infolist():
                    if not info.is_dir():
                        out[info.filename] = zf.read(info)
        else:
            out[name] = data
    out = {
        k.replace("\\", "/").lstrip("/"): v for k, v in out.items()
        if "__MACOSX" not in k and not PurePosixPath(k).name.startswith((".", "~$"))
    }
    parts = [PurePosixPath(k).parts for k in out]
    if parts and all(len(p) > 1 for p in parts) and len({p[0] for p in parts}) == 1:
        out = {str(PurePosixPath(*PurePosixPath(k).parts[1:])): v for k, v in out.items()}
    return out


def find(files, name):
    """Case-insensitive lookup of a top-level file."""
    for k in files:
        if k.lower() == name.lower():
            return k
    return None


def clean_header(h):
    return str(h).strip().lower().replace(" ", "_") if h is not None else ""


def rows_to_records(header, rows):
    header = [clean_header(h) for h in header]
    recs = []
    for r in rows:
        r = list(r) + [None] * (len(header) - len(r))
        rec = {h: v for h, v in zip(header, r) if h}
        rec = {k: (v.strip() if isinstance(v, str) else v) for k, v in rec.items()}
        rec = {k: v for k, v in rec.items() if v not in (None, "")}
        if rec:
            recs.append(rec)
    return recs


def read_csv_rows(name, data):
    text = data.decode("utf-8-sig")  # tolerate Excel's byte-order mark
    rows = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
    if not rows:
        raise LayoutError(f"{name} is empty.")
    return [h.strip() for h in rows[0]], [[c.strip() for c in r] for r in rows[1:]]


def read_tables(files):
    """Return {'Dataset': [...], 'Subjects': [...], ...} as lists of dict records."""
    tables = {}
    xlsx = find(files, "metadata.xlsx")
    if xlsx:
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(files[xlsx]), data_only=True, read_only=True)
        names = {n.lower(): n for n in wb.sheetnames}
        for sheet in SHEETS:
            if sheet.lower() not in names:
                continue
            ws = wb[names[sheet.lower()]]
            rows = [r for r in ws.iter_rows(values_only=True) if any(c not in (None, "") for c in r)]
            # skip the help row (starts with "#") the template puts under the header
            if rows:
                body = [r for r in rows[1:] if not (isinstance(r[0], str) and r[0].startswith("#"))]
                tables[sheet] = rows_to_records(rows[0], body)
    else:
        for sheet in SHEETS:
            k = find(files, sheet.lower() + ".csv")
            if k:
                header, rows = read_csv_rows(k, files[k])
                body = [r for r in rows if not (r and r[0].startswith("#"))]
                tables[sheet] = rows_to_records(header, body)
    if not tables:
        raise LayoutError(
            "No metadata found. Put metadata.xlsx (or subjects.csv / sessions.csv ...) at the top of your folder."
        )
    for need in ["Subjects", "Sessions"]:
        if not tables.get(need):
            raise LayoutError(f"The {need} sheet is missing or empty.")
    return tables


# ------------------------------------------------------------------ value conversion

def as_text(v):
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def norm_species(v, where, notes):
    s = as_text(v)
    if s.lower() in SPECIES:
        notes.append(f"{where}: species '{s}' written as '{SPECIES[s.lower()]}'.")
        return SPECIES[s.lower()]
    if " " not in s and not s.startswith("http"):
        raise LayoutError(f"{where}: species '{s}' must be a Latin name such as 'Mus musculus'.")
    return s


def norm_sex(v, where):
    s = as_text(v).lower()
    if s not in SEX:
        raise LayoutError(f"{where}: sex '{v}' must be M, F, U (unknown) or O (other).")
    return SEX[s]


def norm_age(v, where):
    if isinstance(v, (int, float)):
        return f"P{as_text(v)}D"
    s = as_text(v).upper()
    if re.fullmatch(r"\d+(\.\d+)?", s):
        return f"P{s}D"
    if re.fullmatch(r"\d+\s*(DAYS?|D)", s):
        return "P" + re.match(r"\d+", s).group() + "D"
    if not re.fullmatch(r"P(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T.*)?", s) or s == "P":
        raise LayoutError(f"{where}: age '{v}' must be a number of days (90) or an ISO 8601 duration (P90D, P12W).")
    return s


def parse_tz(v, where):
    s = as_text(v).upper().replace("UTC", "").replace("GMT", "").strip()
    if s in ("", "Z", "+0", "0"):
        return timezone.utc
    m = re.fullmatch(r"([+-])(\d{1,2})(?::?(\d{2}))?", s)
    if m:
        sign = 1 if m.group(1) == "+" else -1
        return timezone(sign * timedelta(hours=int(m.group(2)), minutes=int(m.group(3) or 0)))
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(as_text(v))
    except Exception:
        raise LayoutError(f"{where}: time zone '{v}' not understood. Use an offset like -05:00 or a name like America/Chicago.")


def parse_date(v, where):
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = as_text(v)
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    raise LayoutError(f"{where}: date '{s}' must look like 2024-03-15 (or 03/15/2024).")


def parse_clock(v, where):
    if v in (None, ""):
        return time(0, 0)
    if isinstance(v, datetime):
        return v.time()
    if isinstance(v, time):
        return v
    if isinstance(v, (int, float)) and 0 <= v < 1:  # Excel fraction of a day
        secs = round(v * 86400)
        return time(secs // 3600, secs % 3600 // 60, secs % 60)
    s = as_text(v).upper()
    for fmt in ("%H:%M", "%H:%M:%S", "%I:%M %p", "%I:%M:%S %p"):
        try:
            return datetime.strptime(s, fmt).time()
        except ValueError:
            pass
    raise LayoutError(f"{where}: start time '{v}' must look like 13:45 or 1:45 PM.")


def split_list(v):
    return [p.strip() for p in as_text(v).split(";") if p.strip()]


# ------------------------------------------------------------------ data files

UNIT_RE = re.compile(r"^(.*?)\s*[\[(]\s*(.+?)\s*[\])]\s*$")


def split_unit(col):
    m = UNIT_RE.match(col)
    return (m.group(1).strip(), m.group(2)) if m else (col.strip(), None)


def parse_numeric(name, header, rows):
    out = np.empty((len(rows), len(header)))
    for i, r in enumerate(rows, start=2):
        if len(r) != len(header):
            raise LayoutError(f"{name} row {i}: expected {len(header)} values, found {len(r)}.")
        for j, c in enumerate(r):
            try:
                out[i - 2, j] = float(c) if c != "" else np.nan
            except ValueError:
                raise LayoutError(f"{name} row {i}, column '{header[j]}': '{c}' is not a number.")
    return out


def safe_name(stem):
    return "".join(c if c.isalnum() or c in "_-" else "_" for c in stem) or "timeseries"


def add_timeseries(nwbfile, path, data_bytes, notes):
    from pynwb import TimeSeries

    header, rows = read_csv_rows(path, data_bytes)
    if header[0].lower() != TIME_COLUMN:
        raise LayoutError(f"{path}: the first column must be '{TIME_COLUMN}' (seconds from session start).")
    if len(header) < 2:
        raise LayoutError(f"{path}: needs at least one data column after '{TIME_COLUMN}'.")
    if not rows:
        raise LayoutError(f"{path}: has a header but no data rows.")
    names, units = zip(*(split_unit(h) for h in header[1:]))
    if len(set(units)) > 1:
        raise LayoutError(
            f"{path}: all columns in one file must share a unit, found {sorted(set(map(str, units)))}. "
            "Put columns with different units in separate files."
        )
    unit = units[0]
    if unit is None:
        notes.append(f"{path}: no unit in the column headers (e.g. 'speed [cm/s]'), stored as 'unknown'.")
        unit = "unknown"
    arr = parse_numeric(path, header, rows)
    t, data = arr[:, 0], arr[:, 1:]
    if np.isnan(t).any():
        raise LayoutError(f"{path}: every row needs a {TIME_COLUMN} value.")
    if np.any(np.diff(t) <= 0):
        raise LayoutError(f"{path}: {TIME_COLUMN} must increase on every row (check sorting and duplicates).")
    name = safe_name(PurePosixPath(path).stem)
    kwargs = dict(
        name=name,
        data=data[:, 0] if data.shape[1] == 1 else data,
        unit=unit,
        description=f"From {PurePosixPath(path).name}. Columns: {', '.join(names)}.",
    )
    dt = np.diff(t)
    if len(t) > 2 and np.allclose(dt, dt[0], rtol=1e-6, atol=0):
        kwargs.update(starting_time=float(t[0]), rate=float(1.0 / dt[0]))
    else:
        kwargs.update(timestamps=t)
    if name in nwbfile.acquisition:
        raise LayoutError(f"{path}: two files in this session are both named '{name}'.")
    nwbfile.add_acquisition(TimeSeries(**kwargs))
    return f"TimeSeries '{name}': {len(t)} samples x {data.shape[1]} column(s), unit '{unit}'"


def add_trials(nwbfile, path, data_bytes):
    header, rows = read_csv_rows(path, data_bytes)
    if [h.lower() for h in header[:2]] != ["start_time", "stop_time"]:
        raise LayoutError(f"{path}: must start with the columns 'start_time' and 'stop_time' (seconds).")
    extra = header[2:]
    numeric = {}
    for j, c in enumerate(extra, start=2):
        vals = [r[j] for r in rows if len(r) > j and r[j] != ""]
        try:
            [float(v) for v in vals]
            numeric[c] = True
        except ValueError:
            numeric[c] = False
    for c in extra:
        nwbfile.add_trial_column(name=safe_name(c), description=f"'{c}' from trials.csv")
    for i, r in enumerate(rows, start=2):
        if len(r) != len(header):
            raise LayoutError(f"{path} row {i}: expected {len(header)} values, found {len(r)}.")
        try:
            start, stop = float(r[0]), float(r[1])
        except ValueError:
            raise LayoutError(f"{path} row {i}: start_time and stop_time must be numbers.")
        if stop < start:
            raise LayoutError(f"{path} row {i}: stop_time is before start_time.")
        vals = {
            safe_name(c): ((float(v) if v != "" else np.nan) if numeric[c] else v)
            for c, v in zip(extra, r[2:])
        }
        nwbfile.add_trial(start_time=start, stop_time=stop, **vals)
    return f"Trials table: {len(rows)} trials, extra columns: {', '.join(extra) or 'none'}"


# ------------------------------------------------------------------ building

def build_session(ses, subjects, devices, dataset, files, notes):
    from pynwb import NWBFile
    from pynwb.file import Subject

    sid = as_text(ses.get("session_id", ""))
    subj_id = as_text(ses.get("subject_id", ""))
    where = f"Sessions sheet, session '{sid}'"
    if not sid or not subj_id:
        raise LayoutError("Every row in the Sessions sheet needs a session_id and a subject_id.")
    if subj_id not in subjects:
        raise LayoutError(f"{where}: subject_id '{subj_id}' is not in the Subjects sheet.")
    for f in ("session_description", "session_date", "timezone"):
        if f not in ses:
            raise LayoutError(f"{where}: '{f}' is required.")

    tz = parse_tz(ses["timezone"], where)
    start = datetime.combine(parse_date(ses["session_date"], where), parse_clock(ses.get("start_time"), where))
    start = start.replace(tzinfo=tz)

    kwargs = dict(
        session_description=as_text(ses["session_description"]),
        identifier=str(uuid.uuid4()),
        session_start_time=start,
        session_id=sid,
    )
    for f in ("institution", "lab", "experiment_description"):
        if f in dataset:
            kwargs[f] = dataset[f]
    for f in ("keywords", "related_publications"):
        if f in dataset:
            kwargs[f] = split_list(dataset[f])
    if "experimenter" in ses:
        kwargs["experimenter"] = split_list(ses["experimenter"])
    for f in ("protocol", "notes", "surgery", "virus", "pharmacology"):
        if f in ses:
            kwargs[f] = as_text(ses[f])
    nwbfile = NWBFile(**kwargs)

    s = subjects[subj_id]
    swhere = f"Subjects sheet, subject '{subj_id}'"
    for f in ("species", "sex"):
        if f not in s:
            raise LayoutError(f"{swhere}: '{f}' is required.")
    skw = dict(subject_id=subj_id, species=norm_species(s["species"], swhere, notes), sex=norm_sex(s["sex"], swhere))
    if "age_days" in s:
        skw["age"] = norm_age(s["age_days"], swhere)
    elif "age" in s:
        skw["age"] = norm_age(s["age"], swhere)
    if "date_of_birth" in s:
        skw["date_of_birth"] = datetime.combine(parse_date(s["date_of_birth"], swhere), time(0)).replace(tzinfo=tz)
    if "age" not in skw and "date_of_birth" not in skw:
        notes.append(f"{swhere}: add age_days or date_of_birth (DANDI requires one).")
    if "weight_g" in s:
        skw["weight"] = f"{as_text(s['weight_g'])} g"
    for f in ("strain", "genotype", "description"):
        if f in s:
            skw[f] = as_text(s[f])
    nwbfile.subject = Subject(**skw)

    for dname in split_list(ses.get("devices", "")):
        if dname not in devices:
            raise LayoutError(f"{where}: device '{dname}' is not in the Devices sheet.")
        d = devices[dname]
        nwbfile.create_device(
            name=dname.replace("/", "-"),
            description=as_text(d.get("description", "")) or None,
            manufacturer=as_text(d.get("manufacturer", "")) or None,
        )

    folder = f"sub-{subj_id}/ses-{sid}/"
    data_files = sorted(k for k in files if k.startswith(folder) and k.lower().endswith(".csv"))
    if not data_files:
        raise LayoutError(f"{where}: no CSV files found in the folder {folder}")
    added = []
    for path in data_files:
        if PurePosixPath(path).name.lower() == "trials.csv":
            added.append(add_trials(nwbfile, path, files[path]))
        else:
            added.append(add_timeseries(nwbfile, path, files[path], notes))
    return nwbfile, f"sub-{subj_id}_ses-{sid}.nwb", added


def check_folders(files, sessions, notes):
    expected = {f"sub-{as_text(s.get('subject_id', ''))}/ses-{as_text(s.get('session_id', ''))}" for s in sessions}
    found = {"/".join(PurePosixPath(k).parts[:2]) for k in files if k.startswith("sub-") and len(PurePosixPath(k).parts) > 2}
    for extra in sorted(found - expected):
        notes.append(f"Folder {extra}/ has no row in the Sessions sheet, so it was skipped.")


def build_all(files, out_dir="."):
    """Build one NWB file per session. Returns (list of written paths, report lines)."""
    from pynwb import NWBHDF5IO, validate

    files = normalise(files)
    tables = read_tables(files)
    dataset = {}
    for rec in tables.get("Dataset", []):
        if "field" in rec and "value" in rec:
            dataset[clean_header(rec["field"])] = as_text(rec["value"])
    subjects = {as_text(r["subject_id"]): r for r in tables["Subjects"] if "subject_id" in r}
    devices = {as_text(r["name"]): r for r in tables.get("Devices", []) if "name" in r}
    sessions = tables["Sessions"]
    report, written = [], []
    for f in ("institution", "lab"):
        if f not in dataset:
            report.append(f"Recommended: fill in '{f}' on the Dataset sheet.")
    check_folders(files, sessions, report)

    problems_all = []
    for ses in sessions:
        notes = []
        try:
            nwbfile, fname, added = build_session(ses, subjects, devices, dataset, files, notes)
        except LayoutError as e:
            problems_all.append(str(e))
            continue
        path = f"{out_dir.rstrip('/')}/{fname}"
        with NWBHDF5IO(path, "w") as io_:
            io_.write(nwbfile)
        problems = validate(path=path)
        report.append(f"## {fname}")
        report.extend("  + " + a for a in added)
        report.extend("  note: " + n for n in dict.fromkeys(notes))
        if problems:
            report.append("  NWB schema check FAILED:")
            report.extend("    " + str(p) for p in problems)
        else:
            report.append("  NWB schema check passed.")
        written.append(path)
    if problems_all and not written:
        raise LayoutError("\n".join(problems_all))
    if problems_all:
        report.insert(0, f"SKIPPED {len(problems_all)} session(s) with problems:")
        for i, p in enumerate(problems_all, start=1):
            report.insert(i, "  - " + p)
    return written, report


def load_folder(folder):
    from pathlib import Path
    root = Path(folder)
    if root.is_file():
        return {root.name: root.read_bytes()}
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}


if __name__ == "__main__":
    import os
    import sys
    os.makedirs(sys.argv[2], exist_ok=True)
    try:
        _, lines = build_all(load_folder(sys.argv[1]), sys.argv[2])
        print("\n".join(lines))
    except LayoutError as e:
        sys.exit(f"Problem with your files: {e}")


def read_simple_sheet(data):
    """Read 'Field' / 'Your value' pairs from the one-page workshop sheet (NWB_metadata_sheet.xlsx)."""
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    out = {}
    for ws in wb.worksheets:
        rows = list(ws.iter_rows(values_only=True))
        hdr_idx = None
        for i, r in enumerate(rows):
            cells = [clean_header(c) for c in r]
            if "field" in cells and "your_value" in cells:
                hdr_idx, f_col, v_col = i, cells.index("field"), cells.index("your_value")
                break
        if hdr_idx is None:
            continue
        for r in rows[hdr_idx + 1:]:
            if len(r) <= max(f_col, v_col) or r[f_col] in (None, "") or r[v_col] in (None, ""):
                continue
            v = r[v_col]
            if isinstance(v, datetime):
                v = v.date().isoformat() if v.time() == time(0) else v.isoformat()
            elif isinstance(v, (date, time)):
                v = v.isoformat()
            out[clean_header(r[f_col])] = as_text(v)
        if out:
            break
    return out
