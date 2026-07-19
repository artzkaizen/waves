"""
mac_dashboard.py

Runs on your MAC (not the Pi). One button does the whole pipeline:

    Record (SSH into Pi, run collect_sample remotely)
      -> Download the new files (SFTP)
      -> Process ALL THREE signals locally on the Mac
      -> Show every chart + a research summary comparing levels
      -> Optionally upload the processed JSON to forellando
         (files are prefixed with your group name so they don't collide
          with other students' uploads on the shared class server)

ONE-TIME SETUP (on your Mac)
------------------------------
    pip3 install streamlit pandas paramiko mediapipe opencv-python --break-system-packages

RUN
---
    streamlit run mac_dashboard.py
"""

import os
import io
import json
import glob
import shlex

import streamlit as st
import pandas as pd

DATASET_DIR = "dataset"
PROCESSED_DIR = "processed"
REMOTE_PROJECT_DIR = "inmp441_test"  # folder on the Pi with collect_data.py
FORELLANDO_HOST = "forellando.de"
FORELLANDO_REMOTE_DIR = "processed"

# Which labels to group together for the research summary.
RESEARCH_LEVELS = ["normal", "medium", "big"]

st.set_page_config(page_title="Sensor Data Collector (Mac)", layout="wide")

os.makedirs(DATASET_DIR, exist_ok=True)
os.makedirs(PROCESSED_DIR, exist_ok=True)


# ----------------------------------------------------------------------
# Remote (Pi) helpers
# ----------------------------------------------------------------------
def record_on_pi(pi_host, pi_user, pi_password, label):
    import paramiko

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(hostname=pi_host, username=pi_user, password=pi_password, timeout=15)

    remote_cmd = (
        f"cd {REMOTE_PROJECT_DIR} && "
        f"python3 -c \"from collect_data import collect_sample; collect_sample({shlex.quote(label)!r})\""
    )
    stdin, stdout, stderr = ssh.exec_command(remote_cmd, timeout=60)
    exit_status = stdout.channel.recv_exit_status()
    out_text = stdout.read().decode(errors="replace")
    err_text = stderr.read().decode(errors="replace")

    if exit_status != 0:
        ssh.close()
        raise RuntimeError(f"Recording failed on Pi:\n{out_text}\n{err_text}")

    sftp = ssh.open_sftp()
    remote_dataset = f"{REMOTE_PROJECT_DIR}/dataset"

    remote_files = sftp.listdir(remote_dataset)
    matches = sorted(
        [f for f in remote_files if f.startswith(label + "_") and f.endswith(".csv")],
        reverse=True,
    )
    if not matches:
        sftp.close()
        ssh.close()
        raise RuntimeError(
            f"Recording ran, but no '{label}_*.csv' found on the Pi afterward.\n"
            f"Pi output was:\n{out_text}"
        )

    rec_id = matches[0][:-4]

    for ext in ("csv", "wav", "mp4"):
        remote_path = f"{remote_dataset}/{rec_id}.{ext}"
        local_path = os.path.join(DATASET_DIR, f"{rec_id}.{ext}")
        try:
            sftp.get(remote_path, local_path)
        except FileNotFoundError:
            pass

    sftp.close()
    ssh.close()
    return rec_id


def sync_all_from_pi(pi_host, pi_user, pi_password):
    import paramiko

    transport = paramiko.Transport((pi_host, 22))
    transport.connect(username=pi_user, password=pi_password)
    sftp = paramiko.SFTPClient.from_transport(transport)

    remote_dataset = f"{REMOTE_PROJECT_DIR}/dataset"
    remote_files = sftp.listdir(remote_dataset)

    count = 0
    for filename in remote_files:
        if filename.endswith((".csv", ".wav", ".mp4")):
            local_path = os.path.join(DATASET_DIR, filename)
            if not os.path.exists(local_path):
                sftp.get(f"{remote_dataset}/{filename}", local_path)
                count += 1

    sftp.close()
    transport.close()
    return count


