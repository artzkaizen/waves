/**
 * waves · signal processing — raw recordings → the graded exercise-data payload.
 *
 * Ported from the team's `process_data.py`, with units and shapes converted to the
 * course spec (footSpeed in cm/s, stepLengths in cm, aggregates as averages/medians)
 * and with the foot-speed integration corrected — see `computeFootSpeed`.
 */

const G = 9.81; // m/s²
const DB_FLOOR = -80; // dBFS floor for near-silent windows
const SOUND_WINDOW_MS = 10; // → a 100 Hz sound-pressure envelope
const STEP_REFRACTORY_S = 0.25; // minimum time between two step peaks
const STEP_THRESH_K = 0.5; // peak threshold = mean + k · std

export type SoundPressure = { values: number[]; unit: "dB"; sampleRate: number };
export type FootSpeed = { values: number[]; unit: "cm/s"; sampleRate: number };

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const std = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/** Least-squares line through (x, y); returns [slope, intercept]. */
const linearFit = (x: number[], y: number[]): [number, number] => {
  const n = x.length;
  if (n < 2) return [0, y[0] ?? 0];
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    den += (x[i] - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return [slope, my - slope * mx];
};

// --------------------------------------------------------------------------- //
// sound pressure — from the recorded WAV
// --------------------------------------------------------------------------- //

/**
 * RMS level per 10 ms window, as dBFS.
 *
 * This is *relative* full-scale level, not calibrated SPL in Pascals: the INMP441 is
 * not a calibrated measurement microphone, so there is no reference pressure to anchor
 * it to. The spec permits "Pa or dB (whatever is possible)".
 */
export function computeSoundPressure(wav: ArrayBuffer): SoundPressure | null {
  const view = new DataView(wav);
  if (view.byteLength < 44) return null;

  // Walk the RIFF chunks rather than assuming a canonical 44-byte header.
  let pos = 12;
  let fmtRate = 16000;
  let channels = 1;
  let bits = 16;
  let dataOffset = -1;
  let dataLength = 0;

  while (pos + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(pos), view.getUint8(pos + 1),
      view.getUint8(pos + 2), view.getUint8(pos + 3),
    );
    const size = view.getUint32(pos + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(pos + 10, true);
      fmtRate = view.getUint32(pos + 12, true);
      bits = view.getUint16(pos + 22, true);
    } else if (id === "data") {
      dataOffset = pos + 8;
      dataLength = Math.min(size, view.byteLength - dataOffset);
      break;
    }
    pos += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (dataOffset < 0 || bits !== 16 || dataLength <= 0) return null;

  // WAV PCM is little-endian by spec, independent of host byte order.
  const nSamples = Math.floor(dataLength / 2 / channels);
  const mono = new Float64Array(nSamples);
  for (let i = 0; i < nSamples; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      acc += view.getInt16(dataOffset + (i * channels + c) * 2, true);
    }
    mono[i] = acc / channels;
  }

  const win = Math.max(1, Math.round((fmtRate * SOUND_WINDOW_MS) / 1000));
  const nWin = Math.floor(nSamples / win);
  if (nWin === 0) return null;

  const values: number[] = [];
  for (let w = 0; w < nWin; w++) {
    let sumSq = 0;
    for (let i = w * win; i < (w + 1) * win; i++) sumSq += mono[i] * mono[i];
    const rms = Math.sqrt(sumSq / win);
    // Below 1 LSB there is no signal left to measure; clamp instead of diverging to -inf.
    const db = rms < 1 ? DB_FLOOR : 20 * Math.log10(rms / 32767);
    values.push(round(Math.max(db, DB_FLOOR), 2));
  }

  return { values, unit: "dB", sampleRate: Math.round(1000 / SOUND_WINDOW_MS) };
}

// --------------------------------------------------------------------------- //
// foot speed + step lengths — from the motion readings
// --------------------------------------------------------------------------- //

/**
 * Integrate acceleration to a speed magnitude in cm/s.
 *
 * `t` in seconds, `ax/ay/az` in g (as persisted).
 *
 * Deliberately different from the team's `process_data.py`, which integrates the
 * *magnitude* |a|. Magnitude is non-negative, so its cumulative sum can only climb: it
 * yields an activity integral, not a speed, and after detrending its maximum lands on
 * the first or last sample every time. Here each axis is integrated with its sign, so
 * decelerations cancel accelerations, and speed is the magnitude of the resulting
 * velocity *vector*.
 *
 * A bare accelerometer has no absolute velocity reference, so drift is controlled by
 * (1) subtracting each axis's mean — removing gravity and DC bias — and (2) subtracting
 * a linear fit from each integrated axis. The result is a solid *relative* speed signal,
 * not lab-calibrated ground truth.
 */
