#!/usr/bin/env python3
"""waves · streaming server (aiohttp + sqlite3) — PROTOCOL v2.

Implements the frozen contract in PROTOCOL.md:
  - WebSocket /ingest  (producer / Pi)     — live motion/audio JSON + BINARY JPEG video frames
  - WebSocket /live    (viewer / dashboard) — control + motion/audio fanout
  - REST /api/*        (bulk upload + queries + live/recorded MJPEG)
  - serves the built dashboard from dist/ at GET /

v2 highlights:
  * Live video via MJPEG (no periodic stills). The producer streams JPEG frames continuously;
    the server relays the latest frame as a live MJPEG stream and records each *session* to disk.
  * The Pi is a stateless follower: sessions are created ONLY by a viewer (the dashboard).
  * The producer streams continuously; the server persists that stream only while a session is active.

All sqlite/file access runs OFF the event loop in a single-thread executor, serialized by a lock.

Stdlib + aiohttp only. Python 3.11+ (also runs on 3.14).
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import io
import json
import os
import shutil
import struct
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from aiohttp import WSMsgType, web

# --------------------------------------------------------------------------- #
# SQLite schema (PROTOCOL §5 — verbatim; v2: no frames table, video columns added)
# --------------------------------------------------------------------------- #

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT NOT NULL,
  name          TEXT,
  device        TEXT,
  started_at    REAL NOT NULL,
  ended_at      REAL,
  duration      REAL,
  status        TEXT NOT NULL DEFAULT 'recording',
  reading_count INTEGER NOT NULL DEFAULT 0,
  audio_path    TEXT,
  audio_rate    INTEGER,
  video_path    TEXT,
  video_fps     INTEGER,
  poster_path   TEXT,
  notes         TEXT
);
CREATE TABLE IF NOT EXISTS readings (
  session_id INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  t          REAL NOT NULL,
  ax REAL, ay REAL, az REAL,
  gx REAL, gy REAL, gz REAL,
  db REAL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
"""

MAX_MOTION_PTS = 220
MAX_AUDIO_PTS = 480
DEFAULT_VIDEO_FPS = 12


# --------------------------------------------------------------------------- #
# Small pure helpers
# --------------------------------------------------------------------------- #

def stride_indices(n: int, maxp: int):
    """Evenly spaced indices into a sequence of length n, at most maxp of them."""
    if n <= 0:
        return []
    if n <= maxp:
        return list(range(n))
    step = n / maxp
    return [int(k * step) for k in range(maxp)]


def peak_downsample(vals, maxp: int):
    """Downsample preserving envelope: keep the max-abs sample of each bucket."""
    n = len(vals)
    if n <= maxp:
        return [float(v) for v in vals]
    out = []
    for b in range(maxp):
        s = b * n // maxp
        e = (b + 1) * n // maxp
        if e <= s:
            e = s + 1
        chunk = vals[s:e]
        m = chunk[0]
        am = abs(m)
        for v in chunk:
            if abs(v) > am:
                m = v
                am = abs(v)
        out.append(float(m))
    return out


def decode_wav_envelope(path: str, maxp: int = MAX_AUDIO_PTS):
    """Decode a stored WAV to <=maxp samples normalised to [-1, 1].

    WAV PCM is little-endian by spec, so int16 frames are unpacked explicitly as
    little-endian regardless of the host's native byte order.
    """
    with wave.open(path, "rb") as w:
        nch = w.getnchannels() or 1
        sw = w.getsampwidth()
        nf = w.getnframes()
        raw = w.readframes(nf)
    if sw == 2:
        count = len(raw) // 2
        vals = list(struct.unpack("<%dh" % count, raw[: count * 2])) if count else []
        if nch > 1:
            vals = vals[0::nch]
        vals = [x / 32768.0 for x in vals]
    elif sw == 1:
        # 8-bit PCM is unsigned; no endianness to worry about.
        samples = list(raw)
        if nch > 1:
            samples = samples[0::nch]
        vals = [(x - 128) / 128.0 for x in samples]
    else:
        # uncommon widths: read explicitly little-endian signed, normalise by full scale
        step = sw * nch
        full = float(1 << (8 * sw - 1))
        vals = []
        for off in range(0, len(raw) - sw + 1, step):
            v = int.from_bytes(raw[off:off + sw], "little", signed=True)
            vals.append(v / full)
    return peak_downsample(vals, maxp)