# ----------------------------------------------------------------------
# Local processing
# ----------------------------------------------------------------------
def process_recording(rec_id):
    import process_data
    rec = {
        "id": rec_id,
        "csv": os.path.join(DATASET_DIR, rec_id + ".csv"),
        "wav": os.path.join(DATASET_DIR, rec_id + ".wav"),
        "mp4": os.path.join(DATASET_DIR, rec_id + ".mp4"),
    }
    for key in ("csv", "wav", "mp4"):
        if not os.path.exists(rec[key]):
            rec[key] = None
    return process_data.process_one(rec)


def upload_processed_to_forellando(forellando_user, forellando_password, prefix=""):
    import paramiko
    transport = paramiko.Transport((FORELLANDO_HOST, 22))
    transport.connect(username=forellando_user, password=forellando_password)
    sftp = paramiko.SFTPClient.from_transport(transport)

    try:
        sftp.stat(FORELLANDO_REMOTE_DIR)
    except IOError:
        sftp.mkdir(FORELLANDO_REMOTE_DIR)

    files = glob.glob(os.path.join(PROCESSED_DIR, "*.json"))
    for local_path in files:
        filename = os.path.basename(local_path)
        if prefix and not filename.startswith(prefix + "_"):
            filename = f"{prefix}_{filename}"
        sftp.put(local_path, f"{FORELLANDO_REMOTE_DIR}/{filename}")

    sftp.close()
    transport.close()
    return len(files)


# ----------------------------------------------------------------------
# Display helpers
# ----------------------------------------------------------------------
def list_recordings():
    csv_files = sorted(glob.glob(os.path.join(DATASET_DIR, "*.csv")), reverse=True)
    recordings = []
    for csv_path in csv_files:
        rec_id = os.path.splitext(os.path.basename(csv_path))[0]
        recordings.append({
            "id": rec_id,
            "csv": csv_path,
            "wav": os.path.join(DATASET_DIR, rec_id + ".wav"),
            "mp4": os.path.join(DATASET_DIR, rec_id + ".mp4"),
            "processed": os.path.join(PROCESSED_DIR, rec_id + ".json"),
        })
    return recordings


def load_processed(rec):
    if os.path.exists(rec["processed"]):
        with open(rec["processed"]) as f:
            return json.load(f)
    return None


def level_of(rec_id):
    """Extract the level from 'normal_1783508510' -> 'normal'."""
    prefix = rec_id.split("_")[0].lower()
    return prefix if prefix in RESEARCH_LEVELS else None


def build_summary_table():
    """Collect one row per processed recording. Returns a DataFrame."""
    rows = []
    for rec in list_recordings():
        processed = load_processed(rec)
        if not processed:
            continue
        agg = processed.get("aggregates", {})
        sp = agg.get("soundPressure", {}) or {}
        fs = agg.get("footSpeed", {}) or {}
        mo = agg.get("mouthOpening", {}) or {}
        rows.append({
            "id": rec["id"],
            "level": level_of(rec["id"]),
            "mean_dB": sp.get("mean"),
            "max_footSpeed": fs.get("max"),
            "mean_mouthOpening": mo.get("mean"),
            "stepCount": agg.get("stepCount"),
        })
    return pd.DataFrame(rows)


# ----------------------------------------------------------------------
# Sidebar
# ----------------------------------------------------------------------
st.sidebar.header("Pi connection")
pi_host = st.sidebar.text_input("Pi host", value="pi008.local")
pi_user = st.sidebar.text_input("Pi username", value="rayanmara")
pi_password = st.sidebar.text_input("Pi password", type="password", key="pi_pw")

st.sidebar.divider()
st.sidebar.header("Record new sample")
label_input = st.sidebar.text_input(
    "Label (must be normal / medium / big for the summary)",
    value="normal",
)

if st.sidebar.button("Record on Pi + process here"):
    if not pi_password:
        st.sidebar.error("Enter the Pi password first.")
    else:
        try:
            with st.spinner("Recording on Pi (5s)..."):
                rec_id = record_on_pi(pi_host, pi_user, pi_password, label_input)
            with st.spinner("Processing soundPressure + footSpeed + mouthOpening..."):
                process_recording(rec_id)
            st.sidebar.success(f"Done: {rec_id} - all 3 signals processed.")
        except Exception as e:
            st.sidebar.error(f"Failed: {e}")

