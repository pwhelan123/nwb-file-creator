"""Build the attendee template: example_dataset/ (filled), metadata_blank.xlsx, README, and the zip."""
import shutil
import sys
from pathlib import Path

import numpy as np
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation

SITE = Path(sys.argv[1])
OUT = SITE / "template"
ROOT = OUT / "example_dataset"

SPECIES = ["Mus musculus", "Rattus norvegicus", "Homo sapiens", "Macaca mulatta", "Danio rerio",
           "Drosophila melanogaster", "Callithrix jacchus"]
SEX = ["M", "F", "U", "O"]
TZ = ["-10:00", "-09:00", "-08:00", "-07:00", "-06:00", "-05:00", "-04:00", "+00:00", "+01:00", "+02:00",
      "+05:30", "+08:00", "+09:00", "+10:00", "America/Los_Angeles", "America/Denver", "America/Chicago",
      "America/New_York", "Europe/London", "Europe/Berlin"]

# sheet -> list of (column, required?, help text)
COLUMNS = {
    "Dataset": [
        ("field", True, "# do not change this column"),
        ("value", True, "# your answer"),
    ],
    "Subjects": [
        ("subject_id", True, "# e.g. AAX_1. Must match the sub-<subject_id> folder name"),
        ("species", True, "# Latin name (dropdown)"),
        ("sex", True, "# M, F, U = unknown, O = other"),
        ("age_days", False, "# age on the session day, in days (or fill date_of_birth)"),
        ("date_of_birth", False, "# YYYY-MM-DD"),
        ("strain", False, "# e.g. C57BL/6J"),
        ("genotype", False, "# e.g. wild type"),
        ("weight_g", False, "# grams"),
        ("description", False, "# anything else about the animal"),
    ],
    "Sessions": [
        ("session_id", True, "# e.g. 01. Must match the ses-<session_id> folder name"),
        ("subject_id", True, "# from the Subjects sheet"),
        ("session_date", True, "# YYYY-MM-DD"),
        ("start_time", False, "# 24 h clock, e.g. 13:45"),
        ("timezone", True, "# where the data was recorded (dropdown)"),
        ("session_description", True, "# one sentence: what happened in this session"),
        ("experimenter", False, "# Last, First; separate people with ;"),
        ("protocol", False, "# IACUC / IRB protocol number"),
        ("devices", False, "# names from the Devices sheet; separate with ;"),
        ("surgery", False, "# free text, e.g. AP -1.8, ML 1.2, DV -2.0 from bregma"),
        ("virus", False, "# free text, e.g. AAV5-hSyn-GCaMP6s, 300 nL"),
        ("notes", False, "# anything else"),
    ],
    "Devices": [
        ("name", True, "# short name you will type in the Sessions sheet"),
        ("description", True, "# what it is and what it recorded"),
        ("manufacturer", False, "# e.g. Basler, Intan, Neuropixels"),
    ],
}
DATASET_ROWS = [
    ("institution", "Your University"),
    ("lab", "Your Lab"),
    ("experiment_description", "Open science workshop demo: wheel running and pupil size during a cue task."),
    ("keywords", "workshop; behavior; pupil"),
    ("related_publications", ""),
]
DATASET_HELP = {
    "institution": "required by DANDI",
    "lab": "required by DANDI",
    "experiment_description": "what the whole dataset is about",
    "keywords": "separate with ;",
    "related_publications": "DOIs, e.g. doi:10.1234/abcd; separate with ;",
}

EXAMPLE = {
    "Subjects": [
        ["AAX_1", "Mus musculus", "M", 90, None, "C57BL/6J", "wild type", 25.1, "Example mouse 1"],
        ["AAX_2", "Mus musculus", "F", 92, None, "C57BL/6J", "wild type", 21.7, "Example mouse 2"],
    ],
    "Sessions": [
        ["01", "AAX_1", "2026-05-29", "13:45", "America/Denver", "Cue task, day 1. Wheel speed and pupil recorded.",
         "Doe, Jane", "AA35009", "wheel_encoder; pupil_camera", None, None, None],
        ["01", "AAX_2", "2026-05-29", "15:10", "America/Denver", "Cue task, day 1. Wheel speed and pupil recorded.",
         "Doe, Jane", "AA35009", "wheel_encoder; pupil_camera", None, None, None],
    ],
    "Devices": [
        ["wheel_encoder", "Rotary encoder on the running wheel, sampled at 100 Hz", "US Digital"],
        ["pupil_camera", "IR camera on the left eye, pupil fit at 30 frames per second", "Basler"],
    ],
}

HEAD = PatternFill("solid", fgColor="1F4E79")
REQ = PatternFill("solid", fgColor="C00000")
HELP = Font(italic=True, color="808080")