def db_envelope(db_values, maxp: int = MAX_AUDIO_PTS):
    """Fallback audio shape from per-reading dBFS.

    Linear amplitude is magnitude-only, so it is rendered as a symmetric, bipolar
    waveform in [-1, 1] to match the decoded-WAV path (PROTOCOL §4: "≤480 pts in
    [-1,1]"), instead of a one-sided [0, 1] envelope.
    """
    amps = []
    for d in db_values:
        if d is None:
            amps.append(0.0)
        else:
            try:
                amp = 10.0 ** (float(d) / 20.0)
            except Exception:
                amp = 0.0
            amps.append(min(1.0, max(0.0, amp)))
    if not amps:
        return []
    env = peak_downsample(amps, maxp)
    return [v if i % 2 == 0 else -v for i, v in enumerate(env)]


def mjpeg_part(jpeg: bytes) -> bytes:
    """One multipart/x-mixed-replace part (boundary 'frame') for a JPEG payload."""
    return (
        b"--frame\r\n"
        b"Content-Type: image/jpeg\r\n"
        b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n"
        + jpeg + b"\r\n"
    )


# --------------------------------------------------------------------------- #
# DB / blocking I/O — everything below runs in the single-thread db_executor,
# serialized by app["db_lock"]; nothing here is awaited on the event loop.
# --------------------------------------------------------------------------- #

def db_init(app):
    import sqlite3

    data_dir: Path = app["data_dir"]
    data_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(data_dir / "waves.db"), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    # v1 → v2 migration: additively add the video columns to a pre-existing db and
    # drop the retired frames table. Guarded so a fresh db is untouched.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(sessions)").fetchall()}
    for name, decl in (("video_path", "TEXT"), ("video_fps", "INTEGER"),
                       ("poster_path", "TEXT")):
        if name not in cols:
            conn.execute(f"ALTER TABLE sessions ADD COLUMN {name} {decl}")
    conn.execute("DROP TABLE IF EXISTS frames")
    conn.commit()
    app["db"] = conn
    app["db_lock"] = threading.Lock()


