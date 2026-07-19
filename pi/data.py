#!/usr/bin/env python3
"""waves · Raspberry Pi streaming PRODUCER (data.py) — v2.

A **stateless follower / live streamer** that speaks the frozen wire contract in
PROTOCOL.md (v2):

  - Connects to the server WebSocket  ws://host:8000/ingest  (role: producer).
  - The Pi NEVER creates or owns sessions. Only the dashboard starts/stops them.
    On connect we send a `hello` (caps + motion_hz/audio_rate/video_fps) and then
    stream CONTINUOUSLY for as long as we are connected, whether or not a session
    is recording — this is the always-on live preview.
      * motion: MPU-6050 sampled at --motion-hz (raw -> g via /16384, raw -> °/s
        via /131), batched ~5 `readings` frames/sec. Each row is
        `[ts, ax, ay, az, gx, gy, gz]` with ts = Pi `time.monotonic()` seconds;
        the SERVER rebases ts -> session-relative t when persisting.
      * audio: a dBFS level + a small peak-decimated [-1,1] envelope ride along on
        each `readings` frame.
      * video: JPEG frames at --video-fps pushed as raw BINARY WebSocket frames
        (no JSON, no base64). The server relays them as live MJPEG and records
        them to the active session's video file.
  - SESSIONS only bound the local audio buffer we upload as the session WAV: we
    start buffering on `session_started` (or on connect if `welcome` reports an
    active session), and POST the full WAV to /api/sessions/{id}/audio on
    `session_stopped`. We do NOT need a session to stream; video is recorded
    server-side from the binary frames (never uploaded over REST).
  - Reconnects with exponential backoff; on reconnect it learns the active
    session from the `welcome` reply and resumes WAV buffering. Ctrl-C => send
    `bye`, finish any in-flight WAV upload, exit.

CRITICAL: hardware libraries (picamera2, smbus2, sounddevice) are imported
LAZILY, only on the real-hardware code path. `--simulate` runs on the Python
standard library + `websockets` ALONE (no picamera2/numpy/sounddevice/smbus2): it
synthesises motion/audio and emits a small set of BAKED constant JPEG frames as
binary video, so the full pipeline (live relay + recording + poster + playback)
is exercised hardware-free.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import logging
import math
import os
import random
import signal
import struct
import sys
import tempfile
import threading
import time
import wave
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import websockets  # the ONLY third-party runtime dependency (see requirements-pi.txt)

LOG = logging.getLogger("waves.pi")

# --- contract constants (PROTOCOL.md §"Units") -----------------------------
ACCEL_SCALE = 16384.0   # MPU-6050 raw -> g     (±2 g full scale)
GYRO_SCALE = 131.0      # MPU-6050 raw -> deg/s (±250 °/s full scale)
ACCEL_FS = 2.0          # clamp to full scale, g
GYRO_FS = 250.0         # clamp to full scale, °/s
AUDIO_RATE = 16000      # Hz, mono int16  (PROTOCOL audio_rate)
DB_FLOOR = -60.0        # dBFS clamp floor
ENV_RATE = 480          # target decimated audio samples per second (~96 / batch)
ENV_MAX = 960           # cap env length per readings frame (keeps the socket light)

# MPU-6050 I2C registers (touched only on the real path)
MPU_ADDR = 0x68
PWR_MGMT_1 = 0x6B
ACCEL_XOUT_H = 0x3B
GYRO_XOUT_H = 0x43

# A short loop of real, tiny (64x48) valid JPEGs with a moving white block, baked
# in so --simulate can drive the BINARY video pipeline (live relay + recording +
# poster + playback) with no camera and no image library. Cycled at --video-fps.
_BAKED_JPEG_FRAMES_B64 = [
    "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",
]
BAKED_JPEG_FRAMES = [base64.b64decode(s) for s in _BAKED_JPEG_FRAMES_B64]


# --- url derivation --------------------------------------------------------
def derive_urls(server: str) -> tuple[str, str]:
    """--server base -> (ws .../ingest, http rest base)."""
    server = (server or "ws://localhost:8000").strip()
    if "://" not in server:
        server = "ws://" + server
    u = urlsplit(server)
    scheme = (u.scheme or "ws").lower()
    if scheme in ("https", "wss"):
        ws_s, http_s = "wss", "https"
    else:
        ws_s, http_s = "ws", "http"
    netloc = u.netloc or "localhost:8000"
    return f"{ws_s}://{netloc}/ingest", f"{http_s}://{netloc}"


def parse_size(text: str) -> tuple[int, int]:
    """'640x480' -> (640, 480). Falls back to (640, 480) on bad input."""
    try:
        w, h = str(text).lower().split("x", 1)
        return (max(2, int(w)), max(2, int(h)))
    except Exception:
        return (640, 480)


# --- small numeric helpers (pure stdlib) -----------------------------------
def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def _dbfs(samples) -> float | None:
    """20*log10(rms) over int16 samples, clamped to [DB_FLOOR, 0]. None if empty."""
    n = len(samples)
    if n == 0:
        return None
    acc = 0.0
    for v in samples:
        acc += float(v) * float(v)
    rms = math.sqrt(acc / n) / 32768.0
    if rms <= 1e-9:
        return DB_FLOOR
    return round(_clamp(20.0 * math.log10(rms), DB_FLOOR, 0.0), 1)


def _peak_decimate(samples, count: int) -> list[float]:
    """Peak-decimate int16 samples to `count` signed values in [-1, 1]."""
    n = len(samples)
    if n == 0 or count <= 0:
        return []
    out = []
    for i in range(count):
        lo = (i * n) // count
        hi = ((i + 1) * n) // count
        if hi <= lo:
            hi = lo + 1
        peak = 0
        for j in range(lo, min(hi, n)):
            v = samples[j]
            if abs(v) >= abs(peak):
                peak = v
        out.append(round(peak / 32768.0, 4))
    return out


# --- audio high-pass (rumble removal) --------------------------------------
class _Biquad:
    """One direct-form-I biquad section with persistent state, so a continuous
    stream can be filtered chunk-by-chunk (the sample memory carries across
    drains). Pure stdlib floats — no numpy/scipy dependency."""

    def __init__(self, b0: float, b1: float, b2: float, a1: float, a2: float):
        self.b0, self.b1, self.b2, self.a1, self.a2 = b0, b1, b2, a1, a2
        self.x1 = self.x2 = self.y1 = self.y2 = 0.0

    def process(self, xs):
        b0, b1, b2, a1, a2 = self.b0, self.b1, self.b2, self.a1, self.a2
        x1, x2, y1, y2 = self.x1, self.x2, self.y1, self.y2
        out = [0.0] * len(xs)
        for i in range(len(xs)):
            xn = float(xs[i])
            yn = b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            out[i] = yn
            x2, x1 = x1, xn
            y2, y1 = y1, yn
        self.x1, self.x2, self.y1, self.y2 = x1, x2, y1, y2
        return out


def _highpass_stages(f0: float, sr: int, order: int = 4) -> list[_Biquad]:
    """Cascade of RBJ high-pass biquads (Q=0.707 each) approximating an
    `order`-pole high-pass at f0. order=4 -> two sections -> 24 dB/octave, which
    crushes the ~16 Hz subsonic rumble some INMP441 boards emit while leaving
    speech (>=300 Hz) intact. f0<=0 disables filtering (returns [])."""
    if f0 <= 0 or f0 >= sr / 2:
        return []
    sections = max(1, round(order / 2))
    wn = 2.0 * math.pi * f0 / sr
    cs = math.cos(wn)
    q = 0.7071067811865476
    alpha = math.sin(wn) / (2.0 * q)
    a0 = 1.0 + alpha
    b0 = ((1.0 + cs) / 2.0) / a0
    b1 = (-(1.0 + cs)) / a0
    b2 = ((1.0 + cs) / 2.0) / a0
    a1 = (-2.0 * cs) / a0
    a2 = (1.0 - alpha) / a0
    return [_Biquad(b0, b1, b2, a1, a2) for _ in range(sections)]


# === simulate sources (stdlib only — no numpy) =============================
class SimWorld:
    """Shared latent 'activity' so synthetic motion + audio correlate:
    a gentle idle most of the time with occasional shake bursts."""

    def __init__(self, rng: random.Random):
        self.rng = rng
        self.level = 0.0
        self.target = 0.0
        now = time.monotonic()
        self._last = now
        self._next_event = now + rng.uniform(2.0, 5.0)

    def activity(self) -> float:
        now = time.monotonic()
        if now >= self._next_event:
            if self.target > 0.2:                       # end a burst -> idle
                self.target = 0.0
                self._next_event = now + self.rng.uniform(3.0, 8.0)
            else:                                        # start a shake burst
                self.target = self.rng.uniform(0.6, 1.0)
                self._next_event = now + self.rng.uniform(0.6, 1.8)
        dt = now - self._last
        self._last = now
        self.level += (self.target - self.level) * min(1.0, dt * 6.0)  # ease
        return _clamp(self.level, 0.0, 1.0)


class SimMotion:
    """Synthetic MPU-6050 already in contract units (g and °/s)."""

    def __init__(self, world: SimWorld, rng: random.Random):
        self.world = world
        self.rng = rng
        self.ph = [rng.uniform(0.0, math.tau) for _ in range(6)]

    def read(self, t: float):
        a = self.world.activity()
        g = self.rng.gauss
        tau = math.tau
        ax = g(0.0, 0.01) + a * 0.9 * math.sin(tau * 6.5 * t + self.ph[0])
        ay = g(0.0, 0.01) + a * 0.9 * math.sin(tau * 8.0 * t + self.ph[1])
        az = 1.0 + g(0.0, 0.012) + a * 0.7 * math.sin(tau * 5.0 * t + self.ph[2])  # +1 g gravity at rest
        gx = g(0.0, 0.6) + a * 140.0 * math.sin(tau * 7.0 * t + self.ph[3])
        gy = g(0.0, 0.6) + a * 130.0 * math.sin(tau * 6.0 * t + self.ph[4])
        gz = g(0.0, 0.6) + a * 110.0 * math.sin(tau * 9.0 * t + self.ph[5])
        return (
            _clamp(ax, -ACCEL_FS, ACCEL_FS),
            _clamp(ay, -ACCEL_FS, ACCEL_FS),
            _clamp(az, -ACCEL_FS, ACCEL_FS),
            _clamp(gx, -GYRO_FS, GYRO_FS),
            _clamp(gy, -GYRO_FS, GYRO_FS),
            _clamp(gz, -GYRO_FS, GYRO_FS),
        )

    def close(self):
        pass


class SimAudio:
    """Synthetic 16 kHz mono int16 audio: quiet ambient idle, louder on shakes."""

    rate = AUDIO_RATE

    def __init__(self, world: SimWorld, rng: random.Random):
        self.world = world
        self.rng = rng
        self._last = time.monotonic()
        self._phase = 0.0

    def reset_timing(self):
        self._last = time.monotonic()

    def drain(self):
        now = time.monotonic()
        dt = now - self._last
        self._last = now
        dt = min(dt, 0.5)                      # avoid a huge synth after a stall
        n = int(self.rate * dt)
        if n <= 0:
            return (None, [], b"")
        a = self.world.activity()
        amp = 300.0 + a * 9000.0               # int16 scale
        noise = 60.0 + a * 2500.0
        freq = 180.0 + a * 420.0
        step = math.tau * freq / self.rate
        g = self.rng.gauss
        ph = self._phase
        samples = [0] * n
        for i in range(n):
            ph += step
            iv = int(amp * math.sin(ph) * 0.6 + g(0.0, noise))
            samples[i] = 32767 if iv > 32767 else -32768 if iv < -32768 else iv
        self._phase = ph % math.tau
        pcm = struct.pack("<%dh" % n, *samples)
        target = max(1, min(round(ENV_RATE * dt), ENV_MAX))
        return (_dbfs(samples), _peak_decimate(samples, target), pcm)

    def close(self):
        pass


class SimVideo:
    """Cycle through a few baked JPEG frames so --simulate exercises the BINARY
    video pipeline (live relay + recording + poster + playback) with no camera."""

    def __init__(self):
        self._frames = BAKED_JPEG_FRAMES
        self._i = 0

    def capture(self) -> bytes:
        frame = self._frames[self._i % len(self._frames)]
        self._i += 1
        return frame

    def close(self):
        pass


# === real hardware sources (lazy imports — only constructed in real mode) ===
class RealMotion:
    def __init__(self):
        from smbus2 import SMBus  # lazy: not needed for --simulate / `import data`
        self.bus = SMBus(1)
        self.bus.write_byte_data(MPU_ADDR, PWR_MGMT_1, 0)  # wake the sensor
        time.sleep(0.05)

    def _word(self, reg: int) -> int:
        hi = self.bus.read_byte_data(MPU_ADDR, reg)
        lo = self.bus.read_byte_data(MPU_ADDR, reg + 1)
        v = (hi << 8) | lo
        return v - 65536 if v >= 0x8000 else v

    def read(self, t: float):
        return (
            self._word(ACCEL_XOUT_H) / ACCEL_SCALE,
            self._word(ACCEL_XOUT_H + 2) / ACCEL_SCALE,
            self._word(ACCEL_XOUT_H + 4) / ACCEL_SCALE,
            self._word(GYRO_XOUT_H) / GYRO_SCALE,
            self._word(GYRO_XOUT_H + 2) / GYRO_SCALE,
            self._word(GYRO_XOUT_H + 4) / GYRO_SCALE,
        )

    def close(self):
        try:
            self.bus.close()
        except Exception:
            pass


class RealAudio:
    """Mic capture that yields the contract stream: 16 kHz mono int16.

    Some I2S mics (e.g. an INMP441 on the Google voiceHAT overlay) expose ONLY a
    fixed native format — 48 kHz, stereo, 32-bit — and reject a direct 16 kHz
    mono int16 open. So we capture at the device-native rate/format, keep the one
    channel the mic actually drives (`mic_channel`; the INMP441 puts audio on the
    RIGHT = channel 1, the other channel is silence), decimate to 16 kHz, and
    down-convert 32-bit -> 16-bit. When the device already supports 16k/mono/int16
    natively, pass native_rate=16000, channels=1, sample_bits=16 for a pass-through.

    numpy is used for the per-channel decimation (it is a hard dep of the real
    hardware path anyway); --simulate never constructs this class.
    """

    rate = AUDIO_RATE   # contract OUTPUT rate (Hz), always 16 kHz mono int16

    def __init__(self, native_rate: int = 48000, channels: int = 2,
                 mic_channel: int = 1, sample_bits: int = 32, device=None,
                 highpass_hz: float = 0.0):
        import numpy as np                 # lazy: real hardware path only
        import sounddevice as sd           # lazy: not needed for --simulate

        self._np = np
        # optional high-pass on the 16k output stream (rumble removal); [] = off
        self._hp = _highpass_stages(float(highpass_hz), self.rate, order=4)
        self.native_rate = int(native_rate)
        self.channels = max(1, int(channels))
        self.mic_channel = min(max(0, int(mic_channel)), self.channels - 1)
        self.sample_bits = 32 if int(sample_bits) >= 32 else 16
        self._dtype = "int32" if self.sample_bits == 32 else "int16"
        self._itemsize = (self.sample_bits // 8) * self.channels
        # 48000 -> 16000 decimates by exactly 3; a non-integer ratio rounds and is
        # approximate but stable. >=1 so we never divide by zero.
        self.decim = max(1, round(self.native_rate / self.rate))
        # 32-bit samples are 24-bit data MSB-justified; >>16 (÷65536) maps to int16.
        self._downshift = 65536.0 if self.sample_bits == 32 else 1.0

        self._buf = bytearray()
        self._lock = threading.Lock()
        self._resid = np.zeros(0, dtype=np.float64)   # sub-`decim` carry between drains

        def _cb(indata, frames, time_info, status):   # runs on a PortAudio thread
            with self._lock:
                self._buf.extend(bytes(indata))

        self._stream = sd.RawInputStream(
            samplerate=self.native_rate, channels=self.channels,
            dtype=self._dtype, device=device, callback=_cb,
        )
        self._stream.start()

    def reset_timing(self):
        pass

    def drain(self):
        np = self._np
        with self._lock:
            raw = bytes(self._buf)
            self._buf.clear()

        # decode native interleaved frames -> the single mic channel, in int16 domain
        if len(raw) >= self._itemsize:
            usable = len(raw) - (len(raw) % self._itemsize)
            fmt = "<i4" if self.sample_bits == 32 else "<i2"
            frames = np.frombuffer(raw[:usable], dtype=fmt).reshape(-1, self.channels)
            mono = frames[:, self.mic_channel].astype(np.float64) / self._downshift
        else:
            mono = np.zeros(0, dtype=np.float64)

        # prepend last drain's leftover, decimate by averaging groups of `decim`
        mono = np.concatenate([self._resid, mono])
        keep = len(mono) - (len(mono) % self.decim)
        self._resid = mono[keep:]
        if keep == 0:
            return (None, [], b"")
        ds = mono[:keep].reshape(-1, self.decim).mean(axis=1) if self.decim > 1 else mono[:keep]
        if self._hp:                       # cascade the high-pass sections (stateful)
            samples_f = ds.tolist()
            for stage in self._hp:
                samples_f = stage.process(samples_f)
            ds = np.asarray(samples_f, dtype=np.float64)
        i16 = np.clip(np.rint(ds), -32768, 32767).astype("<i2")
        samples = i16.tolist()
        pcm = i16.tobytes()
        dt = len(i16) / self.rate
        target = max(1, min(round(ENV_RATE * dt), ENV_MAX))
        return (_dbfs(samples), _peak_decimate(samples, target), pcm)

    def close(self):
        try:
            self._stream.stop()
            self._stream.close()
        except Exception:
            pass


class _FrameSink(io.BufferedIOBase):
    """A file-like sink the MJPEGEncoder's FileOutput writes complete JPEG frames
    into — one whole JPEG per write() call. `latest()` hands the newest frame to
    the capture loop (this is the canonical picamera2 MJPEG-streaming pattern)."""

    def __init__(self):
        self._cond = threading.Condition()
        self._frame: bytes | None = None

    def writable(self) -> bool:
        return True

    def write(self, buf) -> int:
        b = bytes(buf)
        with self._cond:
            self._frame = b
            self._cond.notify_all()
        return len(b)

    def latest(self, timeout: float) -> bytes | None:
        with self._cond:
            if self._frame is None:
                self._cond.wait(timeout)
            return self._frame


class RealVideo:
    """Live JPEG frames from a Raspberry Pi camera via picamera2 + MJPEGEncoder.

    No Pillow: the MJPEGEncoder hardware/software-encodes JPEG frames that
    FileOutput writes whole into our `_FrameSink`. We pace the sensor at the
    target fps and the capture loop pulls the latest encoded frame each tick.
    """

    def __init__(self, size: tuple[int, int], fps: int):
        from picamera2 import Picamera2                 # lazy: real mode only
        from picamera2.encoders import MJPEGEncoder     # lazy: real mode only
        from picamera2.outputs import FileOutput        # lazy: real mode only

        self._sink = _FrameSink()
        self._picam2 = Picamera2()
        cfg = self._picam2.create_video_configuration(main={"size": size})
        try:                                            # pace frames at ~fps
            cfg.setdefault("controls", {})["FrameRate"] = float(fps)
        except Exception:
            pass
        self._picam2.configure(cfg)
        self._picam2.start_recording(MJPEGEncoder(), FileOutput(self._sink))

    def capture(self) -> bytes | None:
        # blocking: returns the most recent JPEG frame (call in an executor).
        return self._sink.latest(timeout=2.0)

    def close(self):
        try:
            self._picam2.stop_recording()
        except Exception:
            pass
        try:
            self._picam2.close()
        except Exception:
            pass


# === the producer ==========================================================
class Producer:
    def __init__(self, args: argparse.Namespace):
        self.simulate = bool(args.simulate)
        self.device = args.device
        self.token = getattr(args, "token", "") or ""
        self.motion_hz = max(1, int(args.motion_hz))
        self.video_fps = max(0, int(args.video_fps))
        self.video_size = parse_size(args.video_size)
        # device-native mic capture params (INMP441/voiceHAT = 48k/stereo/32-bit,
        # audio on the RIGHT channel); the class decimates to 16k mono int16.
        self.audio_native_rate = max(1, int(getattr(args, "audio_native_rate", 48000)))
        self.audio_channels = max(1, int(getattr(args, "audio_channels", 2)))
        self.audio_mic_channel = max(0, int(getattr(args, "audio_mic_channel", 1)))
        self.audio_bits = int(getattr(args, "audio_bits", 32))
        self.audio_highpass = float(getattr(args, "audio_highpass", 0.0))
        self.ingest_url, self.rest_base = derive_urls(args.server)

        self.loop: asyncio.AbstractEventLoop | None = None
        self._ws = None
        self._send_lock = asyncio.Lock()   # serialise text + binary frames on one socket
        self._shutdown = asyncio.Event()
        self._backoff = 1.0
        self._rng = random.Random()

        # continuous live sources (opened per connection, closed on disconnect)
        self._world = None
        self._motion = None
        self._audio = None
        self._video = None

        # session WAV buffering — spans a session, persists across reconnects
        self._wav = None              # wave.Wave_write or None (no mic)
        self._wav_path = None
        self._wav_session_id = None   # id of the session we are buffering for
        self._audio_posted = set()    # session ids whose WAV was already uploaded

        self._stream_tasks: list[asyncio.Task] = []
        self._bg = set()              # background tasks (WAV uploads, shutdown)

    # -- task helper --------------------------------------------------------
    def _spawn(self, coro):
        t = asyncio.create_task(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)
        return t

    # -- top-level run loop -------------------------------------------------
    async def run(self):
        self.loop = asyncio.get_running_loop()
        self._install_signals()
        try:
            while not self._shutdown.is_set():
                try:
                    await self._connection()
                except asyncio.CancelledError:
                    break
                except (OSError, websockets.exceptions.WebSocketException) as e:
                    LOG.warning("connection failed: %s", e)
                except Exception:
                    LOG.exception("unexpected connection error")
                if self._shutdown.is_set():
                    break
                LOG.info("reconnecting in %.0fs", self._backoff)
                try:
                    await asyncio.wait_for(self._shutdown.wait(), timeout=self._backoff)
                except asyncio.TimeoutError:
                    pass
                self._backoff = min(self._backoff * 2.0, 30.0)
        finally:
            await self._final_cleanup()

    def _install_signals(self):
        try:
            for s in (signal.SIGINT, signal.SIGTERM):
                self.loop.add_signal_handler(s, self._request_shutdown)
        except (NotImplementedError, RuntimeError):
            pass  # e.g. Windows / no running loop signal support -> KeyboardInterrupt

    async def _connection(self):
        # The server rejects an unauthenticated producer, so nobody can push junk
        # readings at a public deployment. websockets>=12 calls this additional_headers;
        # older releases call it extra_headers.
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        try:
            connect = websockets.connect(
                self.ingest_url, additional_headers=headers,
                max_size=8 * 1024 * 1024, ping_interval=20, ping_timeout=20,
                close_timeout=5,
            )
        except TypeError:
            connect = websockets.connect(
                self.ingest_url, extra_headers=headers,
                max_size=8 * 1024 * 1024, ping_interval=20, ping_timeout=20,
                close_timeout=5,
            )
        async with connect as ws:
            self._ws = ws
            self._backoff = 1.0
            LOG.info("connected -> %s", self.ingest_url)
            await self._send(ws, {
                "type": "hello", "role": "producer", "device": self.device,
                "caps": {"motion": True, "audio": True, "video": self.video_fps > 0},
                "motion_hz": self.motion_hz, "audio_rate": AUDIO_RATE,
                "video_fps": self.video_fps,
            })
            self._open_sources()
            self._start_streaming(ws)
            try:
                async for raw in ws:
                    if isinstance(raw, (bytes, bytearray)):
                        continue              # server never sends us binary
                    try:
                        msg = json.loads(raw)
                    except (ValueError, TypeError):
                        continue
                    await self._handle(ws, msg)
                    # NB: on shutdown we do NOT break here — _graceful() owns the
                    # teardown so it can send `bye` before closing the socket.
            finally:
                # connection ending: stop the live loops and release the sources,
                # but KEEP the session WAV open so a reconnect resumes the same id
                # (PROTOCOL §6 reconnection).
                await self._stop_streaming()
                self._close_sources()
                self._ws = None

    # -- live sources -------------------------------------------------------
    def _open_sources(self):
        self._rng = random.Random()
        if self.simulate:
            self._world = SimWorld(self._rng)
            self._motion = SimMotion(self._world, self._rng)
            self._audio = SimAudio(self._world, self._rng)
            self._video = SimVideo() if self.video_fps > 0 else None
        else:
            self._motion = self._open_real_motion()
            self._audio = self._open_real_audio()
            self._video = self._open_real_video() if self.video_fps > 0 else None

    def _open_real_motion(self):
        try:
            return RealMotion()
        except Exception as e:
            LOG.warning("MPU-6050 unavailable, motion disabled: %s", e)
            return None

    def _open_real_audio(self):
        try:
            return RealAudio(
                native_rate=self.audio_native_rate,
                channels=self.audio_channels,
                mic_channel=self.audio_mic_channel,
                sample_bits=self.audio_bits,
                highpass_hz=self.audio_highpass,
            )
        except Exception as e:
            LOG.warning("microphone unavailable, audio disabled: %s", e)
            return None

    def _open_real_video(self):
        try:
            return RealVideo(self.video_size, self.video_fps)
        except Exception as e:
            LOG.warning("camera unavailable, video disabled: %s", e)
            return None

    def _close_sources(self):
        for src in (self._motion, self._audio, self._video):
            if src is not None:
                try:
                    src.close()
                except Exception:
                    pass
        self._motion = self._audio = self._video = self._world = None

    # -- streaming loops ----------------------------------------------------
    def _start_streaming(self, ws):
        self._stream_tasks = [asyncio.create_task(self._motion_audio_loop(ws))]
        if self._video is not None and self.video_fps > 0:
            self._stream_tasks.append(asyncio.create_task(self._video_loop(ws)))

    async def _stop_streaming(self):
        tasks = self._stream_tasks
        self._stream_tasks = []
        for t in tasks:
            if not t.done():
                t.cancel()
        for t in tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass

    async def _motion_audio_loop(self, ws):
        """Sample motion at motion_hz, drain audio for db+envelope, and send
        ~5 `readings`/sec CONTINUOUSLY (independent of any session)."""
        period = 1.0 / self.motion_hz
        rows_per_batch = max(1, round(self.motion_hz / 5.0))   # ~5 readings frames/sec
        motion_buf = []
        next_t = time.monotonic()
        try:
            while not self._shutdown.is_set():
                now = time.monotonic()
                if now < next_t:
                    await asyncio.sleep(min(next_t - now, period))
                    continue
                ts = now                       # contract ts = Pi monotonic seconds
                try:
                    vals = self._motion.read(ts) if self._motion else (0.0,) * 6
                except Exception as e:
                    LOG.debug("motion read failed: %s", e)
                    vals = (0.0,) * 6
                motion_buf.append([round(ts, 4)] + [round(float(v), 5) for v in vals])
                next_t += period
                if next_t < now - 0.5:         # fell badly behind -> resync schedule
                    next_t = now + period

                if len(motion_buf) >= rows_per_batch:
                    db, env = self._drain_audio()
                    await self._send_readings(ws, motion_buf, env, db)
                    motion_buf = []
        except asyncio.CancelledError:
            raise
        except websockets.exceptions.ConnectionClosed:
            return

    async def _video_loop(self, ws):
        """Push one JPEG BINARY frame per tick at --video-fps, continuously."""
        period = 1.0 / self.video_fps
        next_t = time.monotonic()
        try:
            while not self._shutdown.is_set():
                now = time.monotonic()
                if now < next_t:
                    await asyncio.sleep(min(next_t - now, period))
                    continue
                next_t += period
                if next_t < now - 0.5:
                    next_t = now + period
                video = self._video
                if video is None:
                    return
                try:
                    jpeg = await self.loop.run_in_executor(None, video.capture)
                except Exception as e:
                    LOG.debug("video capture failed: %s", e)
                    jpeg = None
                if jpeg:
                    try:
                        await self._send_bytes(ws, jpeg)
                    except websockets.exceptions.ConnectionClosed:
                        return
        except asyncio.CancelledError:
            raise
        except websockets.exceptions.ConnectionClosed:
            return

    def _drain_audio(self):
        """Return (db, env) for the live readings frame; while a session WAV is
        open, also append the raw PCM to it for the eventual upload."""
        if not self._audio:
            return (None, [])
        try:
            db, env, pcm = self._audio.drain()
        except Exception as e:
            LOG.debug("audio drain failed: %s", e)
            return (None, [])
        if pcm and self._wav is not None:
            try:
                self._wav.writeframes(pcm)
            except Exception:
                pass
        return (db, env)

    async def _send_readings(self, ws, motion_rows, env, db):
        msg = {"type": "readings", "motion": motion_rows, "db": db}
        if env:
            msg["audio"] = env
        await self._send(ws, msg)

    # -- inbound control (recordings only bound the WAV buffer) --------------
    async def _handle(self, ws, msg: dict):
        mtype = msg.get("type")
        if mtype == "welcome":
            await self._on_welcome(msg.get("active_exercise"))
        elif mtype == "recording_started":
            await self._begin_wav(msg.get("exerciseId"))
        elif mtype == "recording_stopped":
            await self._finalize_wav(post=True)
        elif mtype == "error":
            LOG.warning("server error: %s — %s", msg.get("error"), msg.get("detail"))
        elif mtype in ("ping", "pong"):
            pass
        else:
            LOG.debug("ignoring message type=%s", mtype)

    async def _on_welcome(self, exercise_id):
        if exercise_id:
            await self._begin_wav(exercise_id)
        elif self._wav_session_id is not None:
            # we reconnected after the recording had already stopped — finalize it.
            await self._finalize_wav(post=True)
        else:
            LOG.info("connected, not recording — streaming live preview")

    # -- session WAV lifecycle ----------------------------------------------
    async def _begin_wav(self, sid):
        if sid is None:
            return
        if self._wav_session_id == sid:
            return                              # resume same session (reconnect / dup)
        if self._wav_session_id is not None:    # unexpected overlap -> flush the old one
            await self._finalize_wav(post=True)
        self._open_wav(sid)
        LOG.info("recording exercise=%s — buffering audio for the exercise WAV", sid)

    def _open_wav(self, sid):
        self._wav_session_id = sid
        self._wav = None
        self._wav_path = None
        if self._audio is None:
            return                              # no mic: track the id, no WAV to post
        try:
            self._wav_path = tempfile.mktemp(prefix="waves_", suffix=".wav")
            w = wave.open(self._wav_path, "wb")
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(AUDIO_RATE)
            self._wav = w
        except Exception as e:
            LOG.warning("could not open temp WAV: %s", e)
            self._wav = None
            self._wav_path = None

    async def _finalize_wav(self, post: bool = True):
        if self._wav_session_id is None:
            return
        sid = self._wav_session_id
        wav = self._wav
        path = self._wav_path
        self._wav = None
        self._wav_path = None
        self._wav_session_id = None

        wav_bytes = None
        if wav is not None:
            try:
                wav.close()
                with open(path, "rb") as f:
                    wav_bytes = f.read()
            except Exception as e:
                LOG.warning("WAV finalize failed: %s", e)
        if path:
            try:
                os.remove(path)
            except OSError:
                pass

        if (post and wav_bytes and sid is not None
                and sid not in self._audio_posted and len(wav_bytes) > 44):
            self._audio_posted.add(sid)
            LOG.info("exercise=%s stopped — uploading WAV (%d bytes)", sid, len(wav_bytes))
            self._spawn(self._upload(
                f"{self.rest_base}/api/exercises/{sid}/audio", wav_bytes, "audio/wav"))
        else:
            LOG.info("exercise=%s stopped — no WAV to upload", sid)

    # -- io helpers ---------------------------------------------------------
    async def _send(self, ws, obj: dict):
        data = json.dumps(obj, separators=(",", ":"))
        async with self._send_lock:
            await ws.send(data)

    async def _send_bytes(self, ws, data: bytes):
        async with self._send_lock:
            await ws.send(data)

    async def _upload(self, url: str, data: bytes, content_type: str):
        try:
            await self.loop.run_in_executor(
                None, self._http_post, url, data, content_type, self.token)
        except Exception as e:
            LOG.warning("upload to %s failed: %s", url, e)

    @staticmethod
    def _http_post(url: str, data: bytes, content_type: str, token: str = "") -> bool:
        headers = {"Content-Type": content_type, "Content-Length": str(len(data))}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = Request(url, data=data, method="POST", headers=headers)
        try:
            with urlopen(req, timeout=20) as resp:
                resp.read()
            return True
        except URLError as e:
            LOG.warning("POST %s failed: %s", url, getattr(e, "reason", e))
            return False
        except Exception as e:
            LOG.warning("POST %s error: %s", url, e)
            return False

    # -- shutdown -----------------------------------------------------------
    def _request_shutdown(self):
        if self._shutdown.is_set():
            return
        LOG.info("shutting down…")
        self._shutdown.set()
        self._spawn(self._graceful())

    async def _graceful(self):
        ws = self._ws
        try:
            await self._stop_streaming()
            # finish any in-progress session WAV (POST it) before we go.
            if self._wav_session_id is not None:
                await self._finalize_wav(post=True)
            if ws is not None:
                try:
                    await self._send(ws, {"type": "bye"})
                except Exception:
                    pass
                try:
                    await ws.close()
                except Exception:
                    pass
        except Exception as e:
            LOG.debug("graceful shutdown error: %s", e)

    async def _final_cleanup(self):
        if self._wav_session_id is not None:
            await self._finalize_wav(post=True)
        self._close_sources()
        pending = [t for t in self._bg if not t.done()]
        if pending:
            try:
                await asyncio.wait(pending, timeout=20)   # let in-flight WAV uploads finish
            except Exception:
                pass


# === cli ===================================================================
def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="data.py",
        description="waves · Raspberry Pi streaming producer / follower (PROTOCOL.md §6).")
    p.add_argument("--server", default="ws://localhost:8000",
                   help="base server URL; /ingest + /api derived (default ws://localhost:8000)")
    p.add_argument("--device", default="pi-cam-01",
                   help="device id reported to the server (default pi-cam-01)")
    p.add_argument("--motion-hz", dest="motion_hz", type=int, default=40,
                   help="MPU-6050 sample rate in Hz (default 40)")
    p.add_argument("--video-fps", dest="video_fps", type=int, default=12,
                   help="JPEG frames/sec pushed as binary; 0 = video off (default 12)")
    p.add_argument("--video-size", dest="video_size", default="640x480",
                   help="camera capture resolution WxH (default 640x480)")
    # Mic native-capture params. Defaults match an INMP441 on the Google voiceHAT
    # (48 kHz / stereo / 32-bit, audio on the RIGHT channel). For a mic that opens
    # 16k mono int16 directly, use: --audio-native-rate 16000 --audio-channels 1 --audio-bits 16.
    p.add_argument("--audio-native-rate", dest="audio_native_rate", type=int, default=48000,
                   help="mic hardware sample rate in Hz; decimated to 16k (default 48000)")
    p.add_argument("--audio-channels", dest="audio_channels", type=int, default=2,
                   help="mic hardware channel count (default 2)")
    p.add_argument("--audio-mic-channel", dest="audio_mic_channel", type=int, default=1,
                   help="which channel carries the mic; INMP441 = 1 (RIGHT) (default 1)")
    p.add_argument("--audio-bits", dest="audio_bits", type=int, default=32, choices=(16, 32),
                   help="mic hardware sample width in bits (default 32)")
    p.add_argument("--audio-highpass", dest="audio_highpass", type=float, default=0.0,
                   help="high-pass cutoff Hz on the 16k stream, 4th-order; removes subsonic "
                        "rumble (e.g. 130 for a rumbly INMP441). 0 = off (default 0)")
    p.add_argument("--simulate", action="store_true",
                   help="synthesize all signals + baked video frames; imports no hardware libraries")
    # Never pass a real token on the command line — it lands in shell history and in the
    # process list, where any other user on the Pi can read it.
    p.add_argument("--token", default=os.environ.get("WAVES_INGEST_TOKEN", ""),
                   help="ingest token; prefer the WAVES_INGEST_TOKEN env var over this flag")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    prod = Producer(args)
    LOG.info("waves producer | mode=%s | ingest=%s | rest=%s | video=%s@%sfps",
             "simulate" if args.simulate else "hardware", prod.ingest_url, prod.rest_base,
             "off" if prod.video_fps == 0 else "%dx%d" % prod.video_size, prod.video_fps)
    try:
        asyncio.run(prod.run())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
