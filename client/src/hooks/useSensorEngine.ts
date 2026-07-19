import { useCallback, useEffect, useRef } from 'react'
import { AUDIO_POINTS, MOTION_POINTS } from '@/lib/sensor'

type Mode = 'live' | 'review'
type Source = 'demo' | 'live' | 'idle'
type Theme = 'light' | 'dark'

type Colors = {
  c1: string
  c2: string
  c3: string
  border: string
  muted: string
  fg: string
}

type Series = { data: number[]; color: string }

/**
 * Frozen motion/audio arrays drawn while in review mode (built from `SessionDetail`).
 * Review video is shown separately as an MJPEG `<img>`, not by this engine.
 */
export type ReviewData = {
  audio: number[]
  ax: number[]
  ay: number[]
  az: number[]
  gx: number[]
  gy: number[]
  gz: number[]
}

export type SensorEngineOptions = {
  /** `live` shows the running feed; `review` freezes on a stored session. */
  mode: Mode
  /**
   * In live mode: `live` renders the streamed feed; `idle` shows empty panels
   * (connected but no producer, or offline) so the UI never fakes data; `demo`
   * synthesises signals and is opt-in only (Settings → Demo mode).
   */
  source: Source
  /** When reviewing, the frozen data whose buffers are drawn. */
  review: ReviewData | null
  /** Active theme — colours are re-read from CSS variables when it changes. */
  theme: Theme
}

/** Imperative handle: feed the renderer from an external `/live` stream. */
export type SensorEngineApi = {
  refs: {
    cam: React.RefObject<HTMLCanvasElement | null>
    wave: React.RefObject<HTMLCanvasElement | null>
    accel: React.RefObject<HTMLCanvasElement | null>
    gyro: React.RefObject<HTMLCanvasElement | null>
    camClock: React.RefObject<HTMLDivElement | null>
    camMeta: React.RefObject<HTMLSpanElement | null>
    db: React.RefObject<HTMLSpanElement | null>
    dbBar: React.RefObject<HTMLDivElement | null>
    ax: React.RefObject<HTMLSpanElement | null>
    ay: React.RefObject<HTMLSpanElement | null>
    az: React.RefObject<HTMLSpanElement | null>
  }
  /** Push a `readings` batch (PROTOCOL §3) into the live ring buffers. */
  pushReadings: (
    motion: number[][],
    audio: number[] | undefined,
    db: number | null,
  ) => void
  /** Drop the live buffers (e.g. when a fresh session starts). */
  clearLive: () => void
  /** Re-measure the canvases (call after a layout change, e.g. expand/collapse). */
  resize: () => void
}

/** Mutable engine state — lives in a ref, never triggers re-renders. */
type Engine = {
  colors: Colors
  dpr: number
  sizes: Map<HTMLCanvasElement, { w: number; h: number }>
  audio: number[]
  ax: number[]
  ay: number[]
  az: number[]
  gx: number[]
  gy: number[]
  gz: number[]
  t: number
  mt: number
  mAccum: number
  audAccum: number
  burst: number
  shake: number
  rms: number
  /** Current dBFS reading from the live stream (used when source === 'live'). */
  liveDb: number
  last: number
  /** Tracks source transitions so live buffers start clean. */
  lastSource: Source | null
  raf: number
}

const DEFAULT_COLORS: Colors = {
  c1: '#9cc0f5',
  c2: '#5b8def',
  c3: '#3358d4',
  border: '#e5e5e5',
  muted: '#8a8a8a',
  fg: '#1a1a1a',
}

const clampDb = (v: number) => Math.max(-60, Math.min(0, v))

/**
 * Drives the camera/microphone/motion visualisations. A faithful port of the
 * design's `DCLogic` RAF engine: one requestAnimationFrame loop renders the
 * sensor ring buffers to canvases and writes numeric readouts straight to the
 * DOM (so 60 fps updates never re-render React).
 *
 * The engine can be driven by EITHER the built-in synthetic generator (demo) OR
 * externally-pushed live `readings` from the `/live` WebSocket — the draw code is
 * identical, only the buffer-fill path differs. In review mode it freezes on a
 * stored session's arrays instead. The camera is handled in React (synthetic canvas
 * for demo; MJPEG `<img>` for live/review), so the engine only draws the demo camera.
 */
