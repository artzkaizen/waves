/**
 * experiment-api client (davidlinner/experiment-api shape) used by React Query.
 *
 * Recording is driven over REST: create an experiment, add an exercise (the ML label
 * rides in `properties.label`), then POST recording/start|stop. The server gates these
 * behind a session cookie, so we sign in first with a dev account. Live motion/audio/
 * video keep flowing over the `/live` WS + MJPEG independently of these calls.
 */

import type { Session } from './sensor'

// Dev auto-login. Override with VITE_WAVES_EMAIL / VITE_WAVES_PASSWORD. Local dev only.
const DEV_EMAIL = import.meta.env.VITE_WAVES_EMAIL ?? 'dashboard@waves.local'
const DEV_PASSWORD = import.meta.env.VITE_WAVES_PASSWORD ?? 'waves-dashboard-dev'

async function post<T = unknown>(
  httpBase: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${httpBase}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(e.error || `${path} failed (${res.status})`)
  }
  return (await res.json().catch(() => ({}))) as T
}

/** Sign in for the httpOnly session cookie. Idempotent — safe to call before every start. */
export function login(httpBase: string): Promise<unknown> {
  return post(httpBase, '/auth/login', { email: DEV_EMAIL, password: DEV_PASSWORD })
}

export type StartRecordingVars = { label: string; name: string | null }

/** login → create experiment → create exercise → recording/start. Returns the exercise id. */
export async function startRecording(
  httpBase: string,
  { label, name }: StartRecordingVars,
): Promise<string> {
  await login(httpBase)
  const exp = await post<{ id: string }>(httpBase, '/experiments', {
    properties: { source: 'dashboard', label },
  })
  const ex = await post<{ id: string }>(httpBase, `/experiments/${exp.id}/exercises`, {
    properties: { label, name: name ?? undefined },
  })
  await post(httpBase, `/exercises/${ex.id}/recording/start`)
  return ex.id
}

export function stopRecording(httpBase: string, exerciseId: string): Promise<unknown> {
  return post(httpBase, `/exercises/${exerciseId}/recording/stop`)
}

// --------------------------------------------------------------------------- //
// dataset list / delete (experiment-api exercises → dashboard Session shape)
// --------------------------------------------------------------------------- //

/** Raw experiment-api exercise object. */
type Exercise = {
  id: string
  experimentId: string
  createdAt: string
  properties?: Record<string, unknown>
  recordingStatus: 'idle' | 'recording' | 'stopped'
  hasData: boolean
  recordingStartedAt: string | null
  recordingEndedAt: string | null
  readingCount?: number
  notes: string | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

/** Map an experiment-api exercise onto the dashboard's canonical Session shape. */
function exerciseToSession(ex: Exercise): Session {
  const startedMs = Date.parse(ex.recordingStartedAt ?? ex.createdAt)
  const endedMs = ex.recordingEndedAt ? Date.parse(ex.recordingEndedAt) : null
  const p = ex.properties ?? {}
  // The ML class lives under different property keys across the dataset:
  // `label` (dashboard recordings), `intensity` (normal/medium/big imports), `task`.
  const label = str(p.label) ?? str(p.intensity) ?? str(p.task) ?? 'sample'
  return {
    id: ex.id,
    label,
    name: str(p.name) ?? str(p.recording),
    device: str(p.device),
    started_at: (Number.isNaN(startedMs) ? Date.now() : startedMs) / 1000,
    ended_at: endedMs && !Number.isNaN(endedMs) ? endedMs / 1000 : null,
    duration: null,
    status:
      ex.recordingStatus === 'recording'
        ? 'recording'
        : ex.hasData
          ? 'done'
          : 'aborted',
    reading_count: ex.readingCount ?? 0,
    audio_rate: null,
    has_audio: ex.hasData,
    has_video: ex.hasData,
    video_fps: null,
    notes: ex.notes,
  }
}

/** List recorded exercises (newest first) as Sessions. Requires the auth cookie. */
export async function fetchSessions(httpBase: string): Promise<Session[]> {
  await login(httpBase)
  const res = await fetch(`${httpBase}/exercises?page=1&pageSize=100`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`list exercises failed (${res.status})`)
  const data = (await res.json()) as { items?: Exercise[] }
  return (data.items ?? [])
    .map(exerciseToSession)
    .sort((a, b) => b.started_at - a.started_at)
}

export async function deleteExercise(httpBase: string, id: string): Promise<void> {
  const res = await fetch(`${httpBase}/exercises/${id}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete exercise failed (${res.status})`)
  }
}

// --------------------------------------------------------------------------- //
// processed exercise data (the Streamlit-style review signals)
// --------------------------------------------------------------------------- //

export type ExerciseData = {
  exerciseId: string
  startedAt: string | null
  endedAt: string | null
  mouthOpening?: {
    values: ([number, number] | null)[]
    sampleRate: number
    framesDetected: number
    framesTotal: number
  }
  soundPressure?: { values: number[]; unit: string; sampleRate: number }
  footSpeed?: { values: number[]; unit: string; sampleRate: number }
  aggregates: {
    stepLengths: { values: number[]; unit: string }
    averages: Record<string, number | null>
    medians: Record<string, number | null>
  }
}

/** Fetch the processed signals for one exercise. `null` when it has no data yet (404). */
export async function fetchExerciseData(
  httpBase: string,
  id: string,
): Promise<ExerciseData | null> {
  const res = await fetch(`${httpBase}/exercises/${id}/data`, {
    credentials: 'include',
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`load data failed (${res.status})`)
  return (await res.json()) as ExerciseData
}
