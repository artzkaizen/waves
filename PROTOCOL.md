# waves · streaming protocol & data contract (v2)

This is the **frozen contract** shared by all three components. Do not deviate from field names,
types, units, routes, or the SQLite schema. If something is genuinely missing, add it *additively*
(new optional field / new message type) and document it here.

**What changed v1 → v2**
- **Live video, not stills.** The Pi pushes JPEG frames; the server relays them as a live MJPEG
  stream and **records each session's video to disk**. The old base64 thumbnail / periodic-still
  `frame` message and `POST …/frame` upload are removed.
- **The dashboard owns sessions, not the Pi.** Only a viewer (the UI) can `start_session` /
  `stop_session`. The Pi is a **stateless follower**: it connects and continuously streams its live
  feed; it never creates sessions and takes no `--label`.
- **Always-on live preview.** Motion + audio + video stream continuously whenever the Pi is
  connected, so the dashboard charts and camera are live even when nothing is being recorded. A
  *session* is just the window during which the server **persists** that already-flowing stream.

```
┌──────────────┐  ws /ingest  (live motion 40Hz + audio + db)   ┌────────────────────┐  ws /live (control + motion fanout)  ┌────────────┐
│ Pi  data.py  │ ───────────────────────────────────────────►  │  server.py          │ ◄─────────────────────────────────► │ dashboard  │
│ (follower /  │  ws /ingest  BINARY JPEG frames (video)        │  aiohttp + sqlite3  │                                     │ (browser)  │
│  streamer)   │ ───────────────────────────────────────────►  │  + files on disk    │  GET /api/stream.mjpeg (live <img>) │            │
│              │  REST  POST …/audio  (session WAV on stop)     │  records during a   │  GET /api/sessions… (list/detail/   │            │
│              │ ───────────────────────────────────────────►  │  session            │      export.csv/video.mjpeg/poster) │            │
└──────────────┘                                                └────────────────────┘ ◄─────────────────────────────────► └────────────┘
```

- **Transport:** one aiohttp server on `:8000`. WebSockets carry *live, lightweight* data (motion
  @ 40 Hz, audio envelope, dB, control) **and binary JPEG video frames**. REST carries *bulk
  storage* (session WAV) and *queries/playback* (sessions, CSV, live + recorded MJPEG).
- **Roles:** a socket on `/ingest` is a **producer** (Pi). A socket on `/live` is a **viewer**
  (dashboard). The **server owns all session state and IDs.**
- **Session model:** at most **one active session** at a time, created **only by a viewer**. While a
  session is active the server persists the live stream (motion+audio → SQLite, video → disk). A
  session has a server-assigned integer `id` and a single `label` (the ML class, e.g. `shake`).
- **Encoding:** WebSocket **text** frames are JSON (every message has a `"type"`). WebSocket
  **binary** frames on `/ingest` are raw JPEG video frames (no JSON, no base64). Time `t` is float
  **seconds since the session started** (server-assigned).

## Units (converted on the Pi, not raw counts)

| signal | field        | unit            | typical range | conversion from MPU-6050 raw |
|--------|--------------|-----------------|---------------|------------------------------|
| accel  | `ax,ay,az`   | g               | -1.6 … 1.6    | raw / 16384.0  (±2 g)        |
| gyro   | `gx,gy,gz`   | °/s             | -200 … 200    | raw / 131.0    (±250 °/s)    |
| audio  | `db`         | dBFS            | -60 … 0       | `20*log10(rms)`, clamped     |
| audio  | `audio[]`    | normalized      | -1 … 1        | int16 / 32768, peak-decimated|
| time   | `ts`         | s (monotonic)   | —             | Pi `time.monotonic()`        |

---

## 1. WebSocket `/ingest` — producer (Pi) ↔ server

### producer → server

