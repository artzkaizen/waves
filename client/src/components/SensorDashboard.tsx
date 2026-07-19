import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  Activity,
  Camera,
  Maximize2,
  Mic,
  Minimize2,
  Moon,
  Sun,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsPopover } from '@/components/SettingsPopover'
import {
  useSensorEngine,
  type ReviewData,
  type SensorEngineApi,
} from '@/hooks/useSensorEngine'
import {
  useSensorStream,
  type StreamHandlers,
  type StreamStatus,
} from '@/hooks/useSensorStream'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchSessions, deleteExercise } from '@/lib/api'
import { ReviewProcessed } from '@/components/ReviewProcessed'
import { SummaryTable } from '@/components/SummaryTable'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useTheme } from '@/hooks/useTheme'
import {
  formatSize,
  formatTime,
  normalizeServerUrl,
  sessionSizeKB,
  sparkPoints,
  type Session,
  type SessionDetail,
} from '@/lib/sensor'

const QUICK_LABELS = ['normal', 'medium', 'big'] as const

const card: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 18,
  boxShadow: '0 1px 2px rgba(0,0,0,.04)',
}

const mono = 'var(--font-mono), monospace'

const STATUS_META: Record<StreamStatus, { color: string; text: string }> = {
  connecting: { color: 'oklch(0.75 0.15 80)', text: 'Connecting' },
  connected: { color: 'oklch(0.62 0.17 150)', text: 'Connected' },
  disconnected: { color: 'var(--destructive)', text: 'Disconnected' },
}

const EMPTY_REVIEW: ReviewData = {
  audio: [],
  ax: [],
  ay: [],
  az: [],
  gx: [],
  gy: [],
  gz: [],
}

/** Build the engine's frozen review charts from a fetched session detail (v2: no frames). */
function buildReview(d: SessionDetail): ReviewData {
  return {
    audio: d.audio ?? [],
    ax: d.motion.ax,
    ay: d.motion.ay,
    az: d.motion.az,
    gx: d.motion.gx,
    gy: d.motion.gy,
    gz: d.motion.gz,
  }
}

/** Elapsed seconds → m:ss. */
function formatElapsed(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

/** Human-readable session duration for a library row. */
function sessionDuration(s: Session): string {
  if (s.status === 'recording') return 'rec'
  if (s.duration != null) return `${Math.round(s.duration)}s`
  if (s.ended_at != null) return `${Math.round(s.ended_at - s.started_at)}s`
  return '—'
}

/** The waves brand mark (a stylised signal). */
function WaveMark({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--primary)"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12c2 0 2-5 4-5s2 10 4 10 2-12 4-12 2 9 4 9 2-2 2-2" />
    </svg>
  )
}

function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div
        style={{
          fontSize: 26,
          fontWeight: 700,
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 11,
          color: 'var(--muted-foreground)',
          textTransform: 'uppercase',
          letterSpacing: '.04em',
          marginTop: 4,
        }}
      >
        {label}
      </div>
    </div>
  )
}

function PanelHeader({
  icon,
  title,
  subtitle,
  right,
}: {
  icon: ReactNode
  title: string
  subtitle: string
  right?: ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 16px 12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ display: 'flex' }}>{icon}</span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
            {subtitle}
          </div>
        </div>
      </div>
      {right}
    </div>
  )
}

const liveTagStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--muted-foreground)',
}

const CAM_HEIGHT = 210

/** Cover-fit an MJPEG/poster `<img>` over the camera canvas. */
const camMediaStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'block',
  width: '100%',
  height: CAM_HEIGHT,
  objectFit: 'cover',
  background: '#0c0d10',
}

/** Solid placeholder shown when there is no camera media (waiting / unavailable). */
const camPlaceholderStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  background: '#0c0d10',
  color: 'rgba(255,255,255,.55)',
  fontFamily: mono,
  fontSize: 12,
  letterSpacing: '.02em',
}

type PanelKey = 'camera' | 'mic' | 'motion'