export function computeFootSpeed(
  t: number[],
  ax: number[],
  ay: number[],
  az: number[],
): (FootSpeed & { accelMag: number[]; speedCms: number[]; t: number[] }) | null {
  const n = t.length;
  if (n < 2) return null;

  const axes = [ax, ay, az].map((axis) => {
    const ms2 = axis.map((v) => v * G); // g → m/s²
    const m = mean(ms2);
    return ms2.map((v) => v - m); // (1) gravity / bias removal
  });

  // dt per sample; guard against a zero/negative first delta or a stalled clock.
  const dts = new Array<number>(n);
  for (let i = 1; i < n; i++) dts[i] = t[i] - t[i - 1];
  dts[0] = n > 1 ? dts[1] : 0.025;
  const positive = dts.filter((d) => d > 0);
  const fallback = positive.length ? positive.sort((a, b) => a - b)[positive.length >> 1] : 0.025;
  for (let i = 0; i < n; i++) if (!(dts[i] > 0)) dts[i] = fallback;

  const vel = axes.map((acc) => {
    const v = new Array<number>(n); // (2) signed cumulative integration
    let running = 0;
    for (let i = 0; i < n; i++) {
      running += acc[i] * dts[i];
      v[i] = running;
    }
    const [slope, intercept] = linearFit(t, v); // (3) linear detrend
    return v.map((x, i) => x - (slope * t[i] + intercept));
  });

  const speedCms = new Array<number>(n);
  const accelMag = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    speedCms[i] = Math.hypot(vel[0][i], vel[1][i], vel[2][i]) * 100; // m/s → cm/s
    accelMag[i] = Math.hypot(axes[0][i], axes[1][i], axes[2][i]);
  }

  const meanDt = (t[n - 1] - t[0]) / (n - 1);
  return {
    values: speedCms.map((v) => round(v, 4)),
    unit: "cm/s",
    sampleRate: meanDt > 0 ? Math.round(1 / meanDt) : 0,
    speedCms,
    accelMag,
    t,
  };
}

/**
 * Step lengths in cm, via peak-picking on |acceleration|.
 *
 * Each heel strike shows up as a spike in acceleration magnitude. Steps are the local
 * maxima above mean + 0.5·std, with a 250 ms refractory window so a single strike is
 * not counted twice. A step's length is speed integrated between consecutive peaks,
 * i.e. mean speed × elapsed time.
 *
 * A proxy, not validated gait analysis — it inherits the drift caveats of the speed
 * signal it integrates.
 */
export function computeStepLengths(
  accelMag: number[],
  t: number[],
  speedCms: number[],
): number[] {
  if (accelMag.length < 3) return [];

  const threshold = mean(accelMag) + STEP_THRESH_K * std(accelMag);
  const peaks: number[] = [];
  for (let i = 1; i < accelMag.length - 1; i++) {
    if (accelMag[i] <= threshold) continue;
    if (accelMag[i] <= accelMag[i - 1] || accelMag[i] <= accelMag[i + 1]) continue;
    if (peaks.length && t[i] - t[peaks[peaks.length - 1]] < STEP_REFRACTORY_S) continue;
    peaks.push(i);
  }

  const lengths: number[] = [];
  for (let k = 1; k < peaks.length; k++) {
    const [prev, cur] = [peaks[k - 1], peaks[k]];
    const segment = speedCms.slice(prev, cur);
    if (!segment.length) continue;
    lengths.push(round(mean(segment) * (t[cur] - t[prev]), 4));
  }
  return lengths;
}

// --------------------------------------------------------------------------- //
// aggregates
// --------------------------------------------------------------------------- //

const finite = (xs: (number | null | undefined)[]) =>
  xs.filter((v): v is number => typeof v === "number" && Number.isFinite(v));

const avg = (xs: (number | null)[]) => {
  const v = finite(xs);
  return v.length ? round(mean(v), 4) : null;
};

const median = (xs: (number | null)[]) => {
  const v = finite(xs).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return round(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, 4);
};

export function buildAggregates(
  sound: SoundPressure | null,
  speed: FootSpeed | null,
  mouth: { values: ([number, number] | null)[] } | null,
  stepLengths: number[],
) {
  // Only the vertical component is aggregated — it is the one the spec names.
  const mouthVertical = (mouth?.values ?? [])
    .filter((v): v is [number, number] => v !== null)
    .map((v) => v[0]);

  const stats = (fn: (xs: (number | null)[]) => number | null) => ({
    mouthOpeningVertical: fn(mouthVertical),
    soundPressure: fn(sound?.values ?? []),
    footSpeed: fn(speed?.values ?? []),
    stepLength: fn(stepLengths),
  });

  return {
    stepLengths: { values: stepLengths, unit: "cm" as const },
    averages: stats(avg),
    medians: stats(median),
  };
}
