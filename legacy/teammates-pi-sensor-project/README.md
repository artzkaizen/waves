# Pi Sensor Project

Multi-modal data collection: accelerometer + microphone + camera on a
Raspberry Pi, processed into soundPressure / footSpeed / mouthOpening
signals, viewable in a dashboard.

## What's in this repo

- `mac_dashboard.py` — run this on your Mac. One button: SSHes into the
  Pi, triggers a recording, pulls the files back, processes all 3
  signals, shows charts.
- `process_data.py` — turns raw recordings (video/audio/motion) into
  processed signals. Needs to run somewhere with MediaPipe support
  (your Mac, not the Pi — see note below).
- `upload_to_forellando.py` — pushes processed JSON to the class SFTP
  server for shared storage.
- `face_landmarker.task` — MediaPipe's face model file (needed for
  mouthOpening detection).
- `dataset/` — raw recordings (`.wav` audio, `.csv` motion, `.mp4` video).
- `processed/` — processed JSON output per recording.

## One-time setup (each teammate, on their own Mac)

```
pip install streamlit pandas paramiko mediapipe opencv-python --break-system-packages
```

## Running it

```
cd pi_sensor_project
streamlit run mac_dashboard.py
```

In the sidebar, enter the Pi's SSH password (host/username are
pre-filled). Type a label (`normal` / `medium` / `big`) and click
**"Record on Pi + process here"** — this remotely records on the Pi,
pulls the files back, and processes all three signals locally.

## IMPORTANT: why mouthOpening only works on a Mac, not the Pi

MediaPipe currently has **no published wheel for Linux ARM64**
(confirmed: open issue on Google's MediaPipe repo, "No linux arm64
wheels"). That's the Pi's exact platform. This isn't fixable by
installing harder — it's a real gap in what Google publishes. So:

- Recording happens on the Pi (that's where the hardware is).
- Processing (especially mouthOpening) happens on a Mac/PC, not the Pi.

## Honest caveats on the processed signals

- **soundPressure** is *relative* dB (dBFS), not calibrated real-world
  loudness — the INMP441 mic isn't a calibrated measurement device.
  Fine for comparing your own recordings to each other, not as an
  absolute reference.
- **footSpeed** comes from integrating a single accelerometer over
  time, with basic drift correction applied. It's a solid relative
  signal (bigger movement → higher values) but not lab-grade
  calibrated speed.
- **mouthOpening** quality depends entirely on camera framing — the
  whole face (forehead to chin, both eyes) needs to be visible. If a
  recording shows a low "face detected %" in the dashboard, that
  recording's mouthOpening data isn't reliable.

## Credentials — do NOT commit these anywhere

Never hardcode the Pi password or the forellando password into any
file in this repo. The dashboard's password fields are typed in each
session and are not saved to disk. If you're scripting
`upload_to_forellando.py` non-interactively, use environment variables
(see the comment at the top of that file) — never paste credentials
into code or commit messages.