export function useSensorEngine(opts: SensorEngineOptions): SensorEngineApi {
  // Canvas targets.
  const camRef = useRef<HTMLCanvasElement | null>(null)
  const waveRef = useRef<HTMLCanvasElement | null>(null)
  const accelRef = useRef<HTMLCanvasElement | null>(null)
  const gyroRef = useRef<HTMLCanvasElement | null>(null)
  // DOM readouts (updated imperatively each frame).
  const camClockRef = useRef<HTMLDivElement | null>(null)
  const camMetaRef = useRef<HTMLSpanElement | null>(null)
  const dbRef = useRef<HTMLSpanElement | null>(null)
  const dbBarRef = useRef<HTMLDivElement | null>(null)
  const axRef = useRef<HTMLSpanElement | null>(null)
  const ayRef = useRef<HTMLSpanElement | null>(null)
  const azRef = useRef<HTMLSpanElement | null>(null)
  // Set to the live `setupCanvases` while mounted; lets callers force a re-measure.
  const resizeRef = useRef<(() => void) | null>(null)

  // Latest props, mirrored into a ref so the long-lived RAF loop never goes stale.
  const optsRef = useRef(opts)
  optsRef.current = opts

  const engineRef = useRef<Engine | null>(null)
  if (engineRef.current === null) {
    engineRef.current = {
      colors: DEFAULT_COLORS,
      dpr: 1,
      sizes: new Map(),
      audio: [],
      ax: [],
      ay: [],
      az: [],
      gx: [],
      gy: [],
      gz: [],
      t: 0,
      mt: 0,
      mAccum: 0,
      audAccum: 0,
      burst: 0,
      shake: 0,
      rms: 0.01,
      liveDb: -60,
      last: 0,
      lastSource: null,
      raf: 0,
    }
  }

  // ---- imperative live-feed API (stable identities) ----
  const pushReadings = useCallback(
    (motion: number[][], audio: number[] | undefined, db: number | null) => {
      const eng = engineRef.current!
      if (optsRef.current.source !== 'live') return
      const push = (arr: number[], val: number) => {
        arr.push(val)
        if (arr.length > MOTION_POINTS) arr.shift()
      }
      for (const row of motion) {
        // row = [t, ax, ay, az, gx, gy, gz] (PROTOCOL §0 units)
        push(eng.ax, row[1])
        push(eng.ay, row[2])
        push(eng.az, row[3])
        push(eng.gx, row[4])
        push(eng.gy, row[5])
        push(eng.gz, row[6])
      }
      if (audio) {
        for (const v of audio) {
          eng.audio.push(v)
          if (eng.audio.length > AUDIO_POINTS) eng.audio.shift()
        }
      }
      if (db != null && Number.isFinite(db)) eng.liveDb = clampDb(db)
    },
    [],
  )

  const clearLive = useCallback(() => {
    const eng = engineRef.current!
    eng.audio = []
    eng.ax = []
    eng.ay = []
    eng.az = []
    eng.gx = []
    eng.gy = []
    eng.gz = []
    eng.liveDb = -60
  }, [])

  // Re-measure canvases on demand (the RAF loop redraws to the new size next frame).
  const resize = useCallback(() => resizeRef.current?.(), [])

  // Re-read chart/border colours from CSS variables when the theme flips.
  useEffect(() => {
    const eng = engineRef.current!
    eng.colors = readColors()
  }, [opts.theme])

  useEffect(() => {
    const eng = engineRef.current!
    eng.colors = readColors()
    eng.dpr = Math.min(window.devicePixelRatio || 1, 2)

    const canvases = () =>
      [camRef.current, waveRef.current, accelRef.current, gyroRef.current].filter(
        (c): c is HTMLCanvasElement => c !== null,
      )

    const setupCanvases = () => {
      for (const c of canvases()) {
        const rect = c.getBoundingClientRect()
        c.width = Math.max(1, Math.round(rect.width * eng.dpr))
        c.height = Math.max(1, Math.round(rect.height * eng.dpr))
        const ctx = c.getContext('2d')
        if (!ctx) continue
        ctx.setTransform(eng.dpr, 0, 0, eng.dpr, 0, 0)
        eng.sizes.set(c, { w: rect.width, h: rect.height })
      }
    }

    const sizeOf = (c: HTMLCanvasElement) =>
      eng.sizes.get(c) ?? { w: c.clientWidth, h: c.clientHeight }

    // Expose the measurement pass so React can force a re-measure on layout change.
    resizeRef.current = setupCanvases

    // ---- synthetic signal generators (demo source) ----
    const genAudio = (t: number) => {
      const noise = (Math.random() * 2 - 1) * 0.05
      const rumble = Math.sin(t * 2 * Math.PI * 2.4) * 0.04
      const env = eng.burst
      const tone =
        Math.sin(t * 2 * Math.PI * 220) * 0.6 + Math.sin(t * 2 * Math.PI * 440) * 0.3
      return Math.max(-1, Math.min(1, noise + rumble + tone * env))
    }

    const pushAudio = (v: number) => {
      eng.audio.push(v)
      if (eng.audio.length > AUDIO_POINTS) eng.audio.shift()
      eng.rms = eng.rms * 0.97 + Math.abs(v) * 0.03
    }

    const generate = (dt: number) => {
      if (Math.random() < 0.012) {
        eng.burst = 0.7 + Math.random() * 0.3
        eng.shake = 0.6 + Math.random() * 0.6
      }
      eng.burst *= 0.92
      eng.shake *= 0.95
      // audio
      eng.audAccum += dt * 1400
      let n = Math.floor(eng.audAccum)
      eng.audAccum -= n
      n = Math.min(n, 200)
      for (let i = 0; i < n; i++) {
        eng.t += 1 / 1400
        pushAudio(genAudio(eng.t))
      }
      // motion @ 40Hz
      eng.mAccum += dt
      while (eng.mAccum >= 0.025) {
        eng.mAccum -= 0.025
        eng.mt += 0.025
        const sh = eng.shake
        const ax =
          0.12 * Math.sin(eng.mt * 1.7) +
          (Math.random() * 2 - 1) * 0.02 +
          sh * Math.sin(eng.mt * 38) * 1.1
        const ay =
          0.09 * Math.sin(eng.mt * 1.1 + 1) +
          (Math.random() * 2 - 1) * 0.02 +
          sh * Math.sin(eng.mt * 31 + 2) * 1.0
        const az =
          1.0 +
          0.04 * Math.sin(eng.mt * 0.9) +
          (Math.random() * 2 - 1) * 0.02 +
          sh * Math.sin(eng.mt * 44 + 1) * 0.9
        const gx =
          6 * Math.sin(eng.mt * 2.1) +
          (Math.random() * 2 - 1) * 3 +
          sh * Math.sin(eng.mt * 40) * 120
        const gy =
          5 * Math.sin(eng.mt * 1.6 + 1) +
          (Math.random() * 2 - 1) * 3 +
          sh * Math.sin(eng.mt * 36 + 1) * 110
        const gz =
          4 * Math.sin(eng.mt * 1.2 + 2) +
          (Math.random() * 2 - 1) * 3 +
          sh * Math.sin(eng.mt * 48 + 2) * 100
        const push = (arr: number[], val: number) => {
          arr.push(val)
          if (arr.length > MOTION_POINTS) arr.shift()
        }
        push(eng.ax, ax)
        push(eng.ay, ay)
        push(eng.az, az)
        push(eng.gx, gx)
        push(eng.gy, gy)
        push(eng.gz, gz)
      }
    }

    // ---- drawing ----
    const drawWave = (
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number,
      data: number[],
    ) => {
      ctx.clearRect(0, 0, w, h)
      ctx.strokeStyle = eng.colors.border
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, h / 2)
      ctx.lineTo(w, h / 2)
      ctx.stroke()
      if (data.length < 2) return
      ctx.strokeStyle = eng.colors.c3
      ctx.lineWidth = 1.5
      ctx.lineJoin = 'round'
      ctx.beginPath()
      const n = data.length
      for (let i = 0; i < n; i++) {
        const x = (w * i) / (n - 1)
        const y = h / 2 - data[i] * (h / 2 - 4)
        if (i) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
      }
      ctx.stroke()
    }

    const drawSeries = (
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number,
      series: Series[],
      dom: [number, number],
    ) => {
      ctx.clearRect(0, 0, w, h)
      ctx.strokeStyle = eng.colors.border
      ctx.lineWidth = 1
      for (const p of [0.25, 0.5, 0.75]) {
        ctx.beginPath()
        ctx.moveTo(0, h * p)
        ctx.lineTo(w, h * p)
        ctx.stroke()
      }
      const [lo, hi] = dom
      const map = (v: number) => h - ((v - lo) / (hi - lo)) * h
      for (const s of series) {
        const d = s.data
        if (d.length < 2) continue
        ctx.strokeStyle = s.color
        ctx.lineWidth = 1.5
        ctx.lineJoin = 'round'
        ctx.beginPath()
        const off = MOTION_POINTS - d.length
        for (let i = 0; i < d.length; i++) {
          const x = (w * (off + i)) / (MOTION_POINTS - 1)
          const y = Math.max(1, Math.min(h - 1, map(d[i])))
          if (i) ctx.lineTo(x, y)
          else ctx.moveTo(x, y)
        }
        ctx.stroke()
      }
    }

    // Procedural "camera" used in demo mode (no real frames available).
    const drawCamera = (
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number,
      now: number,
    ) => {
      const g = ctx.createLinearGradient(0, 0, w, h)
      const k = (Math.sin(now / 2600) + 1) / 2
      g.addColorStop(0, `rgb(${18 + k * 14},${20 + k * 16},${28 + k * 18})`)
      g.addColorStop(1, '#0a0b0e')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
      const cx = w * (0.3 + 0.4 * ((Math.sin(now / 3000) + 1) / 2))
      const cy = h * 0.4
      const rg = ctx.createRadialGradient(cx, cy, 8, cx, cy, h * 0.9)
      rg.addColorStop(0, 'rgba(120,150,200,0.18)')
      rg.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = rg
      ctx.fillRect(0, 0, w, h)
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'
      ctx.lineWidth = 1
      for (let i = 1; i < 3; i++) {
        ctx.beginPath()
        ctx.moveTo((w * i) / 3, 0)
        ctx.lineTo((w * i) / 3, h)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(0, (h * i) / 3)
        ctx.lineTo(w, (h * i) / 3)
        ctx.stroke()
      }
      ctx.fillStyle = 'rgba(255,255,255,0.05)'
      for (let i = 0; i < 60; i++) {
        ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1)
      }
      drawBrackets(ctx, w, h)
    }

    // Reticle corners shared by the demo and live camera draws.
    const drawBrackets = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'
      ctx.lineWidth = 1.5
      const m = 14
      const l = 12
      const corners: [number, number, number, number][] = [
        [m, m, 1, 1],
        [w - m, m, -1, 1],
        [m, h - m, 1, -1],
        [w - m, h - m, -1, -1],
      ]
      for (const [x, y, sx, sy] of corners) {
        ctx.beginPath()
        ctx.moveTo(x, y + sy * l)
        ctx.lineTo(x, y)
        ctx.lineTo(x + sx * l, y)
        ctx.stroke()
      }
    }

    const loop = (now: number) => {
      let dt = (now - eng.last) / 1000
      eng.last = now
      if (dt > 0.1) dt = 0.1
      const o = optsRef.current
      const review = o.mode === 'review'
      const rv = review ? o.review : null
      const demo = !review && o.source === 'demo'
      const idle = !review && o.source === 'idle'

      // Wipe stale buffers when entering any non-demo source (live or idle) so no
      // synthetic/leftover data lingers — idle panels must read as genuinely empty.
      if (!review && o.source !== eng.lastSource) {
        if (o.source !== 'demo') clearLive()
        eng.lastSource = o.source
      }

      if (demo) generate(dt)

      const wc = waveRef.current
      const ac = accelRef.current
      const gc = gyroRef.current
      const cc = camRef.current

      if (wc) {
        const ctx = wc.getContext('2d')
        const { w, h } = sizeOf(wc)
        if (ctx) drawWave(ctx, w, h, rv ? rv.audio : eng.audio)
      }
      if (ac) {
        const ctx = ac.getContext('2d')
        const { w, h } = sizeOf(ac)
        if (ctx)
          drawSeries(
            ctx,
            w,
            h,
            rv
              ? [
                  { data: rv.ax, color: eng.colors.c1 },
                  { data: rv.ay, color: eng.colors.c2 },
                  { data: rv.az, color: eng.colors.c3 },
                ]
              : [
                  { data: eng.ax, color: eng.colors.c1 },
                  { data: eng.ay, color: eng.colors.c2 },
                  { data: eng.az, color: eng.colors.c3 },
                ],
            [-1.6, 1.6],
          )
      }
      if (gc) {
        const ctx = gc.getContext('2d')
        const { w, h } = sizeOf(gc)
        if (ctx)
          drawSeries(
            ctx,
            w,
            h,
            rv
              ? [
                  { data: rv.gx, color: eng.colors.c1 },
                  { data: rv.gy, color: eng.colors.c2 },
                  { data: rv.gz, color: eng.colors.c3 },
                ]
              : [
                  { data: eng.gx, color: eng.colors.c1 },
                  { data: eng.gy, color: eng.colors.c2 },
                  { data: eng.gz, color: eng.colors.c3 },
                ],
            [-200, 200],
          )
      }
      // The engine only paints the synthetic demo camera. Live + review video are
      // MJPEG `<img>` overlays in React (and the connected-no-producer placeholder),
      // which cover this canvas — so for any non-demo source we just keep it dark.
      if (!review && cc) {
        const ctx = cc.getContext('2d')
        const { w, h } = sizeOf(cc)
        if (ctx) {
          if (demo) {
            drawCamera(ctx, w, h, now)
          } else {
            ctx.fillStyle = '#0c0d10'
            ctx.fillRect(0, 0, w, h)
          }
        }
      }

      // numeric readouts (DOM, no re-render)
      if (idle) {
        // No producer / offline: blank the readouts so nothing looks "live".
        if (dbRef.current) dbRef.current.textContent = '— dB'
        if (dbBarRef.current) dbBarRef.current.style.width = '0%'
        if (axRef.current) axRef.current.textContent = 'x —'
        if (ayRef.current) ayRef.current.textContent = 'y —'
        if (azRef.current) azRef.current.textContent = 'z —'
        if (camClockRef.current) camClockRef.current.textContent = '--:--:--'
      } else if (!review) {
        const db = demo
          ? clampDb(20 * Math.log10(eng.rms + 1e-4))
          : eng.liveDb
        if (dbRef.current) dbRef.current.textContent = `${db.toFixed(1)} dB`
        if (dbBarRef.current)
          dbBarRef.current.style.width = `${Math.round(((db + 60) / 60) * 100)}%`
        const fmt = (p: string, v: number) =>
          p + (v >= 0 ? '+' : '') + v.toFixed(2)
        const lastA = (a: number[]) => (a.length ? a[a.length - 1] : 0)
        if (axRef.current) axRef.current.textContent = fmt('x ', lastA(eng.ax))
        if (ayRef.current) ayRef.current.textContent = fmt('y ', lastA(eng.ay))
        if (azRef.current) azRef.current.textContent = fmt('z ', lastA(eng.az))
        if (camClockRef.current)
          camClockRef.current.textContent = new Date().toLocaleTimeString('en-GB')
      }

      eng.raf = requestAnimationFrame(loop)
    }

    // ---- init ----
    setupCanvases()
    // prefill ~5s of motion history + a full audio window so demo opens "alive".
    // Only when starting in demo — live/idle must begin empty (no synthetic data).
    if (optsRef.current.source === 'demo') {
      for (let i = 0; i < 300; i++) generate(1 / 40)
      eng.audio = []
      for (let i = 0; i < AUDIO_POINTS; i++) pushAudio(genAudio(i / 1400))
    }

    const onResize = () => setupCanvases()
    window.addEventListener('resize', onResize)
    eng.last = performance.now()
    eng.raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(eng.raf)
      window.removeEventListener('resize', onResize)
      resizeRef.current = null
    }
  }, [clearLive])

  return {
    refs: {
      cam: camRef,
      wave: waveRef,
      accel: accelRef,
      gyro: gyroRef,
      camClock: camClockRef,
      camMeta: camMetaRef,
      db: dbRef,
      dbBar: dbBarRef,
      ax: axRef,
      ay: ayRef,
      az: azRef,
    },
    pushReadings,
    clearLive,
    resize,
  }
}

/** Read the design-system chart/line colours from CSS custom properties. */
function readColors(): Colors {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => {
    const s = cs.getPropertyValue(name).trim()
    return s || fallback
  }
  return {
    c1: v('--chart-1', DEFAULT_COLORS.c1),
    c2: v('--chart-2', DEFAULT_COLORS.c2),
    c3: v('--chart-3', DEFAULT_COLORS.c3),
    border: v('--border', DEFAULT_COLORS.border),
    muted: v('--muted-foreground', DEFAULT_COLORS.muted),
    fg: v('--foreground', DEFAULT_COLORS.fg),
  }
}
