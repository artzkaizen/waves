import type { CSSProperties } from 'react'
import { useQueries } from '@tanstack/react-query'
import { fetchExerciseData, type ExerciseData } from '@/lib/api'
import type { Session } from '@/lib/sensor'

const RESEARCH_LEVELS = ['normal', 'medium', 'big'] as const
type Level = (typeof RESEARCH_LEVELS)[number]

const card: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 18,
  boxShadow: '0 1px 2px rgba(0,0,0,.04)',
  padding: '16px 18px',
}

const th: CSSProperties = {
  textAlign: 'left',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  color: 'var(--muted-foreground)',
  padding: '6px 10px',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
}
const td: CSSProperties = {
  fontSize: 13,
  padding: '6px 10px',
  borderBottom: '1px solid var(--border)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const fmt = (v: number | null | undefined, d = 2) =>
  v == null || Number.isNaN(v) ? '—' : v.toFixed(d)

type Row = {
  id: string
  label: string
  level: Level | null
  meanDb: number | null
  maxFootSpeed: number | null
  meanMouth: number | null
  stepCount: number | null
}

function rowFrom(session: Session, data: ExerciseData | null): Row {
  const lvl = (RESEARCH_LEVELS as readonly string[]).includes(session.label)
    ? (session.label as Level)
    : null
  const avg = data?.aggregates?.averages ?? {}
  const fs = data?.footSpeed?.values ?? []
  return {
    id: session.id,
    label: session.label,
    level: lvl,
    meanDb: (avg.soundPressure as number) ?? null,
    maxFootSpeed: fs.length ? Math.max(...fs) : null,
    meanMouth: (avg.mouthOpeningVertical as number) ?? null,
    stepCount: data ? (data.aggregates?.stepLengths?.values?.length ?? 0) : null,
  }
}

const meanOf = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null && !Number.isNaN(x))
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null
}

export function SummaryTable({
  httpBase,
  sessions,
}: {
  httpBase: string
  sessions: Session[]
}) {
  // One /data query per recording with data (cached; processing already ran on stop).
  const withData = sessions.filter((s) => s.has_audio || s.has_video || s.reading_count > 0)
  const results = useQueries({
    queries: withData.map((s) => ({
      queryKey: ['exercise-data', httpBase, s.id],
      queryFn: () => fetchExerciseData(httpBase, s.id),
      staleTime: 60_000,
    })),
  })

  const rows: Row[] = withData
    .map((s, i) => rowFrom(s, results[i]?.data ?? null))
    .filter((r) => r.meanDb != null || r.maxFootSpeed != null || r.meanMouth != null)

  if (rows.length === 0) return null

  const leveled = rows.filter((r) => r.level)
  const byLevel = RESEARCH_LEVELS.map((lvl) => {
    const rs = leveled.filter((r) => r.level === lvl)
    if (!rs.length) return null
    return {
      level: lvl,
      meanDb: meanOf(rs.map((r) => r.meanDb)),
      maxFootSpeed: meanOf(rs.map((r) => r.maxFootSpeed)),
      meanMouth: meanOf(rs.map((r) => r.meanMouth)),
    }
  }).filter((x): x is NonNullable<typeof x> => x != null)

  const normal = byLevel.find((b) => b.level === 'normal')
  const big = byLevel.find((b) => b.level === 'big')
  const conclusion: string[] = []
  if (normal && big) {
    if (normal.meanDb != null && big.meanDb != null)
      conclusion.push(
        `Voice went from ${normal.meanDb.toFixed(1)} dB (normal) to ${big.meanDb.toFixed(1)} dB (big) — ${(big.meanDb - normal.meanDb >= 0 ? '+' : '')}${(big.meanDb - normal.meanDb).toFixed(1)} dB louder.`,
      )
    if (normal.maxFootSpeed && big.maxFootSpeed && normal.maxFootSpeed > 0)
      conclusion.push(
        `Peak foot movement grew ${(big.maxFootSpeed / normal.maxFootSpeed).toFixed(1)}× (${normal.maxFootSpeed.toFixed(1)} → ${big.maxFootSpeed.toFixed(1)} cm/s).`,
      )
    if (normal.meanMouth && big.meanMouth && normal.meanMouth > 0)
      conclusion.push(
        `Mouth opening grew ${(big.meanMouth / normal.meanMouth).toFixed(1)}× (${normal.meanMouth.toFixed(3)} → ${big.meanMouth.toFixed(3)}).`,
      )
  }

  return (
    <section style={{ ...card, marginBottom: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Research summary</div>
      <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginBottom: 12 }}>
        Comparing intensity levels across audio, motion, and vision. Label recordings{' '}
        <strong>normal / medium / big</strong> to populate the comparison.
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 560 }}>
          <thead>
            <tr>
              <th style={th}>label</th>
              <th style={th}>level</th>
              <th style={th}>mean dB</th>
              <th style={th}>max foot cm/s</th>
              <th style={th}>mean mouth</th>
              <th style={th}>steps</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={td}>{r.label}</td>
                <td style={{ ...td, color: r.level ? 'var(--foreground)' : 'var(--muted-foreground)' }}>
                  {r.level ?? '—'}
                </td>
                <td style={td}>{fmt(r.meanDb, 1)}</td>
                <td style={td}>{fmt(r.maxFootSpeed, 1)}</td>
                <td style={td}>{fmt(r.meanMouth, 3)}</td>
                <td style={td}>{r.stepCount ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {byLevel.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, margin: '16px 0 6px' }}>
            Averages by intensity level
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 420 }}>
              <thead>
                <tr>
                  <th style={th}>level</th>
                  <th style={th}>mean dB</th>
                  <th style={th}>max foot cm/s</th>
                  <th style={th}>mean mouth</th>
                </tr>
              </thead>
              <tbody>
                {byLevel.map((b) => (
                  <tr key={b.level}>
                    <td style={{ ...td, fontWeight: 600 }}>{b.level}</td>
                    <td style={td}>{fmt(b.meanDb, 1)}</td>
                    <td style={td}>{fmt(b.maxFootSpeed, 1)}</td>
                    <td style={td}>{fmt(b.meanMouth, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {conclusion.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Conclusion</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
            {conclusion.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div style={{ fontSize: 11, color: 'var(--muted-foreground)', marginTop: 8 }}>
            If all three scale together with intensity, the audio/motion/vision sensors are
            capturing the same underlying effect — validating the multi-modal setup.
          </div>
        </div>
      )}
    </section>
  )
}
