"""
process_data.py

Turns raw recordings in dataset/ (label_timestamp.wav / .csv / .mp4) into
processed signals matching the professor's API shape:

    {
      "exerciseId": "label_timestamp",
      "soundPressure": {"values": [...], "unit": "dB",  "sampleRate": 100},
      "footSpeed":     {"values": [...], "unit": "m/s", "sampleRate": 32},
      "mouthOpening":  {"values": [...], "unit": "ratio","sampleRate": 30},
      "aggregates": {
          "soundPressure": {"mean":..., "max":..., "min":...},
          "footSpeed":     {"mean":..., "max":..., "min":...},
          "mouthOpening":  {"mean":..., "max":..., "min":...},
          "stepCount": ...,
          "stepLengths": [...]   # rough proxy, see note below
      }
    }

WHERE TO RUN THIS
------------------
- soundPressure + footSpeed: fine to run on the Pi (only needs numpy).
- mouthOpening: needs MediaPipe + a downloaded model file. Run this part
  on your MAC (or anywhere with internet), not the Pi. If mediapipe or
  the model file isn't available, this script SKIPS mouthOpening for
  that recording instead of crashing, so you can still get sound+motion
  processed on the Pi.

ONE-TIME SETUP (on your Mac, for mouthOpening)
------------------------------------------------
    pip install mediapipe opencv-python --break-system-packages
    curl -L -o face_landmarker.task \
      https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
Put face_landmarker.task in the same folder as this script.

HONEST CAVEATS (read before presenting these numbers)
------------------------------------------------------
- soundPressure is RELATIVE dB (dBFS), not calibrated SPL. The INMP441
  isn't a calibrated measurement mic, so these numbers are only valid
  for comparing your own recordings to each other (normal vs medium vs
  big), not as absolute real-world loudness.
- footSpeed comes from integrating a single accelerometer's readings.
  That inherently drifts over time without a second sensor (e.g. GPS,
  or zero-velocity updates when the foot is stationary). This script
  does two things to reduce that: (1) subtracts the gravity/baseline
  per recording, (2) removes the linear drift trend after integrating.
  It's a solid relative signal (bigger movement -> higher values) but
  is NOT lab-grade calibrated speed in m/s.
- stepLengths/stepCount are a simple peak-detection proxy on the
  vertical-ish acceleration axis. It's a reasonable estimate for a
  student project, not a validated gait-analysis metric.
- mouthOpening quality depends entirely on the face being clearly and
  consistently visible in frame. If OpenCV/MediaPipe can't find a face
  in most frames, the values array will have gaps (marked as None).
"""

import os
import csv
import json
import wave
import glob
import numpy as np

DATASET_DIR = "dataset"
PROCESSED_DIR = "processed"

# MPU-6050 default sensitivity for +/-2g range: 16384 LSB = 1g
ACCEL_SENSITIVITY = 16384.0
G = 9.81  # m/s^2


