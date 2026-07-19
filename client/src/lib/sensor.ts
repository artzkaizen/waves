/** Number of motion samples retained in the live ring buffer (~5.5s @ 40Hz). */
export const MOTION_POINTS = 220
/** Number of audio points retained in the live ring buffer. */
export const AUDIO_POINTS = 480

// ─── server / session contract (PROTOCOL §3–§4) ────────────────────────────

/** Lifecycle of a recording session. */
export type SessionStatus = 'recording' | 'done' | 'aborted'

/** Canonical session object — the exact JSON shape used everywhere (PROTOCOL §4). */
export type Session = {
  /** experiment-api exercise id (UUID). */
  id: string
  label: string
  name: string | null
  device: string | null
  /** Epoch seconds. */
  started_at: number
  /** Epoch seconds, null while recording. */
  ended_at: number | null
  /** Planned seconds, null = open-ended. */
  duration: number | null
  status: SessionStatus
  reading_count: number
  /** Stored 16-bit mono WAV rate (Hz), null if no audio. */
  audio_rate: number | null
  has_audio: boolean
  /** True once a session has a recorded `video.mjpeg` + `poster.jpg` on disk. */
  has_video: boolean
  /** Frames/sec of the recorded video, null if no video. */
  video_fps: number | null
  notes: string | null
}

/** Downsampled motion columns from `GET /api/sessions/{id}` (PROTOCOL §4). */
export type SessionMotion = {
  t: number[]
  ax: number[]
  ay: number[]
  az: number[]
  gx: number[]
  gy: number[]
  gz: number[]
}

/**
 * Full detail payload from `GET /api/sessions/{id}` — used to freeze review charts.
 * v2 has no `frames[]`: recorded video is served from `video.mjpeg` + `poster.jpg`.
 */
export type SessionDetail = {
  session: Session
  motion: SessionMotion
  /** ≤480 pts in [-1, 1]: decoded WAV, else a dB envelope. */
  audio: number[]
}

/** A normalised pair of server base URLs derived from the Settings value. */
export type ServerUrls = {
  /** WebSocket base, e.g. `ws://localhost:8000` (the `/live` + `/ingest` routes hang off this). */
  ws: string
  /** HTTP base, e.g. `http://localhost:8000` (the `/api/*` routes hang off this). */
  http: string
}

/**
 * Normalise a free-form server setting into `ws` + `http` base URLs.
 * Accepts a bare `host`, a `host:port`, or a full `ws://`/`wss://`/`http://`/`https://`
 * URL (any path is dropped).
 *
 * Port rule: only a *schemeless* input gets the `:8000` default (PROTOCOL §6). When an
 * explicit scheme is given without a port we leave it to the scheme default, so e.g.
 * `wss://host` stays portless and works behind `:443`.
 */
export function normalizeServerUrl(input: string): ServerUrls {
  let raw = (input || '').trim().replace(/\/+$/, '')
  if (!raw) raw = 'ws://localhost:8000'

  let secure = false
  let authority = raw
  let hadScheme = false
  const m = raw.match(/^(wss|ws|https|http):\/\/(.*)$/i)
  if (m) {
    const proto = m[1].toLowerCase()
    secure = proto === 'wss' || proto === 'https'
    authority = m[2]
    hadScheme = true
  }
  // Keep only `host[:port]` — drop any path/query the user pasted in.
  authority = authority.replace(/[/?#].*$/, '')
  if (!authority) authority = 'localhost:8000'
  // Force `:8000` only when the user gave no scheme; an explicit scheme without a
  // port keeps the scheme default (443 for wss/https, 80 for ws/http).
  if (!hadScheme && !/:\d+$/.test(authority)) authority = `${authority}:8000`

  return {
    ws: `${secure ? 'wss' : 'ws'}://${authority}`,
    http: `${secure ? 'https' : 'http'}://${authority}`,
  }
}

/**
 * Rough on-disk size estimate (KB) for a session-library row. The contract has no
 * byte-size field, so this is derived from `reading_count` (7 float cols) plus the
 * stored 16-bit mono WAV when present.
 */
export function sessionSizeKB(s: Session): number {
  const motionKB = (s.reading_count * 7 * 4) / 1024
  let audioKB = 0
  if (s.has_audio) {
    const secs = s.duration ?? (s.ended_at != null ? s.ended_at - s.started_at : 0)
    const rate = s.audio_rate ?? 16000
    audioKB = (Math.max(0, secs) * rate * 2) / 1024
  }
  return Math.round(motionKB + audioKB)
}

/**
 * Build an SVG polyline `points` string (120×30 viewBox) summarising an audio
 * waveform into 60 points — used for the dataset row sparklines.
 */
export function sparkPoints(audio: number[]): string {
  const N = 60
  const n = audio.length || 1
  const pts: string[] = []
  for (let i = 0; i < N; i++) {
    const idx = Math.floor((i / N) * n)
    const v = audio[idx] || 0
    pts.push(`${((i / (N - 1)) * 120).toFixed(1)},${(15 - v * 13).toFixed(1)}`)
  }
  return pts.join(' ')
}

/** Format an epoch-ms timestamp as HH:MM:SS (24h). */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB')
}

/** Format a KB size as KB or MB. */
export function formatSize(kb: number): string {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`
}