if st.sidebar.button("Sync all recordings from Pi"):
    if not pi_password:
        st.sidebar.error("Enter the Pi password first.")
    else:
        try:
            with st.spinner("Pulling recordings from Pi..."):
                count = sync_all_from_pi(pi_host, pi_user, pi_password)
            st.sidebar.success(f"Pulled {count} new file(s).")
        except Exception as e:
            st.sidebar.error(f"Sync failed: {e}")

st.sidebar.divider()
st.sidebar.header("Upload processed data to forellando")
st.sidebar.caption("Optional - stores results on the class server.")
forellando_user = st.sidebar.text_input("Forellando username", value="")
forellando_password = st.sidebar.text_input("Forellando password", type="password", key="fo_pw")
group_prefix = st.sidebar.text_input(
    "Your group prefix",
    value="rayanmara",
    help="Added to each filename so your files don't collide with other groups'.",
)

if st.sidebar.button("Upload now"):
    if not forellando_user or not forellando_password:
        st.sidebar.error("Enter forellando username and password first.")
    else:
        try:
            with st.spinner("Uploading..."):
                count = upload_processed_to_forellando(
                    forellando_user, forellando_password, group_prefix
                )
            st.sidebar.success(f"Uploaded {count} file(s) to forellando.")
        except Exception as e:
            st.sidebar.error(f"Upload failed: {e}")


# ----------------------------------------------------------------------
# Main area
# ----------------------------------------------------------------------
st.title("Multi-Modal Sensor Dashboard")

# ---------- Research Summary (only shown if there is data) ------------
df = build_summary_table()

if not df.empty:
    st.header("Research Summary")

    # 1. Full table of all recordings
    st.markdown("**All recordings**")
    st.dataframe(df, width="stretch")

    # 2. Averages per level (only for rows whose label is in normal/medium/big)
    leveled = df[df["level"].isin(RESEARCH_LEVELS)]

    if not leveled.empty:
        # Reindex so bars always come out in normal -> medium -> big order
        avg = leveled.groupby("level")[
            ["mean_dB", "max_footSpeed", "mean_mouthOpening"]
        ].mean().reindex(RESEARCH_LEVELS).dropna(how="all")

        st.markdown("**Averages by intensity level**")
        st.dataframe(avg.round(3), width="stretch")
        st.bar_chart(avg)

        # 3. Auto conclusion comparing big vs normal
        st.markdown("**Conclusion**")
        if "normal" in avg.index and "big" in avg.index:
            n = avg.loc["normal"]
            b = avg.loc["big"]

            def times(from_val, to_val):
                if from_val is None or to_val is None:
                    return None
                # dB is on a log scale and lives in negatives, so
                # multiplying-by isn't the right frame. We report the
                # dB DIFFERENCE for sound, and multiplicative for the
                # others (which are on linear scales starting near 0).
                return None

            bullets = []
            if pd.notna(n["mean_dB"]) and pd.notna(b["mean_dB"]):
                diff = b["mean_dB"] - n["mean_dB"]
                bullets.append(
                    f"- Voice went from {n['mean_dB']:.1f} dB (normal) to {b['mean_dB']:.1f} dB (big) — "
                    f"**{diff:+.1f} dB louder** on average."
                )
            if pd.notna(n["max_footSpeed"]) and pd.notna(b["max_footSpeed"]) and n["max_footSpeed"] > 0:
                factor = b["max_footSpeed"] / n["max_footSpeed"]
                bullets.append(
                    f"- Peak foot movement grew from {n['max_footSpeed']:.2f} to {b['max_footSpeed']:.2f} — "
                    f"**{factor:.1f}× bigger** in the big level."
                )
            if pd.notna(n["mean_mouthOpening"]) and pd.notna(b["mean_mouthOpening"]) and n["mean_mouthOpening"] > 0:
                factor = b["mean_mouthOpening"] / n["mean_mouthOpening"]
                bullets.append(
                    f"- Mouth opening grew from {n['mean_mouthOpening']:.3f} to {b['mean_mouthOpening']:.3f} — "
                    f"**{factor:.1f}× more open**."
                )

            if bullets:
                st.markdown("\n".join(bullets))
                st.caption(
                    "Interpretation: if all three signals scale together with action intensity, "
                    "our three sensors are picking up the same underlying effect from independent "
                    "modalities (audio, motion, vision) — validating the multi-modal setup."
                )
            else:
                st.info("Not enough averages to draw a conclusion yet.")
        else:
            missing = [lvl for lvl in ("normal", "big") if lvl not in avg.index]
            st.info(
                f"Need recordings labelled: {', '.join(missing)} to build the full conclusion. "
                "Record more samples with those exact labels."
            )
    else:
        st.info(
            "No recordings match the research levels (normal / medium / big) yet. "
            "Use those exact labels when recording to see the summary."
        )

    st.divider()

