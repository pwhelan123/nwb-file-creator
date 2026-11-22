"""Build the one-page workshop spreadsheet: template/NWB_metadata_sheet.xlsx

Sheet 1 lists every field the wizard needs and marks which ones a typical lab sheet already has,
which ones are NEW, and which only need a format change. Sheet 2 shows how the data files look.
The wizard can read sheet 1 back in to pre-fill its steps.

    python tools/make_sheet.py .
"""
import sys
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.datavalidation import DataValidation

SITE = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
OUT = SITE / "template" / "NWB_metadata_sheet.xlsx"

HAVE, NEW, FORMAT = "have", "new", "format"
STATUS_TEXT = {
    HAVE: "✓ You probably record this already",
    NEW: "★ NEW: add this",
    FORMAT: "✎ You have it, change the format",
}
STATUS_FILL = {
    HAVE: PatternFill("solid", fgColor="E8F5E9"),
    NEW: PatternFill("solid", fgColor="FFF3C4"),
    FORMAT: PatternFill("solid", fgColor="E3F0FF"),
}

# (field, example, what it means, status, dropdown or None)
ROWS = [
    ("About the experiment", None, None, None, None),
    ("experimenter", "Jane Doe", "Who ran the session.", HAVE, None),
    ("lab", "Whelan Lab", "Your lab's name. Every NWB file and DANDI dataset needs it.", NEW, None),
    ("institution", "University of Somewhere", "Your university or institute.", NEW, None),
    ("experiment_description", "Wheel running and pupil size during a cue task.",
     "One or two sentences about the whole experiment.", NEW, None),
    ("The animal", None, None, None, None),
    ("subject_id", "AAX-1", "The animal's ID. Use letters, numbers and dashes.", HAVE, None),
    ("species", "Mouse", "Pick from the list. The file stores the Latin name (Mus musculus).", FORMAT,
     ["Mouse", "Rat", "Human", "Rhesus macaque", "Zebrafish", "Fruit fly", "Marmoset"]),
    ("sex", "Male", "Male, Female or Unknown. The file stores M, F or U.", FORMAT, ["Male", "Female", "Unknown"]),
    ("age_days", "90", "Age in days on the day of the session. The file stores P90D.", FORMAT, None),
    ("strain", "C57BL/6J", "Strain or line.", HAVE, None),
    ("weight_g", "25", "Weight in grams.", HAVE, None),
    ("The session", None, None, None, None),
    ("session_id", "day1", "A short name for this session.", HAVE, None),
    ("session_date", "2026-05-29", "Date as YYYY-MM-DD.", FORMAT, None),
    ("start_time", "13:45", "Clock time the recording started (24 h).", HAVE, None),
    ("timezone", "America/Denver",
     "Where the data was recorded. Without it, a start time is ambiguous.", NEW,
     ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "Europe/London",
      "Europe/Berlin", "Asia/Tokyo", "Australia/Sydney", "UTC"]),
    ("session_description", "Cue task, day 1. Wheel speed and pupil recorded.",
     "One sentence: what happened in this session.", NEW, None),
    ("protocol", "AA35009", "Animal protocol (IACUC) number.", HAVE, None),
    ("The equipment", None, None, None, None),
    ("device_name", "Pupil camera", "The main instrument that recorded the data.", NEW, None),
    ("device_description", "IR camera on the left eye, 30 frames per second", "What it is and how it was set up.", NEW, None),
    ("device_manufacturer", "Basler", "Who made it.", NEW, None),
]