async def run_blocking(app, fn, *args):
    """Run a blocking sqlite/file function off the event loop in the dedicated
    single-thread DB executor. `fn` receives `app` and manages its own db_lock."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(app["db_executor"], fn, app, *args)


def build_session(row):
    """Build the canonical session object (PROTOCOL §4) from a sessions row. Pure."""
    if row is None:
        return None
    return {
        "id": row["id"],
        "label": row["label"],
        "name": row["name"],
        "device": row["device"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "duration": row["duration"],
        "status": row["status"],
        "reading_count": row["reading_count"],
        "audio_rate": row["audio_rate"],
        "has_audio": row["audio_path"] is not None,
        "has_video": row["video_path"] is not None,
        "video_fps": row["video_fps"],
        "notes": row["notes"],
    }


def _session_row(app, sid):
    with app["db_lock"]:
        return app["db"].execute(
            "SELECT * FROM sessions WHERE id=?", (sid,)
        ).fetchone()


def _insert_session(app, label, name, device, started, dur_store, audio_rate):
    with app["db_lock"]:
        cur = app["db"].execute(
            "INSERT INTO sessions(label,name,device,started_at,ended_at,duration,"
            "status,reading_count,audio_path,audio_rate,video_path,video_fps,"
            "poster_path,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (label, name, device, started, None, dur_store, "recording", 0,
             None, audio_rate, None, None, None, None),
        )
        app["db"].commit()
        return cur.lastrowid


def _finalize(app, sid, status, ended):
    with app["db_lock"]:
        app["db"].execute(
            "UPDATE sessions SET status=?, ended_at=?, "
            "reading_count=(SELECT COUNT(*) FROM readings WHERE session_id=?) "
            "WHERE id=?",
            (status, ended, sid, sid),
        )
        app["db"].commit()


def _insert_readings(app, rows, sid, n):
    with app["db_lock"]:
        conn = app["db"]
        conn.executemany(
            "INSERT OR REPLACE INTO readings"
            "(session_id,seq,t,ax,ay,az,gx,gy,gz,db) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
        conn.execute(
            "UPDATE sessions SET reading_count=reading_count+? WHERE id=?",
            (n, sid),
        )
        conn.commit()


def _set_video_meta(app, sid, video_rel, fps, poster_rel):
    with app["db_lock"]:
        app["db"].execute(
            "UPDATE sessions SET video_path=?, video_fps=?, poster_path=? WHERE id=?",
            (video_rel, fps, poster_rel, sid),
        )
        app["db"].commit()


def _media_row(app, sid):
    with app["db_lock"]:
        return app["db"].execute(
            "SELECT audio_path, video_path, video_fps, poster_path "
            "FROM sessions WHERE id=?", (sid,)
        ).fetchone()


def _list_sessions(app):
    with app["db_lock"]:
        rows = app["db"].execute(
            "SELECT * FROM sessions ORDER BY started_at DESC, id DESC"
        ).fetchall()
    return {"sessions": [build_session(r) for r in rows]}


def _session_detail(app, sid):
    with app["db_lock"]:
        srow = app["db"].execute(
            "SELECT * FROM sessions WHERE id=?", (sid,)
        ).fetchone()
        if srow is None:
            return None
        rrows = app["db"].execute(
            "SELECT t,ax,ay,az,gx,gy,gz,db FROM readings "
            "WHERE session_id=? ORDER BY seq", (sid,)
        ).fetchall()
    audio_path = srow["audio_path"]
    sess = build_session(srow)

    idx = stride_indices(len(rrows), MAX_MOTION_PTS)
    motion = {k: [] for k in ("t", "ax", "ay", "az", "gx", "gy", "gz")}
    for i in idx:
        r = rrows[i]
        motion["t"].append(r["t"])
        motion["ax"].append(r["ax"])
        motion["ay"].append(r["ay"])
        motion["az"].append(r["az"])
        motion["gx"].append(r["gx"])
        motion["gy"].append(r["gy"])
        motion["gz"].append(r["gz"])

    wav_full = (app["data_dir"] / audio_path) if audio_path else None
    if wav_full is not None and wav_full.exists():
        try:
            audio = decode_wav_envelope(str(wav_full), MAX_AUDIO_PTS)
        except Exception:
            audio = db_envelope([r["db"] for r in rrows], MAX_AUDIO_PTS)
    else:
        audio = db_envelope([r["db"] for r in rrows], MAX_AUDIO_PTS)

    return {"session": sess, "motion": motion, "audio": audio}


def _export_csv(app, sid):
    with app["db_lock"]:
        srow = app["db"].execute(
            "SELECT id FROM sessions WHERE id=?", (sid,)
        ).fetchone()
        if srow is None:
            return None
        rows = app["db"].execute(
            "SELECT t,ax,ay,az,gx,gy,gz,db FROM readings "
            "WHERE session_id=? ORDER BY seq", (sid,)
        ).fetchall()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["t", "ax", "ay", "az", "gx", "gy", "gz", "db"])
    for r in rows:
        writer.writerow([r["t"], r["ax"], r["ay"], r["az"],
                         r["gx"], r["gy"], r["gz"], r["db"]])
    return buf.getvalue()


def _store_audio(app, sid, body):
    with app["db_lock"]:
        exists = app["db"].execute(
            "SELECT id FROM sessions WHERE id=?", (sid,)
        ).fetchone()
    if exists is None:
        return False
    rel = f"sessions/{sid}/audio.wav"
    full = app["data_dir"] / rel
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(body)
    rate = None
    try:
        with wave.open(str(full), "rb") as w:
            rate = w.getframerate()
    except Exception:
        rate = None
    with app["db_lock"]:
        app["db"].execute(
            "UPDATE sessions SET audio_path=?, audio_rate=? WHERE id=?",
            (rel, rate, sid),
        )
        app["db"].commit()
    return True


def _delete_session(app, sid):
    with app["db_lock"]:
        row = app["db"].execute(
            "SELECT id FROM sessions WHERE id=?", (sid,)
        ).fetchone()
        if row is None:
            return False
        app["db"].execute("DELETE FROM sessions WHERE id=?", (sid,))
        app["db"].commit()
    shutil.rmtree(app["data_dir"] / "sessions" / str(sid), ignore_errors=True)
    return True


async def session_object(app, sid):
    if sid is None:
        return None
    row = await run_blocking(app, _session_row, sid)
    return build_session(row)


# --------------------------------------------------------------------------- #
# WebSocket send / broadcast helpers
# --------------------------------------------------------------------------- #

async def safe_send_json(ws, obj):
    try:
        await ws.send_json(obj)
    except Exception:
        pass


async def safe_send_str(ws, text):
    try:
        await ws.send_str(text)
    except Exception:
        pass


async def send_error(ws, error, detail=""):
    await safe_send_json(ws, {"type": "error", "error": error, "detail": detail})


async def broadcast_all(app, obj):
    for ws in list(app["producers"]) + list(app["viewers"]):
        await safe_send_json(ws, obj)


async def broadcast_text(targets, text):
    for ws in list(targets):
        await safe_send_str(ws, text)


async def broadcast_producer_status(app):
    obj = {"type": "producer_status", "producers": len(app["producers"])}
    for ws in list(app["viewers"]):
        await safe_send_json(ws, obj)


async def send_welcome(app, ws, role):
    sess = await session_object(app, app["rt"]["active"])
    msg = {"type": "welcome", "active_session": sess}
    if role == "viewer":
        msg["producers"] = len(app["producers"])
    await safe_send_json(ws, msg)


def producer_video_fps(app, default=DEFAULT_VIDEO_FPS):
    """The declared video_fps of a connected producer (max if several); used to
    cap the live MJPEG output rate. Falls back to the default if none declared."""
    best = None
    for ws in list(app["producers"]):
        fps = getattr(ws, "client_video_fps", None)
        if fps:
            best = fps if best is None else max(best, fps)
    return best or default


# --------------------------------------------------------------------------- #
# Session lifecycle (created ONLY by viewers — PROTOCOL §3)
# --------------------------------------------------------------------------- #

def _clear_active_runtime(app):
    """Close the open recording video file and reset per-session runtime state."""
    vf = app["rt"].get("video_file")
    if vf is not None:
        try:
            vf.close()
        except Exception:
            pass
    app["rt"]["video_file"] = None
    app["rt"]["video_rel"] = None
    app["rt"]["video_count"] = 0
    app["rt"]["video_fps"] = None
    app["rt"]["active"] = None
    app["rt"]["t0"] = None
    app["rt"]["seq"] = 0


async def handle_start(app, ws, data):
    if app["rt"]["active"] is not None:
        await send_error(ws, "session_active", "a session is already active")
        return

    label = data.get("label") or "unlabeled"
    name = data.get("name")
    duration = data.get("duration")
    dur_store = duration if duration not in (None, 0) else None

    # device / audio_rate / video_fps come from a connected producer's hello.
    src = next(iter(app["producers"])) if app["producers"] else None
    device = getattr(src, "client_device", None) if src is not None else None
    audio_rate = getattr(src, "client_audio_rate", None) if src is not None else None

    started = time.time()
    sid = await run_blocking(
        app, _insert_session, label, name, device, started, dur_store, audio_rate
    )

    app["rt"]["active"] = sid
    app["rt"]["t0"] = None
    app["rt"]["seq"] = 0
    app["rt"]["video_count"] = 0
    app["rt"]["video_fps"] = getattr(src, "client_video_fps", None) if src else None

    rel = f"sessions/{sid}/video.mjpeg"
    full = app["data_dir"] / rel
    try:
        full.parent.mkdir(parents=True, exist_ok=True)
        app["rt"]["video_file"] = open(full, "wb")
        app["rt"]["video_rel"] = rel
    except Exception:
        app["rt"]["video_file"] = None
        app["rt"]["video_rel"] = None

    sess = await session_object(app, sid)
    await broadcast_all(app, {"type": "session_started", "session": sess})

    # non-fatal warning to the initiating viewer if nothing is streaming.
    if src is None:
        await send_error(ws, "no_producer",
                         "no producer connected; recording with no live source")

    if duration and duration > 0:
        app["rt"]["autostop"] = asyncio.create_task(
            auto_stop(app, sid, float(duration))
        )


async def finalize_session(app, sid, status="done"):
    ended = time.time()
    # close + flush the recording before we update the db and announce the stop,
    # so the recorded video.mjpeg is fully on disk for any immediate playback.
    if app["rt"]["active"] == sid:
        _clear_active_runtime(app)
    await run_blocking(app, _finalize, sid, status, ended)

    task = app["rt"].get("autostop")
    if task is not None and task is not asyncio.current_task():
        task.cancel()
    app["rt"]["autostop"] = None

    sess = await session_object(app, sid)
    await broadcast_all(app, {"type": "session_stopped", "session": sess})


async def handle_stop(app, ws, data):
    sid = data.get("session_id")
    if app["rt"]["active"] is None or (sid is not None and sid != app["rt"]["active"]):
        await send_error(ws, "no_active_session", "no matching active session")
        return
    await finalize_session(app, app["rt"]["active"])


async def auto_stop(app, sid, delay):
    try:
        await asyncio.sleep(delay)
    except asyncio.CancelledError:
        return
    if app["rt"]["active"] == sid:
        await finalize_session(app, sid)


async def handle_readings(app, ws, data, raw):
    """Persist motion (rebased + seq-assigned) while a session is active, and ALWAYS
    fan readings out verbatim to viewers for the always-on live preview."""
    active = app["rt"]["active"]
    motion = data.get("motion") or []
    db = data.get("db")

    if active is not None and motion:
        # t0 = ts of the first reading observed after the session became active.
        if app["rt"]["t0"] is None:
            try:
                app["rt"]["t0"] = float(motion[0][0])
            except Exception:
                app["rt"]["t0"] = 0.0
        t0 = app["rt"]["t0"]
        seq = app["rt"]["seq"]
        rows = []
        for m in motion:
            mm = list(m) + [None] * 7
            try:
                ts = float(mm[0])
            except Exception:
                ts = t0
            rows.append((active, seq, ts - t0,
                         mm[1], mm[2], mm[3], mm[4], mm[5], mm[6], db))
            seq += 1
        app["rt"]["seq"] = seq
        await run_blocking(app, _insert_readings, rows, active, len(rows))

    await broadcast_text(app["viewers"], raw)


# --------------------------------------------------------------------------- #
# WebSocket endpoints
# --------------------------------------------------------------------------- #

async def handle_producer_binary(app, ws, jpeg):
    """A BINARY frame on /ingest is a raw JPEG video frame (PROTOCOL §1)."""
    if not jpeg:
        return

    # 1) record into the active session's length-prefixed container (synchronous
    #    write — no await between the active-check and the write).
    active = app["rt"]["active"]
    vf = app["rt"].get("video_file")
    if active is not None and vf is not None:
        first = app["rt"]["video_count"] == 0
        try:
            vf.write(len(jpeg).to_bytes(4, "big"))
            vf.write(jpeg)
            app["rt"]["video_count"] += 1
        except Exception:
            pass
        if first:
            poster_rel = f"sessions/{active}/poster.jpg"
            try:
                (app["data_dir"] / poster_rel).write_bytes(jpeg)
            except Exception:
                poster_rel = None
            fps = getattr(ws, "client_video_fps", None)
            await run_blocking(app, _set_video_meta, active,
                               app["rt"].get("video_rel"), fps, poster_rel)

    # 2) publish to the always-on live relay (independent of any session).
    app["rt"]["latest_frame"] = jpeg
    cond = app["frame_cond"]
    async with cond:
        app["rt"]["frame_seq"] += 1
        cond.notify_all()


async def handle_producer_message(app, ws, raw):
    try:
        data = json.loads(raw)
    except Exception:
        await send_error(ws, "bad_message", "invalid json")
        return
    if not isinstance(data, dict) or "type" not in data:
        await send_error(ws, "bad_message", "missing type")
        return

    t = data["type"]
    if t == "hello":
        ws.client_device = data.get("device")
        ws.client_audio_rate = data.get("audio_rate")
        ws.client_video_fps = data.get("video_fps")
        await send_welcome(app, ws, "producer")
    elif t == "readings":
        await handle_readings(app, ws, data, raw)
    elif t in ("start_session", "stop_session"):
        # Producers are stateless followers and never control sessions (PROTOCOL §1).
        await send_error(ws, "bad_message", "producers do not control sessions")
    elif t == "bye":
        await ws.close()
    else:
        await send_error(ws, "bad_message", f"unknown type {t!r}")


async def ingest_handler(request):
    app = request.app
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=0)
    await ws.prepare(request)
    ws.client_role = "producer"
    ws.client_device = None
    ws.client_audio_rate = None
    ws.client_video_fps = None
    app["producers"].add(ws)
    await broadcast_producer_status(app)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                await handle_producer_message(app, ws, msg.data)
            elif msg.type == WSMsgType.BINARY:
                await handle_producer_binary(app, ws, msg.data)
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        app["producers"].discard(ws)
        await broadcast_producer_status(app)
        # NB: a producer leaving does NOT end the active session — the dashboard
        # owns sessions, and the producer may reconnect (PROTOCOL §6 reconnection).
    return ws


async def handle_viewer_message(app, ws, raw):
    try:
        data = json.loads(raw)
    except Exception:
        await send_error(ws, "bad_message", "invalid json")
        return
    if not isinstance(data, dict) or "type" not in data:
        await send_error(ws, "bad_message", "missing type")
        return

    t = data["type"]
    if t == "hello":
        await send_welcome(app, ws, "viewer")
    elif t == "start_session":
        await handle_start(app, ws, data)
    elif t == "stop_session":
        await handle_stop(app, ws, data)
    elif t == "bye":
        await ws.close()
    else:
        await send_error(ws, "bad_message", f"unknown type {t!r}")


async def live_handler(request):
    app = request.app
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=0)
    await ws.prepare(request)
    ws.client_role = "viewer"
    app["viewers"].add(ws)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                await handle_viewer_message(app, ws, msg.data)
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        app["viewers"].discard(ws)
    return ws


# --------------------------------------------------------------------------- #
# REST helpers
# --------------------------------------------------------------------------- #

def json_404(detail="not found"):
    return web.json_response({"error": "not_found", "detail": detail}, status=404)


# --------------------------------------------------------------------------- #
# REST: uploads (PROTOCOL §2)
# --------------------------------------------------------------------------- #

async def post_audio(request):
    app = request.app
    sid = int(request.match_info["id"])
    body = await request.read()
    ok = await run_blocking(app, _store_audio, sid, body)
    if not ok:
        return json_404(f"session {sid} not found")
    return web.json_response({"ok": True})


# --------------------------------------------------------------------------- #
# REST: queries (PROTOCOL §4)
# --------------------------------------------------------------------------- #

async def get_sessions(request):
    payload = await run_blocking(request.app, _list_sessions)
    return web.json_response(payload)


async def get_session(request):
    sid = int(request.match_info["id"])
    payload = await run_blocking(request.app, _session_detail, sid)
    if payload is None:
        return json_404(f"session {sid} not found")
    return web.json_response(payload)


async def get_export(request):
    sid = int(request.match_info["id"])
    text = await run_blocking(request.app, _export_csv, sid)
    if text is None:
        return json_404(f"session {sid} not found")
    return web.Response(
        text=text,
        content_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="session_{sid}.csv"'},
    )


async def get_audio(request):
    app = request.app
    sid = int(request.match_info["id"])
    row = await run_blocking(app, _media_row, sid)
    if row is None or row["audio_path"] is None:
        return json_404("no audio for this session")
    full = app["data_dir"] / row["audio_path"]
    if not full.exists():
        return json_404("audio file missing")
    return web.FileResponse(full, headers={"Content-Type": "audio/wav"})


# --------------------------------------------------------------------------- #
# REST: live + recorded MJPEG (PROTOCOL §4 / §5)
# --------------------------------------------------------------------------- #

async def get_stream_mjpeg(request):
    """LIVE multipart/x-mixed-replace MJPEG from the latest pushed frame.

    Available whenever a producer is streaming video — independent of sessions.
    Waits (does not 500) until the first frame arrives; output rate is capped to
    the producer's declared video_fps.
    """
    app = request.app
    cond = app["frame_cond"]
    fps_cap = producer_video_fps(app)
    min_interval = 1.0 / max(1.0, float(fps_cap))

    resp = web.StreamResponse(status=200, headers={
        "Content-Type": "multipart/x-mixed-replace; boundary=frame",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Access-Control-Allow-Origin": "*",
    })
    await resp.prepare(request)

    last_seq = -1
    try:
        while True:
            async with cond:
                await cond.wait_for(
                    lambda: app["rt"]["frame_seq"] != last_seq
                    and app["rt"]["latest_frame"] is not None
                )
                frame = app["rt"]["latest_frame"]
                last_seq = app["rt"]["frame_seq"]
            await resp.write(mjpeg_part(frame))
            await asyncio.sleep(min_interval)
    except (asyncio.CancelledError, ConnectionResetError, RuntimeError):
        # client disconnected — nothing to clean up beyond returning.
        pass
    return resp


async def get_video_mjpeg(request):
    """The RECORDED session video, re-streamed as multipart/x-mixed-replace,
    paced at its stored video_fps, played through once. 404 if none."""
    app = request.app
    sid = int(request.match_info["id"])
    row = await run_blocking(app, _media_row, sid)
    if row is None or row["video_path"] is None:
        return json_404("no video for this session")
    full = app["data_dir"] / row["video_path"]
    if not full.exists():
        return json_404("video file missing")
    fps = row["video_fps"] or DEFAULT_VIDEO_FPS
    interval = 1.0 / max(1.0, float(fps))

    resp = web.StreamResponse(status=200, headers={
        "Content-Type": "multipart/x-mixed-replace; boundary=frame",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Access-Control-Allow-Origin": "*",
    })
    await resp.prepare(request)

    try:
        with open(full, "rb") as f:
            while True:
                hdr = f.read(4)
                if len(hdr) < 4:
                    break
                n = int.from_bytes(hdr, "big")
                jpeg = f.read(n)
                if len(jpeg) < n:
                    break
                await resp.write(mjpeg_part(jpeg))
                await asyncio.sleep(interval)
    except (asyncio.CancelledError, ConnectionResetError, RuntimeError):
        pass
    return resp


async def get_poster(request):
    app = request.app
    sid = int(request.match_info["id"])
    row = await run_blocking(app, _media_row, sid)
    if row is None or row["poster_path"] is None:
        return json_404("no poster for this session")
    full = app["data_dir"] / row["poster_path"]
    if not full.exists():
        return json_404("poster file missing")
    return web.FileResponse(full, headers={"Content-Type": "image/jpeg"})


async def delete_session(request):
    app = request.app
    sid = int(request.match_info["id"])
    # if we're deleting the active session, tear down its runtime first.
    if app["rt"]["active"] == sid:
        _clear_active_runtime(app)
        task = app["rt"].get("autostop")
        if task is not None and task is not asyncio.current_task():
            task.cancel()
        app["rt"]["autostop"] = None
    ok = await run_blocking(app, _delete_session, sid)
    if not ok:
        return json_404(f"session {sid} not found")
    return web.json_response({"ok": True})


# --------------------------------------------------------------------------- #
# Static / health
# --------------------------------------------------------------------------- #

async def healthz(request):
    return web.json_response({"ok": True})


async def index_handler(request):
    idx = request.app["dist_dir"] / "index.html"
    if idx.exists():
        return web.FileResponse(idx)
    return web.json_response(
        {"error": "not_found", "detail": "dashboard build (dist/) not present"},
        status=404,
    )


async def favicon_handler(request):
    fav = request.app["dist_dir"] / "favicon.svg"
    if fav.exists():
        return web.FileResponse(fav)
    return json_404("favicon not present")


# --------------------------------------------------------------------------- #
# Middleware: permissive CORS on /api/* (+ OPTIONS preflight)
# --------------------------------------------------------------------------- #

@web.middleware
async def cors_middleware(request, handler):
    is_api = request.path.startswith("/api/")
    if request.method == "OPTIONS" and is_api:
        resp = web.Response(status=204)
    else:
        try:
            resp = await handler(request)
        except web.HTTPException as exc:
            if not is_api:
                raise
            resp = exc
    if is_api:
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "*"
        resp.headers["Access-Control-Max-Age"] = "86400"
    return resp


# --------------------------------------------------------------------------- #
# App assembly
# --------------------------------------------------------------------------- #

def build_app(data_dir: Path, dist_dir: Path):
    app = web.Application(middlewares=[cors_middleware])
    app["data_dir"] = data_dir
    app["dist_dir"] = dist_dir
    app["producers"] = set()
    app["viewers"] = set()
    # runtime-mutable scalar state lives in its own container so we never reassign
    # Application keys after startup (deprecated on aiohttp 3.14+).
    app["rt"] = {
        "active": None, "autostop": None,
        "t0": None, "seq": 0,
        "video_file": None, "video_rel": None, "video_count": 0, "video_fps": None,
        "latest_frame": None, "frame_seq": 0,
    }
    # single-thread executor + lock keep ALL sqlite/file work off the event loop.
    app["db_executor"] = ThreadPoolExecutor(max_workers=1, thread_name_prefix="waves-db")

    db_init(app)

    async def _on_startup(a):
        # create the live-frame condition inside the running loop.
        a["frame_cond"] = asyncio.Condition()

    app.on_startup.append(_on_startup)

    # WebSocket
    app.router.add_get("/ingest", ingest_handler)
    app.router.add_get("/live", live_handler)

    # REST uploads
    app.router.add_post(r"/api/sessions/{id:\d+}/audio", post_audio)

    # REST queries / media (specific suffixes before the generic id route)
    app.router.add_get("/api/stream.mjpeg", get_stream_mjpeg)
    app.router.add_get("/api/sessions", get_sessions)
    app.router.add_get(r"/api/sessions/{id:\d+}/export.csv", get_export)
    app.router.add_get(r"/api/sessions/{id:\d+}/audio.wav", get_audio)
    app.router.add_get(r"/api/sessions/{id:\d+}/video.mjpeg", get_video_mjpeg)
    app.router.add_get(r"/api/sessions/{id:\d+}/poster.jpg", get_poster)
    app.router.add_get(r"/api/sessions/{id:\d+}", get_session)
    app.router.add_delete(r"/api/sessions/{id:\d+}", delete_session)

    # health
    app.router.add_get("/healthz", healthz)

    # static dashboard
    assets = dist_dir / "assets"
    if assets.is_dir():
        app.router.add_static("/assets/", str(assets))
    app.router.add_get("/favicon.svg", favicon_handler)
    app.router.add_get("/", index_handler)

    async def _close_db(a):
        try:
            a["db"].close()
        except Exception:
            pass
        ex = a.get("db_executor")
        if ex is not None:
            ex.shutdown(wait=False)

    app.on_cleanup.append(_close_db)
    return app


def main():
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="waves streaming server")
    parser.add_argument("--host", default=os.environ.get("WAVES_HOST", "0.0.0.0"))
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("WAVES_PORT", "8000"))
    )
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("WAVES_DATA_DIR", str(here / "serverdata")),
    )
    args = parser.parse_args()

    data_dir = Path(args.data_dir).expanduser().resolve()
    dist_dir = (here / "dist")

    app = build_app(data_dir, dist_dir)

    shown = "localhost" if args.host in ("0.0.0.0", "") else args.host
    print(f"waves server listening on http://{args.host}:{args.port}", flush=True)
    print(f"  dashboard : http://{shown}:{args.port}/")
    print(f"  ingest ws : ws://{shown}:{args.port}/ingest")
    print(f"  live   ws : ws://{shown}:{args.port}/live")
    print(f"  rest api  : http://{shown}:{args.port}/api/sessions")
    print(f"  live mjpeg: http://{shown}:{args.port}/api/stream.mjpeg")
    print(f"  data-dir  : {data_dir}")
    print(f"  dist      : {dist_dir} ({'present' if dist_dir.is_dir() else 'absent'})",
          flush=True)

    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