# ---------- Per-recording details -------------------------------------
recordings = list_recordings()
if not recordings:
    st.info("No recordings yet. Use the sidebar to record your first sample.")
else:
    st.header(f"All recordings ({len(recordings)})")

    for rec in recordings:
        with st.expander(rec["id"], expanded=False):
            processed = load_processed(rec)
            raw_col, proc_col = st.columns(2)

            with raw_col:
                st.subheader("Raw")
                if os.path.exists(rec["csv"]):
                    df_raw = pd.read_csv(rec["csv"])
                    accel_cols = [c for c in ["accel_x", "accel_y", "accel_z"] if c in df_raw.columns]
                    if accel_cols:
                        st.line_chart(df_raw.set_index("time_offset")[accel_cols])
                if os.path.exists(rec["wav"]):
                    st.audio(rec["wav"])
                if os.path.exists(rec["mp4"]):
                    st.video(rec["mp4"])

            with proc_col:
                st.subheader("Processed")
                if not processed:
                    st.warning("Not processed yet.")
                else:
                    agg = processed.get("aggregates", {})

                    if "soundPressure" in processed:
                        st.markdown("**Sound Pressure (relative dB)**")
                        st.line_chart(processed["soundPressure"]["values"])
                        sp_agg = agg.get("soundPressure", {})
                        m1, m2, m3 = st.columns(3)
                        m1.metric("Mean dB", sp_agg.get("mean", "-"))
                        m2.metric("Max dB", sp_agg.get("max", "-"))
                        m3.metric("Min dB", sp_agg.get("min", "-"))

                    if "footSpeed" in processed:
                        st.markdown("**Foot Speed (relative proxy)**")
                        st.line_chart(processed["footSpeed"]["values"])
                        fs_agg = agg.get("footSpeed", {})
                        m1, m2, m3, m4 = st.columns(4)
                        m1.metric("Mean m/s", fs_agg.get("mean", "-"))
                        m2.metric("Max m/s", fs_agg.get("max", "-"))
                        m3.metric("Steps", agg.get("stepCount", "-"))
                        lengths = agg.get("stepLengths", [])
                        avg_len = round(sum(lengths) / len(lengths), 3) if lengths else "-"
                        m4.metric("Avg step len", avg_len)

                    if "mouthOpening" in processed:
                        st.markdown("**Mouth Opening (ratio)**")
                        mo_values = processed["mouthOpening"]["values"]
                        clean = [v for v in mo_values if v is not None]
                        detected_pct = round(100 * len(clean) / len(mo_values)) if mo_values else 0
                        if clean:
                            st.line_chart(clean)
                        mo_agg = agg.get("mouthOpening", {})
                        m1, m2, m3 = st.columns(3)
                        m1.metric("Face detected", f"{detected_pct}%")
                        m2.metric("Mean ratio", mo_agg.get("mean", "-"))
                        m3.metric("Max ratio", mo_agg.get("max", "-"))