/** When a panel is maximized, its card floats to a large centered overlay. */
const expandedCardStyle: CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(1080px, calc(100vw - 40px))',
  maxHeight: 'calc(100vh - 40px)',
  overflow: 'auto',
  zIndex: 100,
  boxShadow: '0 30px 80px -20px rgba(0,0,0,.55)',
}

/** Small maximize/minimize button shown in each sensor panel header. */
function ExpandToggle({
  on,
  onToggle,
  label,
}: {
  on: boolean
  onToggle: () => void
  label: string
}) {
  return (
    <button
      type="button"
      aria-label={on ? `Collapse ${label}` : `Expand ${label}`}
      title={on ? 'Collapse' : 'Expand'}
      onClick={onToggle}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: 'var(--card)',
        color: 'var(--muted-foreground)',
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
      }}
    >
      {on ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
    </button>
  )
}

export function SensorDashboard() {
  const { theme, toggle: toggleTheme } = useTheme()

  // Settings (persisted).
  const [server, setServer] = useLocalStorage('waves-server', 'localhost:8000')
  const [sessionSeconds, setSessionSeconds] = useLocalStorage(
    'waves-session-seconds',
    5,
  )
  const [demoMode, setDemoMode] = useLocalStorage('waves-demo-mode', false)

  // Session-control + review state.
  const [currentLabel, setCurrentLabel] = useState('normal')
  const [audioMap, setAudioMap] = useState<Record<string, number[]>>({})
  const [reviewSession, setReviewSession] = useState<Session | null>(null)
  const [review, setReview] = useState<ReviewData | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  // True once the active camera media (<img> MJPEG/video) fails to load.
  const [camError, setCamError] = useState(false)
  // Session ids whose poster.jpg thumbnail failed — fall back to a letter box.
  const [posterFailed, setPosterFailed] = useState<Set<string>>(new Set())
  // Which sensor panel is maximized to the large overlay (null = none).
  const [expanded, setExpanded] = useState<PanelKey | null>(null)

  const { ws: wsBase, http: httpBase } = useMemo(
    () => normalizeServerUrl(server),
    [server],
  )

  // Cache of fetched session details — powers row sparklines/thumbs + instant review.
  const detailCache = useRef<Map<string, SessionDetail>>(new Map())
  // The render engine's imperative handle (assigned below, read by stream handlers).
  const engineApiRef = useRef<SensorEngineApi | null>(null)

  const queryClient = useQueryClient()
  // The recorded-exercise library (experiment-api), via React Query. No fetch-in-effect.
  const { data: sessions = [] } = useQuery({
    queryKey: ['sessions', httpBase],
    queryFn: () => fetchSessions(httpBase),
  })
  const refreshSessions = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
    [queryClient],
  )

  // The /live socket fans readings straight into the engine (off the React path).
  const handlers: StreamHandlers = {
    onReadings: (motion, audio, db) =>
      engineApiRef.current?.pushReadings(motion, audio, db),
    onSessionStarted: () => engineApiRef.current?.clearLive(),
    onSessionStopped: () => {
      void refreshSessions()
    },
  }
  const stream = useSensorStream(wsBase, httpBase, handlers)

  const mode: 'live' | 'review' = reviewSession ? 'review' : 'live'

  // What the camera panel shows:
  //   review  → the reviewed session's recorded video.mjpeg (poster fallback)
  //   demo    → synthetic camera canvas (demo forced, or server offline)
  //   live    → live /api/stream.mjpeg (connected + a producer is streaming)
  //   waiting → "waiting for camera" placeholder (connected, but no producer)
  const camState: 'live' | 'review' | 'demo' | 'waiting' = reviewSession
    ? 'review'
    : demoMode
      ? 'demo'
      : stream.status === 'connected' && stream.producers > 0
        ? 'live'
        : 'waiting'

  // Charts render REAL data only. With no producer connected (or the server
  // offline) they go idle/empty so the dashboard truthfully reflects whether the
  // Pi is streaming. Synthetic "demo" data appears ONLY when explicitly enabled
  // in Settings → Demo mode.
  const source: 'demo' | 'live' | 'idle' =
    camState === 'demo' ? 'demo' : camState === 'live' ? 'live' : 'idle'

  const engine = useSensorEngine({ mode, source, review, theme })
  engineApiRef.current = engine
  const { refs } = engine
  const engineResize = engine.resize

  const recording = stream.activeSession != null

  // Maximize / restore a sensor panel.
  const toggleExpand = (k: PanelKey) =>
    setExpanded((cur) => (cur === k ? null : k))
  // Canvas heights grow for whichever panel is maximized.
  const camH = expanded === 'camera' ? 'min(70vh, 760px)' : CAM_HEIGHT
  const camMedia: CSSProperties = { ...camMediaStyle, height: camH }
  const waveH = expanded === 'mic' ? 'min(58vh, 620px)' : 150
  const motionH = expanded === 'motion' ? 'min(34vh, 360px)' : 78

  // Tick the elapsed timer while recording (low frequency — not the 60fps path).
  useEffect(() => {
    if (!recording) return
    const id = setInterval(() => setNowMs(Date.now()), 250)
    return () => clearInterval(id)
  }, [recording])

  // The camera footer note tracks what the panel is currently showing.
  useEffect(() => {
    const el = refs.camMeta.current
    if (el)
      el.textContent =
        camState === 'review'
          ? 'recorded video'
          : camState === 'live'
            ? 'live MJPEG'
            : camState === 'waiting'
              ? 'no camera'
              : 'demo feed'
  }, [camState, refs.camMeta])

  // Reset the media-error flag whenever the camera target changes (new source,
  // server, or reviewed session) so a fresh <img> load gets a clean attempt.
  useEffect(() => {
    setCamError(false)
  }, [camState, reviewSession?.id, httpBase])

  // While a panel is maximized: Escape closes it and the page scroll is locked.
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(null)
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [expanded])

  // Re-measure the canvases once the expand/collapse layout has settled so the
  // charts redraw crisply at the new size (not stretched from the old one).
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => engineResize()),
    )
    return () => cancelAnimationFrame(id)
  }, [expanded, engineResize])

  // Review mode freezes the RAF loop, which otherwise writes the live wall-clock
  // into the camera clock readout — stamp it with the reviewed session's time
  // instead so no stale "now" lingers (fix 5e). Live/demo: the engine drives it.
  useEffect(() => {
    if (camState !== 'review') return
    const el = refs.camClock.current
    if (el)
      el.textContent = reviewSession
        ? formatTime(reviewSession.started_at * 1000)
        : '--:--:--'
  }, [camState, reviewSession, refs.camClock])

  const elapsed = stream.sessionStartedAt
    ? Math.max(0, (nowMs - stream.sessionStartedAt) / 1000)
    : 0

  const selectSession = (s: Session) => {
    // The experiment-api serves processed signals (mouthOpening/soundPressure/footSpeed)
    // rather than the raw motion the review charts were built for, so review freezes on
    // the recorded poster + metadata; the charts stay empty until that mapping is built.
    const detail = detailCache.current.get(s.id) ?? null
    setReviewSession(s)
    setReview(detail ? buildReview(detail) : EMPTY_REVIEW)
  }

  const backToLive = () => {
    setReviewSession(null)
    setReview(null)
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteExercise(httpBase, id),
    onSuccess: (_res, id) => {
      detailCache.current.delete(id)
      setAudioMap((m) => {
        const next = { ...m }
        delete next[id]
        return next
      })
      setPosterFailed((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      if (reviewSession?.id === id) backToLive()
      void refreshSessions()
    },
  })
  const deleteSession = (id: string) => deleteMutation.mutate(id)

  const startSession = () =>
    stream.startSession(
      currentLabel.trim() || 'sample',
      null,
      sessionSeconds > 0 ? sessionSeconds : null,
    )

  const startDisabled =
    stream.status !== 'connected' || stream.producers === 0
  const startReason =
    stream.status === 'connecting'
      ? 'Connecting to the server…'
      : stream.status !== 'connected'
        ? `Can't reach the server at ${server}`
        : stream.producers === 0
          ? 'Waiting for a producer (Pi) to connect'
          : null

  const statusMeta = STATUS_META[stream.status]
  const producerText =
    stream.status === 'connected'
      ? stream.producers > 0
        ? `${stream.producers} producer${stream.producers === 1 ? '' : 's'}`
        : 'no producer'
      : demoMode
        ? 'demo mode'
        : stream.status === 'connecting'
          ? 'connecting'
          : 'offline'
  const phase =
    mode === 'review'
      ? 'reviewing'
      : recording
        ? 'recording'
        : camState === 'live'
          ? 'live'
          : camState === 'demo'
            ? 'demo'
            : 'idle'

  // Panel corner tag mirrors what the panels are actually showing.
  const liveTag =
    camState === 'review'
      ? 'reviewing'
      : recording
        ? '● recording'
        : camState === 'live'
          ? '● live'
          : camState === 'waiting'
            ? '○ waiting'
            : '○ demo'

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--background)',
        color: 'var(--foreground)',
        fontFamily: "'Figtree Variable', system-ui, sans-serif",
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        maxWidth: 1320,
        margin: '0 auto',
      }}
    >
      {/* Header */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <WaveMark />
          <div style={{ lineHeight: 1.15 }}>
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                letterSpacing: '-.02em',
              }}
            >
              waves
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
              Multi-modal capture · {wsBase.replace(/^wss?:\/\//, '')}
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '6px 12px',
              border: '1px solid var(--border)',
              borderRadius: 9999,
              background: 'var(--card)',
              fontSize: 13,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: statusMeta.color,
                animation:
                  stream.status === 'connected'
                    ? 'wv-pulse 1.6s ease-in-out infinite'
                    : undefined,
              }}
            />
            <span style={{ fontWeight: 500 }}>{statusMeta.text}</span>
            <span style={{ color: 'var(--muted-foreground)' }}>
              · {producerText}
            </span>
          </div>
          <Badge variant={recording ? 'destructive' : 'secondary'}>{phase}</Badge>
          <Button
            variant="outline"
            size="icon"
            aria-label={
              theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
            }
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
          <SettingsPopover
            server={server}
            onServerChange={setServer}
            sessionSeconds={sessionSeconds}
            onSessionSecondsChange={setSessionSeconds}
            demoMode={demoMode}
            onDemoModeChange={setDemoMode}
          />
        </div>
      </header>

      {/* Session bar */}
      <section
        style={{
          ...card,
          padding: '16px 18px',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          gap: 20,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            minWidth: 200,
            flex: '1 1 240px',
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--muted-foreground)',
              textTransform: 'uppercase',
              letterSpacing: '.04em',
            }}
          >
            Session label
          </span>
          <Input
            value={currentLabel}
            onChange={(e) => setCurrentLabel(e.target.value)}
            placeholder="shake, tap, idle…"
            disabled={recording}
          />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {QUICK_LABELS.map((name) => (
              <Button
                key={name}
                size="sm"
                variant={currentLabel === name ? 'default' : 'outline'}
                disabled={recording}
                onClick={() => setCurrentLabel(name)}
              >
                {name}
              </Button>
            ))}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 8,
            flex: '1 1 auto',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 24,
              justifyContent: 'flex-end',
              flexWrap: 'wrap',
            }}
          >
            {recording ? (
              <>
                <Stat value={formatElapsed(elapsed)} label="elapsed" />
                <Stat value={stream.readingCount} label="readings" />
                <Button
                  size="lg"
                  variant="destructive"
                  onClick={stream.stopSession}
                >
                  ■ Stop session
                </Button>
              </>
            ) : (
              <>
                <Stat value={sessions.length} label="sessions" />
                <Button size="lg" disabled={startDisabled} onClick={startSession}>
                  ● Start session
                </Button>
              </>
            )}
          </div>
          {stream.error ? (
            <button
              type="button"
              onClick={stream.clearError}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                fontSize: 12,
                color: 'var(--destructive)',
                textAlign: 'right',
              }}
            >
              {stream.error} · dismiss
            </button>
          ) : startReason ? (
            <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
              {startReason}
            </span>
          ) : null}
        </div>
      </section>

      {/* Review banner */}
      {reviewSession && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            background: 'var(--accent)',
            border: '1px solid var(--border)',
            borderRadius: 14,
            padding: '10px 16px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 14,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontWeight: 600 }}>Reviewing</span>
            <span style={{ fontWeight: 600 }}>{reviewSession.label}</span>
            <span style={{ fontFamily: mono, color: 'var(--muted-foreground)' }}>
              #{reviewSession.id}
            </span>
            <span style={{ color: 'var(--muted-foreground)' }}>
              · {formatTime(reviewSession.started_at * 1000)}
            </span>
          </div>
          <Button size="sm" variant="outline" onClick={backToLive}>
            Back to live
          </Button>
        </div>
      )}

      {/* Dimmed backdrop behind a maximized panel (click anywhere to close). */}
      {expanded && (
        <div
          aria-hidden="true"
          onClick={() => setExpanded(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99,
            background: 'rgba(0,0,0,.45)',
          }}
        />
      )}

      {/* Sensor panels */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: 16,
          alignItems: 'start',
        }}
      >
        {/* Camera */}
        <div
          style={{
            ...card,
            overflow: 'hidden',
            ...(expanded === 'camera' ? expandedCardStyle : {}),
          }}
        >
          <PanelHeader
            icon={<Camera size={18} />}
            title="Camera"
            subtitle="live MJPEG · camera"
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={liveTagStyle}>{liveTag}</span>
                <ExpandToggle
                  on={expanded === 'camera'}
                  onToggle={() => toggleExpand('camera')}
                  label="camera"
                />
              </div>
            }
          />
          <div style={{ position: 'relative', background: '#0c0d10' }}>
            <canvas
              ref={refs.cam}
              style={{ display: 'block', width: '100%', height: camH }}
            />

            {/* Camera media overlays (cover the canvas; clock + REC stack above). */}
            {camState === 'live' &&
              (camError ? (
                <div style={camPlaceholderStyle}>
                  <Camera size={22} style={{ opacity: 0.6 }} />
                  <span>camera unavailable</span>
                </div>
              ) : (
                <img
                  key={`live:${httpBase}`}
                  src={`${httpBase}/api/stream.mjpeg`}
                  alt="live camera"
                  onError={() => setCamError(true)}
                  style={camMedia}
                />
              ))}

            {camState === 'waiting' && (
              <div style={camPlaceholderStyle}>
                <Camera size={22} style={{ opacity: 0.6 }} />
                <span>waiting for camera</span>
              </div>
            )}

            {camState === 'review' && reviewSession && (
              <>
                {/* No video on disk → fall back to poster, then to a quiet box. */}
                {camError && (
                  <div style={camPlaceholderStyle}>
                    <Camera size={22} style={{ opacity: 0.6 }} />
                    <span>no recorded video</span>
                  </div>
                )}
                {camError ? (
                  <img
                    key={`poster:${reviewSession.id}`}
                    src={`${httpBase}/api/exercises/${reviewSession.id}/poster.jpg`}
                    alt="session poster"
                    onError={(e) => {
                      e.currentTarget.style.visibility = 'hidden'
                    }}
                    style={camMedia}
                  />
                ) : (
                  <img
                    key={`video:${reviewSession.id}`}
                    src={`${httpBase}/api/exercises/${reviewSession.id}/video.mjpeg`}
                    alt="recorded session video"
                    onError={() => setCamError(true)}
                    style={camMedia}
                  />
                )}
              </>
            )}

            <div
              ref={refs.camClock}
              style={{
                position: 'absolute',
                top: 8,
                left: 10,
                fontFamily: mono,
                fontSize: 11,
                color: 'rgba(255,255,255,.78)',
                textShadow: '0 1px 2px rgba(0,0,0,.6)',
              }}
            >
              --:--:--
            </div>
            {recording && mode !== 'review' && (
              <div
                style={{
                  position: 'absolute',
                  top: 8,
                  right: 10,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  fontFamily: mono,
                  fontSize: 11,
                  color: '#fff',
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: 'var(--destructive)',
                    animation: 'wv-rec 1s steps(1) infinite',
                  }}
                />
                REC
              </div>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '11px 16px',
              fontSize: 12,
              color: 'var(--muted-foreground)',
            }}
          >
            <span>MJPEG · multipart stream</span>
            <span ref={refs.camMeta}>live MJPEG</span>
          </div>
        </div>

        {/* Microphone */}
        <div
          style={{
            ...card,
            overflow: 'hidden',
            ...(expanded === 'mic' ? expandedCardStyle : {}),
          }}
        >
          <PanelHeader
            icon={<Mic size={18} />}
            title="Microphone"
            subtitle="16 kHz · mono · int16"
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={liveTagStyle}>{liveTag}</span>
                <ExpandToggle
                  on={expanded === 'mic'}
                  onToggle={() => toggleExpand('mic')}
                  label="microphone"
                />
              </div>
            }
          />
          <div style={{ background: 'var(--muted)' }}>
            <canvas
              ref={refs.wave}
              style={{ display: 'block', width: '100%', height: waveH }}
            />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 16px',
            }}
          >
            <span
              style={{ fontSize: 11, color: 'var(--muted-foreground)', width: 30 }}
            >
              dB
            </span>
            <div
              style={{
                flex: 1,
                height: 8,
                borderRadius: 9999,
                background: 'var(--muted)',
                overflow: 'hidden',
              }}
            >
              <div
                ref={refs.dbBar}
                style={{
                  height: '100%',
                  width: '30%',
                  background: 'var(--chart-3)',
                  borderRadius: 9999,
                  transition: 'width .08s linear',
                }}
              />
            </div>
            <span
              ref={refs.db}
              style={{
                fontFamily: mono,
                fontSize: 13,
                fontWeight: 600,
                width: 74,
                textAlign: 'right',
              }}
            >
              -48.0 dB
            </span>
          </div>
        </div>

        {/* Motion */}
        <div
          style={{
            ...card,
            overflow: 'hidden',
            ...(expanded === 'motion' ? expandedCardStyle : {}),
          }}
        >
          <PanelHeader
            icon={<Activity size={18} />}
            title="Motion · MPU-6050"
            subtitle="accel + gyro · 40 Hz"
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  style={{ display: 'flex', gap: 9, fontSize: 11, fontWeight: 600 }}
                >
                  <span style={{ color: 'var(--chart-1)' }}>X</span>
                  <span style={{ color: 'var(--chart-2)' }}>Y</span>
                  <span style={{ color: 'var(--chart-3)' }}>Z</span>
                </div>
                <ExpandToggle
                  on={expanded === 'motion'}
                  onToggle={() => toggleExpand('motion')}
                  label="motion"
                />
              </div>
            }
          />
          <div style={{ padding: '0 4px' }}>
            <div
              style={{
                fontSize: 10,
                color: 'var(--muted-foreground)',
                textTransform: 'uppercase',
                letterSpacing: '.05em',
                padding: '0 12px 2px',
              }}
            >
              Accelerometer · g
            </div>
            <canvas
              ref={refs.accel}
              style={{ display: 'block', width: '100%', height: motionH }}
            />
            <div
              style={{
                fontSize: 10,
                color: 'var(--muted-foreground)',
                textTransform: 'uppercase',
                letterSpacing: '.05em',
                padding: '6px 12px 2px',
              }}
            >
              Gyroscope · °/s
            </div>
            <canvas
              ref={refs.gyro}
              style={{ display: 'block', width: '100%', height: motionH }}
            />
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 8,
              padding: '12px 16px',
              fontFamily: mono,
              fontSize: 12,
            }}
          >
            <span ref={refs.ax} style={{ color: 'var(--chart-1)' }}>
              x +0.00
            </span>
            <span ref={refs.ay} style={{ color: 'var(--chart-2)' }}>
              y +0.00
            </span>
            <span ref={refs.az} style={{ color: 'var(--chart-3)' }}>
              z +1.00
            </span>
          </div>
        </div>
      </section>

      {/* Processed review signals (Streamlit-parity: sound pressure / foot speed / mouth opening) */}
      {reviewSession && (
        <ReviewProcessed httpBase={httpBase} sessionId={reviewSession.id} />
      )}

      {/* Research summary — cross-recording comparison of normal/medium/big */}
      <SummaryTable httpBase={httpBase} sessions={sessions} />

      {/* Sessions library */}
      <section style={{ ...card, padding: '16px 18px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
            marginBottom: 14,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Sessions</h2>
            <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
              {httpBase}/api/exercises · {sessions.length}
            </span>
          </div>
          <Button size="sm" variant="outline" onClick={() => void refreshSessions()}>
            Refresh
          </Button>
        </div>

        {sessions.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sessions.map((s) => {
              const selected = s.id === reviewSession?.id
              // v2 thumbnail: the session poster (first recorded frame), with a
              // graceful letter-box fallback for audio-only sessions / load errors.
              const showPoster = s.has_video && !posterFailed.has(s.id)
              return (
                <div
                  key={s.id}
                  className="wv-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => void selectSession(s)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      void selectSession(s)
                    }
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '10px 12px',
                    border: `1px solid ${selected ? 'var(--ring)' : 'var(--border)'}`,
                    borderRadius: 14,
                    cursor: 'pointer',
                    background: selected ? 'var(--accent)' : 'transparent',
                  }}
                >
                  {showPoster ? (
                    <img
                      src={`${httpBase}/api/exercises/${s.id}/poster.jpg`}
                      alt={`${s.label} poster`}
                      onError={() =>
                        setPosterFailed((prev) => {
                          if (prev.has(s.id)) return prev
                          const next = new Set(prev)
                          next.add(s.id)
                          return next
                        })
                      }
                      style={{
                        width: 52,
                        height: 36,
                        borderRadius: 8,
                        objectFit: 'cover',
                        background: '#0c0d10',
                        flexShrink: 0,
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 52,
                        height: 36,
                        borderRadius: 8,
                        background: '#0c0d10',
                        color: 'rgba(255,255,255,.5)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontFamily: mono,
                        fontSize: 13,
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                    >
                      {s.label.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div style={{ minWidth: 120, flex: '1 1 160px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>
                        {s.label}
                      </span>
                      {s.status === 'recording' && (
                        <Badge variant="destructive">rec</Badge>
                      )}
                    </div>
                    <div
                      style={{
                        fontFamily: mono,
                        fontSize: 11,
                        color: 'var(--muted-foreground)',
                      }}
                    >
                      #{s.id} · {s.reading_count} readings
                    </div>
                  </div>
                  <svg
                    width={120}
                    height={30}
                    viewBox="0 0 120 30"
                    preserveAspectRatio="none"
                    style={{ flexShrink: 0 }}
                    aria-hidden="true"
                  >
                    <polyline
                      points={sparkPoints(audioMap[s.id] ?? [])}
                      fill="none"
                      stroke="var(--chart-3)"
                      strokeWidth={1.4}
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--muted-foreground)',
                      fontVariantNumeric: 'tabular-nums',
                      width: 54,
                      textAlign: 'right',
                    }}
                  >
                    {formatTime(s.started_at * 1000)}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--muted-foreground)',
                      fontVariantNumeric: 'tabular-nums',
                      width: 42,
                      textAlign: 'right',
                    }}
                  >
                    {sessionDuration(s)}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--muted-foreground)',
                      fontVariantNumeric: 'tabular-nums',
                      width: 70,
                      textAlign: 'right',
                    }}
                  >
                    {formatSize(sessionSizeKB(s))}
                  </span>
                  <a
                    href={`${httpBase}/api/exercises/${s.id}/export.csv`}
                    onClick={(e) => e.stopPropagation()}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--primary)',
                      textDecoration: 'none',
                      flexShrink: 0,
                    }}
                  >
                    CSV
                  </a>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    aria-label={`Delete session ${s.id}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void deleteSession(s.id)
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              )
            })}
          </div>
        ) : (
          <div
            style={{
              textAlign: 'center',
              padding: '36px 16px',
              color: 'var(--muted-foreground)',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
              No sessions yet
            </div>
            <div style={{ fontSize: 13 }}>
              {stream.status === 'connected'
                ? stream.producers > 0
                  ? 'Enter a label and hit Start session to record.'
                  : 'Connect a producer (Pi), then start a session.'
                : 'Server offline — sessions you record will appear here.'}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