```jsonc
// on connect
{ "type": "hello", "role": "producer", "device": "pi-cam-01",
  "caps": { "motion": true, "audio": true, "video": true },
  "motion_hz": 40, "audio_rate": 16000, "video_fps": 12 }

// live signal batch, sent ~4–6×/sec, CONTINUOUSLY while connected (not gated on a session).
// `ts` is Pi monotonic seconds; the server rebases it to session-relative `t` when persisting.
{ "type": "readings",
  "motion": [ [ts, ax, ay, az, gx, gy, gz], … ],  // ~8 rows (40 Hz over ~200 ms); arrays, not objects
  "audio":  [v, v, …],                            // OPTIONAL ~96 decimated samples in [-1,1] (~480/s)
  "db": -32.4 }                                   // current level dBFS (null if no mic)

// VIDEO: raw JPEG bytes as a BINARY WebSocket frame (NOT JSON). Sent ~video_fps×/sec, continuously.
// The server attributes binary frames from the producer to the live relay and, if recording, to the
// active session's video file (first frame → poster).

{ "type": "bye" }    // graceful disconnect
```

Producers **never** send `start_session` / `stop_session` and never invent a session id.

### server → producer

```jsonc
{ "type": "welcome", "active_session": { /* session object, §4 */ } | null }

// informational: a viewer started/stopped a session. The Pi uses these only to bound the local
// audio buffer it uploads as the session WAV (§2). It does NOT need them to stream.
{ "type": "session_started", "session": { /* session object */ } }
{ "type": "session_stopped", "session": { /* session object */ } }

{ "type": "error", "error": "bad_message", "detail": "…" }
```

## 2. REST upload — producer (Pi) → server (bulk storage)

```
POST /api/sessions/{id}/audio   body: audio/wav (raw bytes, 16 kHz mono int16)
                                → stores the session WAV, sets sessions.audio_path/audio_rate. 200 {"ok":true}
```

The Pi buffers audio locally between `session_started` and `session_stopped` and POSTs the full WAV
once on stop. (Optional — skip if no mic.) **Video is NOT uploaded over REST** — the server records
it from the binary `/ingest` frames as they arrive.

---

## 3. WebSocket `/live` — viewer (dashboard) ↔ server

### viewer → server  — the ONLY way sessions are created

```jsonc
{ "type": "hello", "role": "viewer" }
{ "type": "start_session", "label": "shake", "name": null, "duration": 30 }   // duration s, null/0 = open-ended
{ "type": "stop_session",  "session_id": 12 }
```

### server → viewer

```jsonc
{ "type": "welcome", "active_session": { /* session */ } | null, "producers": 1 }
{ "type": "producer_status", "producers": 1 }                 // when a producer connects/leaves
{ "type": "session_started", "session": { /* session */ } }
{ "type": "readings",
  "motion": [ [ts,ax,ay,az,gx,gy,gz], … ], "audio": [v,…], "db": -32.4 }   // fanned out from the producer
{ "type": "session_stopped", "session": { /* session, now with ended_at/reading_count/has_video */ } }
{ "type": "error", "error": "session_active" | "no_active_session" | "no_producer" | "bad_message", "detail": "…" }
```

Live **video** does NOT travel over `/live` — the dashboard shows it via the MJPEG HTTP endpoint
(`GET /api/stream.mjpeg`, §4) in an `<img>`.

**Start/stop rules (server):** `start_session` while one is active → `error:"session_active"`;
with no producer connected → still allowed but reply may include `error:"no_producer"` as a warning
(server's choice — at minimum don't crash). `stop_session` mismatch → `error:"no_active_session"`.
`duration` > 0 → auto-stop after that many seconds. Stop finalizes the WAV + video + counts and
broadcasts `session_stopped`.

---

## 4. REST queries / media — viewer (dashboard) → server

```
GET /api/sessions
    → { "sessions": [ <session object>, … ] }                 // newest first

GET /api/sessions/{id}
    → { "session": <session object>,
        "motion": { "t":[…], "ax":[…], "ay":[…], "az":[…], "gx":[…], "gy":[…], "gz":[…] },  // downsampled ≤220 pts
        "audio":  [v, …] }          // ≤480 pts in [-1,1]: decoded from stored WAV, else dB envelope

GET /api/stream.mjpeg                 → LIVE multipart/x-mixed-replace MJPEG from the latest pushed frame
                                        (available whenever a producer is streaming video; independent of sessions)
GET /api/sessions/{id}/video.mjpeg    → the RECORDED session video, re-streamed as multipart/x-mixed-replace
                                        at its stored fps (404 if none)
GET /api/sessions/{id}/poster.jpg     → first recorded frame of the session (library thumbnail; 404 if none)
GET /api/sessions/{id}/export.csv     → text/csv, columns: t,ax,ay,az,gx,gy,gz,db   (one row per motion reading)
GET /api/sessions/{id}/audio.wav      → the stored WAV (404 if none)
DELETE /api/sessions/{id}             → remove session + readings + on-disk files. 200 {"ok":true}

GET /            → serves the built dashboard (dist/index.html) if present, else 404 JSON
GET /healthz     → { "ok": true }
```

