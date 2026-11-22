# How to organize your data for the NWB File Creator

The NWB File Creator turns a folder of cleaned spreadsheets into NWB files, one per recording session.
Everything runs in your web browser. Your data is never uploaded anywhere.

This folder is a complete, working example. Try it first: zip the `example_dataset` folder (or drop the
downloaded zip as is) onto the tool's page and press **Create NWB files**. Then replace the example with your own data.

## 1. The folder layout

```
example_dataset/
├── metadata.xlsx                  describes the dataset, subjects, sessions and devices
├── sub-AAX_1/                     one folder per subject:   sub-<subject_id>
│   └── ses-01/                    one folder per session:   ses-<session_id>
│       ├── trials.csv             optional: one row per trial
│       ├── wheel.csv              a time series
│       ├── pupil_diameter.csv     another time series
│       └── pupil_position.csv     a time series with two columns
└── sub-AAX_2/
    └── ses-01/
        └── ...
```

Rules:

1. Folder names must match the IDs in `metadata.xlsx` exactly: subject `AAX_1` lives in `sub-AAX_1/`,
   and its session `01` lives in `sub-AAX_1/ses-01/`.
2. Every session in the Sessions sheet needs a folder with at least one CSV file in it.
3. Save data files as **CSV (comma separated)**. In Excel: *File > Save As > CSV UTF-8*.

## 2. metadata.xlsx

Open `metadata.xlsx`. Red column headers are required; blue ones are optional. The grey row under each
header explains the column and can stay where it is. Use `metadata_blank.xlsx` to start your own.

| Sheet | One row per | Required columns |
|---|---|---|
| Dataset | question about the whole dataset | institution, lab (strongly recommended) |
| Subjects | animal or participant | subject_id, species, sex |
| Sessions | recording session | session_id, subject_id, session_date, timezone, session_description |
| Devices | instrument (camera, amplifier, encoder) | name, description |

Values the tool expects, and what it will fix for you:

| Column | Write it like | The tool also accepts |
|---|---|---|
| species | `Mus musculus` (Latin name, dropdown) | Mouse, Rat, Human (converted for you) |
| sex | `M`, `F`, `U` (unknown) or `O` (other) | Male, Female |
| age_days | `90` (age in days on the session day) | `P90D`, `P12W` (ISO 8601) |
| session_date | `2026-05-29` | `05/29/2026` |
| start_time | `13:45` | `1:45 PM` |
| timezone | `America/Denver` or `-06:00` | `UTC-6` |
| experimenter | `Doe, Jane; Smith, Sam` | |
| devices | `wheel_encoder; pupil_camera` (names from the Devices sheet) | |

The time zone matters: NWB stores the exact moment the session started, and a date without a time zone is ambiguous.

## 3. Time series files (any CSV except trials.csv)

```
time_s,speed [cm/s]
0.00,8.112
0.01,7.954
```

* The first column is `time_s`: seconds since the session started, increasing on every row.
* Every other column is a measurement. Put its unit in square brackets in the header: `speed [cm/s]`.
* All columns in one file must share the same unit. Different units go in different files.
* Only numbers. Leave a cell empty for a missing value.
* Each file becomes one NWB `TimeSeries`, named after the file (`wheel.csv` becomes `wheel`).
  Regularly sampled data is stored with a sampling rate; irregular data (dropped frames) keeps every timestamp.

## 4. trials.csv (optional)

```
start_time,stop_time,cue,rewarded,lick_latency_s
5.512,8.512,tone_A,1,0.412
```

* `start_time` and `stop_time` in seconds since the session started.
* Add as many other columns as you like (numbers or text). They become columns of the NWB trials table.

## 5. What you get

One file per session, named the way DANDI expects: `sub-AAX_1_ses-01.nwb`. The tool checks each file against the
NWB schema and lists anything to fix. Open the result in [Neurosift](https://neurosift.app) or with `pynwb` in Python.

## What this tool does not do (yet)

It handles behavior-style data: time series and trials. Raw electrophysiology, imaging and video need
device-specific converters. For those, use [NWB GUIDE](https://nwb-guide.readthedocs.io) or
[NeuroConv](https://neuroconv.readthedocs.io), which read Intan, SpikeGLX, Suite2p, DeepLabCut and many more formats.
