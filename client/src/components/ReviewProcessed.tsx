import type { CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchExerciseData, type ExerciseData } from '@/lib/api'

const card: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 18,
  boxShadow: '0 1px 2px rgba(0,0,0,.04)',
  padding: 16,
}

const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0)
const fmt = (v: number | null | undefined, d = 2) =>
  v == null || Number.isNaN(v) ? '—' : v.toFixed(d)

/** Minimal autoscaled SVG line chart. */
function LineChart({ values, color }: { values: number[]; color: string }) {
  const W = 480
  const H = 90
  if (!values.length) {
    return (
      <div
        style={{
          height: H,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--muted-foreground)',
          fontSize: 12,
        }}
      >
        no data
      </div>
    )
  }
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const span = hi - lo || 1
  const pts = values
    .map((v, i) => {
      const x = (i / Math.max(1, values.length - 1)) * W
      const y = H - ((v - lo) / span) * (H - 8) - 4
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: H, display: 'block' }}
    >
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  )
}

function StatRow({ items }: { items: [string, string][] }) {
  return (
    <div style={{ display: 'flex', gap: 24, marginTop: 8, flexWrap: 'wrap' }}>
      {items.map(([label, value]) => (
        <div key={label}>
          <div style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
            {value}
          </div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--muted-foreground)',
              textTransform: 'uppercase',
              letterSpacing: '.04em',
            }}
          >
            {label}
          </div>
        </div>
      ))}
    </div>
  )
}

function Section({
  title,
  values,
  color,
  stats,
}: {
  title: string
  values: number[]
  color: string
  stats: [string, string][]
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <LineChart values={values} color={color} />
      <StatRow items={stats} />
    </div>
  )
}

function panels(d: ExerciseData) {
  const sp = d.soundPressure?.values ?? []
  const fs = d.footSpeed?.values ?? []
  const steps = d.aggregates?.stepLengths?.values ?? []
  const mo = d.mouthOpening
  // mouth opening: plot the vertical component; null frames (no face) drop to 0.
  const moVert = (mo?.values ?? []).map((p) => (p ? p[0] : 0))
  const moDetected = (mo?.values ?? []).filter((p) => p != null).map((p) => (p as [number, number])[0])
  const facePct = mo && mo.framesTotal ? (100 * mo.framesDetected) / mo.framesTotal : 0
  return { sp, fs, steps, mo, moVert, moDetected, facePct }
}

export function ReviewProcessed({
  httpBase,
  sessionId,
}: {
  httpBase: string
  sessionId: string
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['exercise-data', httpBase, sessionId],
    queryFn: () => fetchExerciseData(httpBase, sessionId),
    // Poll briefly: processing starts on session end and finishes a beat later.
    refetchInterval: (q) => (q.state.data ? false : 2000),
  })

  return (
    <div style={{ ...card, marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Processed signals</div>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio
          controls
          src={`${httpBase}/api/exercises/${sessionId}/audio.wav`}
          style={{ height: 32 }}
        />
      </div>

      {isLoading || !data ? (
        <div
          style={{
            padding: '28px 0',
            textAlign: 'center',
            color: 'var(--muted-foreground)',
            fontSize: 13,
          }}
        >
          {isLoading ? 'Loading…' : 'Processing… (starts when the session ends)'}
        </div>
      ) : (
        (() => {
          const p = panels(data)
          return (
            <div style={{ marginTop: 14 }}>
              <Section
                title="Sound Pressure (relative dB)"
                values={p.sp}
                color="oklch(0.62 0.19 250)"
                stats={[
                  ['mean dB', fmt(mean(p.sp))],
                  ['max dB', fmt(p.sp.length ? Math.max(...p.sp) : null)],
                  ['min dB', fmt(p.sp.length ? Math.min(...p.sp) : null)],
                ]}
              />
              <Section
                title="Foot Speed (cm/s)"
                values={p.fs}
                color="oklch(0.62 0.17 150)"
                stats={[
                  ['mean', fmt(mean(p.fs))],
                  ['max', fmt(p.fs.length ? Math.max(...p.fs) : null)],
                  ['steps', String(p.steps.length)],
                  ['avg step len', fmt(mean(p.steps))],
                ]}
              />
              <Section
                title="Mouth Opening (ratio)"
                values={p.moVert}
                color="oklch(0.68 0.16 40)"
                stats={[
                  ['face detected', `${Math.round(p.facePct)}%`],
                  ['mean ratio', fmt(mean(p.moDetected), 3)],
                  ['max ratio', fmt(p.moDetected.length ? Math.max(...p.moDetected) : null, 3)],
                ]}
              />
            </div>
          )
        })()
      )}
    </div>
  )
}