CORS: `/api/*` send `Access-Control-Allow-Origin: *` and handle `OPTIONS`, so the Vite dev server on
`:5173` can call `:8000`.

### session object (canonical JSON shape used everywhere)

```jsonc
{ "id": 12, "label": "shake", "name": null, "device": "pi-cam-01",
  "started_at": 1751210732.4, "ended_at": 1751210762.1 | null,
  "duration": 30 | null, "status": "recording" | "done" | "aborted",
  "reading_count": 1203,
  "audio_rate": 16000 | null, "has_audio": true,
  "has_video": true, "video_fps": 12 | null, "notes": null }
```

---

## 5. SQLite schema (`serverdata/waves.db`)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT NOT NULL,
  name          TEXT,
  device        TEXT,
  started_at    REAL NOT NULL,         -- epoch seconds
  ended_at      REAL,                  -- epoch seconds, NULL while recording
  duration      REAL,                  -- planned seconds, NULL = open-ended
  status        TEXT NOT NULL DEFAULT 'recording',  -- recording | done | aborted
  reading_count INTEGER NOT NULL DEFAULT 0,
  audio_path    TEXT,                  -- relative path to wav, NULL if none
  audio_rate    INTEGER,
  video_path    TEXT,                  -- relative path to recorded video, NULL if none
  video_fps     INTEGER,
  poster_path   TEXT,                  -- relative path to first-frame jpg, NULL if none
  notes         TEXT
);
CREATE TABLE IF NOT EXISTS readings (
  session_id INTEGER NOT NULL,
  seq        INTEGER NOT NULL,         -- monotonic per session, from 0 (server-assigned)
  t          REAL NOT NULL,            -- seconds since session start (server-rebased from ts)
  ax REAL, ay REAL, az REAL,           -- g
  gx REAL, gy REAL, gz REAL,           -- deg/s
  db REAL,                             -- dBFS, nullable
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
-- NOTE: the v1 `frames` table is removed in v2 (video is a single file per session).
```

On-disk layout under `serverdata/`:
```
serverdata/
  waves.db
  sessions/<id>/audio.wav
  sessions/<id>/video.mjpeg      ← length-prefixed JPEG frames (see below)
  sessions/<id>/poster.jpg
```

**Recorded video container (`video.mjpeg`)**: a flat sequence of frames, each written as a 4-byte
big-endian unsigned length followed by that many JPEG bytes: `[uint32 len][jpeg]…`. The
`video.mjpeg` review endpoint reads this back frame-by-frame and emits a multipart/x-mixed-replace
stream paced at `video_fps`. (This avoids any ffmpeg dependency and is trivially seekable/splittable.)

## 6. Config / defaults

| who      | knob                | default                | notes |
|----------|---------------------|------------------------|-------|
| server   | `--host/--port`     | `0.0.0.0` / `8000`     | env `WAVES_HOST` / `WAVES_PORT` |
| server   | `--data-dir`        | `./serverdata`         | db + files (env `WAVES_DATA_DIR`) |
| Pi       | `--server`          | `ws://localhost:8000`  | base URL; `/ingest` + `/api` derived |
| Pi       | `--device`          | `pi-cam-01`            | device id reported in `hello` |
| Pi       | `--motion-hz`       | `40`                   | IMU sample rate |
| Pi       | `--video-fps`       | `12`                   | JPEG frames/sec pushed; 0 = video off |
| Pi       | `--video-size`      | `640x480`              | capture resolution |
| Pi       | `--simulate`        | off                    | synthesize signals + frames, no hardware libs imported |
| dashboard| server URL          | `ws://localhost:8000`  | from Settings popover, persisted |
| dashboard| session duration    | `0` (open-ended)       | sent in `start_session.duration` |

There is **no** `--label` / session control on the Pi: sessions are created exclusively from the
dashboard. Reconnection: producer and viewer both reconnect with backoff; on producer reconnect it
learns `active_session` from the `welcome` reply (so its session-WAV buffering resumes correctly).
</content>
