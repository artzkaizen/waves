import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { Session } from '@/lib/sensor'
import { startRecording, stopRecording } from '@/lib/api'

type StartVars = { label: string; name: string | null; duration: number | null }

/** Build the canonical session object for an in-progress REST recording. */
function recordingSession(vars: StartVars, startedAtMs: number): Session {
  return {
    id: '',
    label: vars.label,
    name: vars.name,
    device: null,
    started_at: startedAtMs / 1000,
    ended_at: null,
    duration: vars.duration && vars.duration > 0 ? vars.duration : null,
    status: 'recording',
    reading_count: 0,
    audio_rate: null,
    has_audio: false,
    has_video: false,
    video_fps: null,
    notes: null,
  }
}

/** Connection lifecycle of the `/live` viewer socket. */
export type StreamStatus = 'connecting' | 'connected' | 'disconnected'

/** Imperative callbacks driven by incoming `/live` messages (PROTOCOL §3). */
export type StreamHandlers = {
  onReadings: (
    motion: number[][],
    audio: number[] | undefined,
    db: number | null,
  ) => void
  onSessionStarted: (session: Session) => void
  onSessionStopped: (session: Session) => void
}

/** Reactive state + actions exposed by the stream hook. */
export type SensorStream = {
  status: StreamStatus
  /** Number of connected producers (Pi clients). */
  producers: number
  activeSession: Session | null
  /** Live count of readings received since the active session started. */
  readingCount: number
  /** Local epoch-ms when the active session started (for the elapsed timer). */
  sessionStartedAt: number | null
  /** Latest server error string, e.g. `session_active: …`. */
  error: string | null
  startSession: (
    label: string,
    name: string | null,
    duration: number | null,
  ) => void
  stopSession: () => void
  clearError: () => void
}

/** Loosely-typed view of a server → viewer `/live` frame: producer count + readings. */
type ServerMessage = {
  type: string
  producers?: number
  motion?: number[][]
  audio?: number[]
  db?: number | null
  error?: string
  detail?: string
}

const INITIAL_BACKOFF = 1000
const MAX_BACKOFF = 10000

/**
 * Owns the `/live` viewer WebSocket: connects (with reconnect backoff), tracks
 * connection/producer/session state, fans incoming `readings` batches out to the
 * render engine via `handlers`, and sends `start_session`/`stop_session`. (Live
 * video is NOT on this socket — it is an MJPEG `<img>`, PROTOCOL §3.)
 */
export function useSensorStream(
  wsBase: string,
  httpBase: string,
  handlers: StreamHandlers,
): SensorStream {
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [producers, setProducers] = useState(0)
  const [readingCount, setReadingCount] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // Latest handlers + active session mirrored into refs so the socket effect and
  // the send helpers never reconnect/recreate on every render.
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const activeRef = useRef<Session | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  // Recording is a React Query mutation; the mutation IS the source of truth for the
  // active session — its `data` holds the exercise id, `variables` the label/name, and
  // `submittedAt` the start time. `activeSession` / `sessionStartedAt` are derived from
  // it below, so nothing about the recording is mirrored into extra state or refs.
  const startMutation = useMutation({
    mutationFn: (vars: StartVars) =>
      startRecording(httpBase, { label: vars.label, name: vars.name }),
    onMutate: () => {
      setError(null)
      setReadingCount(0)
    },
    onSuccess: (_id, vars, _ctx) =>
      handlersRef.current.onSessionStarted(recordingSession(vars, Date.now())),
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'could not start recording'),
  })

  const stopMutation = useMutation({
    mutationFn: () => {
      const id = startMutation.data
      return id ? stopRecording(httpBase, id) : Promise.resolve(undefined)
    },
    // Clear the recording on settle (success OR failure) by resetting the start mutation,
    // which makes `activeSession` derive back to null. Never a no-op.
    onSettled: () => {
      const stopped = activeRef.current
      startMutation.reset()
      setReadingCount(0)
      if (stopped) handlersRef.current.onSessionStopped(stopped)
    },
  })

  // Derived — the recording's state lives entirely in `startMutation`.
  const activeSession = useMemo<Session | null>(
    () =>
      startMutation.isSuccess && startMutation.variables
        ? recordingSession(startMutation.variables, startMutation.submittedAt)
        : null,
    [startMutation.isSuccess, startMutation.variables, startMutation.submittedAt],
  )
  activeRef.current = activeSession
  const sessionStartedAt = activeSession ? startMutation.submittedAt : null

  useEffect(() => {
    let cancelled = false
    let backoff = INITIAL_BACKOFF
    let retry: ReturnType<typeof setTimeout> | null = null

    const handleMessage = (msg: ServerMessage) => {
      // The /live socket is a live subscription only: producer count + readings fanout.
      // Recording lifecycle is owned by the REST mutations, not this socket.
      switch (msg.type) {
        case 'welcome':
        case 'producer_status':
          setProducers(msg.producers ?? 0)
          break
        case 'readings':
          if (Array.isArray(msg.motion)) {
            setReadingCount((c) => c + msg.motion!.length)
            handlersRef.current.onReadings(msg.motion, msg.audio, msg.db ?? null)
          }
          break
        case 'error':
          setError(
            msg.error
              ? msg.detail
                ? `${msg.error}: ${msg.detail}`
                : msg.error
              : 'error',
          )
          break
      }
    }

    const scheduleRetry = () => {
      if (cancelled) return
      retry = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, MAX_BACKOFF)
    }

    const connect = () => {
      if (cancelled) return
      setStatus('connecting')
      let ws: WebSocket
      try {
        ws = new WebSocket(`${wsBase}/live`)
      } catch {
        scheduleRetry()
        return
      }
      wsRef.current = ws

      ws.onopen = () => {
        if (cancelled) return
        backoff = INITIAL_BACKOFF
        setStatus('connected')
        ws.send(JSON.stringify({ type: 'hello', role: 'viewer' }))
      }
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return
        let msg: ServerMessage
        try {
          msg = JSON.parse(ev.data) as ServerMessage
        } catch {
          return
        }
        handleMessage(msg)
      }
      ws.onerror = () => {
        // `onclose` always follows — reconnection is handled there.
      }
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null
        if (cancelled) return
        setStatus('disconnected')
        setProducers(0)
        // Recording is REST-owned, so a dropped /live socket does NOT cancel it — the
        // server keeps persisting; only the live charts pause until the socket reconnects.
        scheduleRetry()
      }
    }

    connect()

    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
      const ws = wsRef.current
      wsRef.current = null
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        try {
          ws.close()
        } catch {
          /* already closing — ignore */
        }
      }
    }
  }, [wsBase])

  const startSession = useCallback(
    (label: string, name: string | null, duration: number | null) => {
      startMutation.mutate({ label, name, duration })
    },
    [startMutation],
  )

  const stopSession = useCallback(() => {
    if (startMutation.data) stopMutation.mutate()
  }, [startMutation.data, stopMutation])

  const clearError = useCallback(() => setError(null), [])

  return {
    status,
    producers,
    activeSession,
    readingCount,
    sessionStartedAt,
    error,
    startSession,
    stopSession,
    clearError,
  }
}