# ----------------------------------------------------------------------
# soundPressure (tested earlier on real audio - unchanged logic)
# ----------------------------------------------------------------------
def compute_sound_pressure(wav_path, window_ms=10):
    with wave.open(wav_path, "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    dtype = {1: np.int8, 2: np.int16, 4: np.int32}.get(sampwidth, np.int16)
    audio = np.frombuffer(raw, dtype=dtype)
    if n_channels > 1:
        audio = audio.reshape(-1, n_channels).mean(axis=1)

    max_val = float(np.iinfo(dtype).max)
    window_size = max(1, int(framerate * window_ms / 1000))

    values = []
    for start in range(0, len(audio), window_size):
        chunk = audio[start:start + window_size].astype(np.float64)
        if len(chunk) == 0:
            continue
        rms = np.sqrt(np.mean(chunk ** 2))
        if rms < 1:
            db = -80.0  # floor for near-silence
        else:
            db = 20 * np.log10(rms / max_val)
        values.append(round(float(db), 2))

    sample_rate = round(1000 / window_ms)
    return {"values": values, "unit": "dB", "sampleRate": sample_rate}


# ----------------------------------------------------------------------
# footSpeed (foot-mounted accelerometer -> drift-corrected speed proxy)
# ----------------------------------------------------------------------
def compute_foot_speed(csv_path):
    rows = []
    with open(csv_path, newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append(r)

    if len(rows) < 2:
        return None

    t = np.array([float(r["time_offset"]) for r in rows])
    ax = np.array([float(r["accel_x"]) for r in rows]) / ACCEL_SENSITIVITY * G
    ay = np.array([float(r["accel_y"]) for r in rows]) / ACCEL_SENSITIVITY * G
    az = np.array([float(r["accel_z"]) for r in rows]) / ACCEL_SENSITIVITY * G

    # Remove the gravity/baseline offset per axis (assumes the sensor's
    # resting orientation is roughly constant during this recording).
    ax = ax - np.mean(ax)
    ay = ay - np.mean(ay)
    az = az - np.mean(az)

    accel_mag = np.sqrt(ax ** 2 + ay ** 2 + az ** 2)

    # Integrate acceleration -> velocity (cumulative trapezoidal rule)
    dt = np.diff(t, prepend=t[0])
    dt[0] = dt[1] if len(dt) > 1 else 0.01
    velocity = np.cumsum(accel_mag * dt)

    # Remove linear drift trend (basic detrend since we have no
    # zero-velocity reference points)
    if len(velocity) > 1:
        trend = np.polyfit(t, velocity, 1)
        velocity = velocity - np.polyval(trend, t)

    speed = np.abs(velocity)

    sample_rate = round(1 / np.mean(np.diff(t))) if len(t) > 1 else 32

    return {
        "values": [round(float(v), 4) for v in speed],
        "unit": "m/s (relative, drift-corrected proxy)",
        "sampleRate": sample_rate,
        "_accel_magnitude": accel_mag,  # kept internally for step detection
        "_time": t,
    }


def compute_step_metrics(accel_mag, t, speed_values):
    """Very simple peak-detection proxy for steps. Not validated gait analysis."""
    if len(accel_mag) < 5:
        return {"stepCount": 0, "stepLengths": []}

    threshold = np.mean(accel_mag) + 0.5 * np.std(accel_mag)
    peaks = []
    for i in range(1, len(accel_mag) - 1):
        if accel_mag[i] > threshold and accel_mag[i] > accel_mag[i - 1] and accel_mag[i] > accel_mag[i + 1]:
            if not peaks or (t[i] - t[peaks[-1]]) > 0.25:  # avoid double-counting one step
                peaks.append(i)

    step_lengths = []
    for i in range(1, len(peaks)):
        idx_a, idx_b = peaks[i - 1], peaks[i]
        avg_speed = float(np.mean(speed_values[idx_a:idx_b + 1])) if idx_b > idx_a else 0.0
        duration = t[idx_b] - t[idx_a]
        step_lengths.append(round(avg_speed * duration, 4))

    return {"stepCount": len(peaks), "stepLengths": step_lengths}


# ----------------------------------------------------------------------
# mouthOpening (MediaPipe Face Landmarker - run on Mac, needs model file)
# ----------------------------------------------------------------------
def compute_mouth_opening(video_path, model_path="face_landmarker.task"):
    if not os.path.exists(model_path):
        print(f"   [mouthOpening skipped] model file not found: {model_path}")
        return None

    try:
        import cv2
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
    except ImportError as e:
        print(f"   [mouthOpening skipped] missing package: {e}")
        return None

    base_options = mp_python.BaseOptions(model_asset_path=model_path)
    options = vision.FaceLandmarkerOptions(
        base_options=base_options,
        running_mode=vision.RunningMode.VIDEO,
        num_faces=1,
    )

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    values = []
    frame_idx = 0
    detected_count = 0

    with vision.FaceLandmarker.create_from_options(options) as landmarker:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            timestamp_ms = int((frame_idx / fps) * 1000)

            result = landmarker.detect_for_video(mp_image, timestamp_ms)

            if result.face_landmarks:
                lm = result.face_landmarks[0]
                # Upper lip center (13), lower lip center (14)
                upper = lm[13]
                lower = lm[14]
                # Mouth corners for width normalization (61, 291)
                left = lm[61]
                right = lm[291]

                vertical_dist = ((upper.x - lower.x) ** 2 + (upper.y - lower.y) ** 2) ** 0.5
                mouth_width = ((left.x - right.x) ** 2 + (left.y - right.y) ** 2) ** 0.5

                ratio = vertical_dist / mouth_width if mouth_width > 0 else 0.0
                values.append(round(float(ratio), 4))
                detected_count += 1
            else:
                values.append(None)  # no face found this frame

            frame_idx += 1

    cap.release()

    if frame_idx == 0:
        return None

    print(f"   Face detected in {detected_count}/{frame_idx} frames")

    return {"values": values, "unit": "ratio (mouth height / mouth width)", "sampleRate": round(fps)}


# ----------------------------------------------------------------------
# aggregates
# ----------------------------------------------------------------------
def aggregate(values):
    clean = [v for v in values if v is not None]
    if not clean:
        return {"mean": None, "max": None, "min": None}
    return {
        "mean": round(float(np.mean(clean)), 4),
        "max": round(float(np.max(clean)), 4),
        "min": round(float(np.min(clean)), 4),
    }


# ----------------------------------------------------------------------
# main pipeline
# ----------------------------------------------------------------------
def find_recordings():
    """Group files in dataset/ by their shared label_timestamp prefix."""
    csvs = glob.glob(os.path.join(DATASET_DIR, "*.csv"))
    recordings = []
    for csv_path in csvs:
        base = os.path.splitext(os.path.basename(csv_path))[0]  # label_timestamp
        wav_path = os.path.join(DATASET_DIR, base + ".wav")
        mp4_path = os.path.join(DATASET_DIR, base + ".mp4")
        recordings.append({
            "id": base,
            "csv": csv_path if os.path.exists(csv_path) else None,
            "wav": wav_path if os.path.exists(wav_path) else None,
            "mp4": mp4_path if os.path.exists(mp4_path) else None,
        })
    return recordings


def process_one(rec):
    exercise_id = rec["id"]
    out_path = os.path.join(PROCESSED_DIR, exercise_id + ".json")

    result = {"exerciseId": exercise_id}
    aggregates = {}

    if rec["wav"]:
        sp = compute_sound_pressure(rec["wav"])
        result["soundPressure"] = sp
        aggregates["soundPressure"] = aggregate(sp["values"])
        print(f"   soundPressure: {len(sp['values'])} values")
    else:
        print("   soundPressure: skipped (no .wav)")

    if rec["csv"]:
        fs = compute_foot_speed(rec["csv"])
        if fs:
            accel_mag = fs.pop("_accel_magnitude")
            t = fs.pop("_time")
            result["footSpeed"] = fs
            aggregates["footSpeed"] = aggregate(fs["values"])
            step_metrics = compute_step_metrics(accel_mag, t, np.array(fs["values"]))
            aggregates["stepCount"] = step_metrics["stepCount"]
            aggregates["stepLengths"] = step_metrics["stepLengths"]
            print(f"   footSpeed: {len(fs['values'])} values, {step_metrics['stepCount']} steps detected")
    else:
        print("   footSpeed: skipped (no .csv)")

    if rec["mp4"]:
        mo = compute_mouth_opening(rec["mp4"])
        if mo:
            result["mouthOpening"] = mo
            aggregates["mouthOpening"] = aggregate(mo["values"])
            print(f"   mouthOpening: {len(mo['values'])} values")
    else:
        print("   mouthOpening: skipped (no .mp4)")

    result["aggregates"] = aggregates

    os.makedirs(PROCESSED_DIR, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)

    return out_path


def main():
    recordings = find_recordings()
    print(f"Found {len(recordings)} recording(s).")
    for rec in recordings:
        print(f"\n{rec['id']}:")
        out_path = process_one(rec)
        print(f"   -> {out_path}")
    print(f"\nDone. Processed JSON written to {PROCESSED_DIR}/")


if __name__ == "__main__":
    main()