def make_workbook(path, filled):
    wb = Workbook()
    wb.remove(wb.active)
    readme = wb.create_sheet("README")
    for i, line in enumerate([
        "How to fill this workbook",
        "1. Dataset: one answer per row, about the whole dataset.",
        "2. Subjects: one row per animal or participant.",
        "3. Sessions: one row per recording session. Each row needs a folder sub-<subject_id>/ses-<session_id>/ with your CSV files.",
        "4. Devices: one row per instrument. List the ones used in each session in the Sessions 'devices' column.",
        "Red headers are required. Grey rows starting with # are help text: leave them, the tool skips them.",
        "Use the dropdowns where offered. Dates are YYYY-MM-DD. Do not rename the sheets.",
    ], start=1):
        readme.cell(i, 1, line).font = Font(bold=(i == 1), size=14 if i == 1 else 11)
    readme.column_dimensions["A"].width = 120

    lists = wb.create_sheet("Lists")
    for col, values in enumerate([SPECIES, SEX, TZ], start=1):
        for row, v in enumerate(values, start=1):
            lists.cell(row, col, v)
    lists.sheet_state = "hidden"

    for sheet, cols in COLUMNS.items():
        ws = wb.create_sheet(sheet)
        for j, (name, req, helptext) in enumerate(cols, start=1):
            c = ws.cell(1, j, name)
            c.font = Font(bold=True, color="FFFFFF")
            c.fill = REQ if req else HEAD
            h = ws.cell(2, j, helptext)
            h.font = HELP
            h.alignment = Alignment(wrap_text=True, vertical="top")
            ws.column_dimensions[c.column_letter].width = 26 if name != "session_description" else 45
        ws.row_dimensions[2].height = 45
        ws.freeze_panes = "A3"
        if sheet == "Dataset":
            for i, (f, v) in enumerate(DATASET_ROWS, start=3):
                ws.cell(i, 1, f).font = Font(bold=True)
                if filled:
                    ws.cell(i, 2, v or None)
                ws.cell(i, 3, "# " + DATASET_HELP[f]).font = HELP
            ws.column_dimensions["B"].width = 70
            ws.column_dimensions["C"].width = 45
            continue
        if filled:
            for i, row in enumerate(EXAMPLE[sheet], start=3):
                for j, v in enumerate(row, start=1):
                    ws.cell(i, j, v)
        names = [n for n, _, _ in cols]
        for colname, ref in [("species", "Lists!$A$1:$A$%d" % len(SPECIES)),
                             ("sex", "Lists!$B$1:$B$%d" % len(SEX)),
                             ("timezone", "Lists!$C$1:$C$%d" % len(TZ))]:
            if colname in names:
                letter = ws.cell(1, names.index(colname) + 1).column_letter
                dv = DataValidation(type="list", formula1="=" + ref, allow_blank=True,
                                    showErrorMessage=(colname != "timezone"))
                dv.add(f"{letter}3:{letter}500")
                ws.add_data_validation(dv)
        for colname in ("session_date", "date_of_birth"):
            if colname in names:
                letter = ws.cell(1, names.index(colname) + 1).column_letter
                for r in range(3, 501):
                    ws[f"{letter}{r}"].number_format = "@"  # keep dates as typed text
        for colname in ("session_id", "subject_id", "start_time"):
            if colname in names:
                letter = ws.cell(1, names.index(colname) + 1).column_letter
                for r in range(3, 501):
                    ws[f"{letter}{r}"].number_format = "@"  # keeps "01" from becoming 1
    wb.active = wb.sheetnames.index("README")
    wb.save(path)


def write_csv(path, header, cols, fmt):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        f.write(",".join(header) + "\n")
        for row in zip(*cols):
            f.write(",".join(fm % v for fm, v in zip(fmt, row)) + "\n")


def make_data(seed, folder):
    rng = np.random.default_rng(seed)
    dur = 120.0
    # trials: a cue every ~10 s
    starts = np.arange(5, dur - 8, 10.0) + rng.uniform(0, 1, 11)
    rewarded = rng.random(len(starts)) < 0.7
    trials = [starts, starts + 3.0, np.where(rewarded, "tone_A", "tone_B"), rewarded.astype(int),
              np.round(rng.uniform(0.25, 0.9, len(starts)), 3)]
    write_csv(folder / "trials.csv", ["start_time", "stop_time", "cue", "rewarded", "lick_latency_s"],
              trials, ["%.3f", "%.3f", "%s", "%d", "%.3f"])
    # wheel: 100 Hz, regular
    t = np.arange(0, dur, 0.01)
    speed = np.clip(8 + 6 * np.sin(t / 7) + rng.normal(0, 1.5, t.size), 0, None)
    write_csv(folder / "wheel.csv", ["time_s", "speed [cm/s]"], [t, speed], ["%.2f", "%.3f"])
    # pupil: 30 Hz camera with a few dropped frames -> irregular timestamps
    tp = np.arange(0, dur, 1 / 30)
    tp = np.delete(tp, rng.choice(tp.size, 40, replace=False))
    dia = 1.2 + 0.3 * np.sin(tp / 11) + rng.normal(0, 0.03, tp.size)
    cx = 320 + rng.normal(0, 2, tp.size)
    cy = 240 + rng.normal(0, 2, tp.size)
    write_csv(folder / "pupil_diameter.csv", ["time_s", "diameter [mm]"], [tp, dia], ["%.4f", "%.4f"])
    write_csv(folder / "pupil_position.csv", ["time_s", "x [pixels]", "y [pixels]"], [tp, cx, cy],
              ["%.4f", "%.2f", "%.2f"])


if __name__ == "__main__":
    if OUT.exists():
        shutil.rmtree(OUT)
    ROOT.mkdir(parents=True)
    make_workbook(ROOT / "metadata.xlsx", filled=True)
    make_workbook(OUT / "metadata_blank.xlsx", filled=False)
    make_data(1, ROOT / "sub-AAX_1" / "ses-01")
    make_data(2, ROOT / "sub-AAX_2" / "ses-01")
    shutil.copy(Path(__file__).with_name("TEMPLATE_README.md"), ROOT / "README.md")
    shutil.copy(OUT / "metadata_blank.xlsx", ROOT / "metadata_blank.xlsx")
    shutil.make_archive(str(OUT / "nwb_workshop_template"), "zip", OUT, "example_dataset")
    print("ok")