THIN = Side(style="thin", color="D0D4DA")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def sheet_fill(wb):
    ws = wb.active
    ws.title = "1. Fill me in"
    ws.sheet_view.showGridLines = False
    ws["A1"] = "Your NWB metadata, on one page"
    ws["A1"].font = Font(size=18, bold=True)
    ws["A2"] = ("Fill in the white 'Your value' column. Yellow rows (★) are what most labs don't record yet. "
                "Then drop this file into the NWB File Creator and it fills in the steps for you.")
    ws["A2"].alignment = Alignment(wrap_text=True)
    ws.merge_cells("A2:E2")
    ws.row_dimensions[2].height = 34
    legend = [(HAVE, "B3"), (NEW, "C3"), (FORMAT, "D3")]
    ws["A3"] = "Key:"
    ws["A3"].font = Font(bold=True)
    for status, cell in legend:
        ws[cell] = STATUS_TEXT[status]
        ws[cell].fill = STATUS_FILL[status]
        ws[cell].border = BOX

    header = ["Field", "Your value", "Example", "What it means", "Status"]
    hr = 5
    for j, h in enumerate(header, start=1):
        c = ws.cell(hr, j, h)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="1F4E79")
        c.alignment = Alignment(vertical="center")
    r = hr + 1
    for field, example, meaning, status, choices in ROWS:
        if status is None:  # section title
            c = ws.cell(r, 1, field)
            c.font = Font(bold=True, size=13, color="1F4E79")
            ws.row_dimensions[r].height = 24
            c.alignment = Alignment(vertical="bottom")
            r += 1
            continue
        ws.cell(r, 1, field).font = Font(name="Menlo", bold=True)
        val = ws.cell(r, 2)
        val.fill = PatternFill("solid", fgColor="FFFFFF")
        val.number_format = "@"
        ws.cell(r, 3, example).font = Font(color="6B7280", italic=True)
        ws.cell(r, 4, meaning).alignment = Alignment(wrap_text=True, vertical="top")
        s = ws.cell(r, 5, STATUS_TEXT[status])
        for j in range(1, 6):
            ws.cell(r, j).border = BOX
            if j != 2:
                ws.cell(r, j).fill = STATUS_FILL[status]
            ws.cell(r, j).alignment = Alignment(wrap_text=True, vertical="top")
        s.font = Font(bold=(status == NEW))
        if choices:
            dv = DataValidation(type="list", formula1='"' + ",".join(choices) + '"', allow_blank=True,
                                showErrorMessage=False)
            dv.add(val.coordinate)
            ws.add_data_validation(dv)
        ws.row_dimensions[r].height = 32
        r += 1
    for col, w in zip("ABCDE", [24, 34, 34, 52, 34]):
        ws.column_dimensions[col].width = w
    ws.freeze_panes = ws.cell(hr + 1, 1)
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True


def sheet_data(wb):
    ws = wb.create_sheet("2. How data is organized")
    ws.sheet_view.showGridLines = False
    ws["A1"] = "How your data files should look"
    ws["A1"].font = Font(size=18, bold=True)
    notes = [
        "Save each measurement as a CSV file (Excel: File > Save As > CSV UTF-8).",
        "First column: time in seconds from the start of the session. Call it time_s.",
        "Other columns: one measurement each. Put the unit in square brackets: speed [cm/s].",
        "Trials (optional): a file called trials.csv with start_time and stop_time in seconds, then any columns you like.",
        "That's it. The NWB File Creator reads these files and asks about anything it can't work out.",
    ]
    for i, n in enumerate(notes, start=3):
        ws.cell(i, 1, f"{i - 2}.  {n}")
    head = PatternFill("solid", fgColor="1F4E79")

    def table(top, left, title, header, rows):
        ws.cell(top, left, title).font = Font(bold=True, size=13, color="1F4E79")
        for j, h in enumerate(header):
            c = ws.cell(top + 1, left + j, h)
            c.font = Font(bold=True, color="FFFFFF", name="Menlo")
            c.fill = head
            c.border = BOX
        for i, row in enumerate(rows, start=top + 2):
            for j, v in enumerate(row):
                c = ws.cell(i, left + j, v)
                c.border = BOX
                c.font = Font(name="Menlo")

    table(10, 1, "wheel.csv  (a time series)", ["time_s", "speed [cm/s]"],
          [[0.00, 8.11], [0.01, 7.95], [0.02, 8.30], [0.03, 8.42], ["…", "…"]])
    table(10, 4, "pupil.csv  (two columns, same unit)", ["time_s", "x [pixels]", "y [pixels]"],
          [[0.000, 320.4, 240.1], [0.033, 321.0, 239.6], [0.067, 320.7, 240.3], ["…", "…", "…"]])
    table(18, 1, "trials.csv  (optional)", ["start_time", "stop_time", "cue", "rewarded"],
          [[5.51, 8.51, "tone_A", "yes"], [15.95, 18.95, "tone_A", "yes"], [25.20, 28.20, "tone_B", "no"], ["…", "…", "…", "…"]])
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    for col, w in zip("ABCDEFG", [16, 16, 14, 16, 14, 14, 14]):
        ws.column_dimensions[col].width = w


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    wb = Workbook()
    sheet_fill(wb)
    sheet_data(wb)
    wb.save(OUT)
    print("wrote", OUT)
