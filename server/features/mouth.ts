/**
 * waves · mouth opening — face landmarks over the recorded video.
 *
 * Why not MediaPipe: the team's `process_data.py` uses MediaPipe Face Landmarker, which
 * has to run on a Mac because Google publishes no Linux ARM64 wheel (the Pi's platform).
 * Its JavaScript package is browser-only — it needs a DOM canvas and WebGL, so it dies
 * under Bun on `document is not defined`.
 *
 * `@vladmandic/human` wraps the *same* underlying models (BlazeFace + FaceMesh) and runs
 * on a TFJS WASM backend with no DOM and no native addon, so it works server-side and in
 * a slim container. The landmark indices are the canonical 468-point face mesh — the very
 * same ones the Python code indexes into — so the geometry carries over unchanged.
 *
 * Output shape follows the course spec: [vertical, horizontal] per frame, each relative
 * to the frame's height/width. (The team's script emitted a single height/width ratio.)
 */

// Imported by file path on purpose. The package's default entry resolves to its *node*
// build, which demands a native TFJS addon (tfjs_binding.node) we deliberately don't
// ship; and its `exports` map declares subpath keys without a leading "./", which is
// invalid, so `@vladmandic/human/dist/human.node-wasm.js` does not resolve. The WASM
// build needs no native addon and no DOM, which is what lets this run under Bun.
import { Human, type Config } from "../../node_modules/@vladmandic/human/dist/human.node-wasm.js";
import jpeg from "jpeg-js";

import { iterMjpegFrames } from "./mjpeg";

// Canonical 468-point face-mesh indices.
const LIP_UPPER = 13; // inner upper lip centre
const LIP_LOWER = 14; // inner lower lip centre
const MOUTH_LEFT = 61; // left mouth corner
const MOUTH_RIGHT = 291; // right mouth corner

export type MouthOpening = {
  values: ([number, number] | null)[];
  sampleRate: number;
  framesDetected: number;
  framesTotal: number;
};

const config: Partial<Config> = {
  backend: "wasm",
  wasmPath: "./node_modules/@tensorflow/tfjs-backend-wasm/dist/",
  // Vendored, not fetched at runtime: the container must not depend on a CDN being up.
  // The URL must be absolute — TFJS resolves a relative file:// against nothing useful
  // and silently hands back a body that fails to parse as JSON.
  modelBasePath: `file://${process.cwd()}/server/models/`,
  cacheSensitivity: 0, // every frame is independent; never reuse the last result
  filter: { enabled: false },
  face: {
    enabled: true,
    detector: { rotation: false, maxDetected: 1 },
    mesh: { enabled: true },
    // everything below is irrelevant to mouth geometry — off, for speed
    iris: { enabled: false },
    description: { enabled: false },
    emotion: { enabled: false },
    antispoof: { enabled: false },
    liveness: { enabled: false },
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
  segmentation: { enabled: false },
};

// Model load is slow (~seconds) and the models are stateless across frames, so the
// instance is created once and shared by every processing job.
let humanPromise: Promise<Human> | null = null;

function getHuman(): Promise<Human> {
  humanPromise ??= (async () => {
    const human = new Human(config);
    await human.load();
    await human.warmup();
    return human;
  })().catch((err) => {
    // Don't cache a rejected promise — a transient failure would otherwise disable face
    // landmarking for the whole life of the process.
    humanPromise = null;
    throw err;
  });
  return humanPromise;
}

/** True when face landmarking is usable — lets callers degrade instead of failing. */
export async function landmarkerAvailable(): Promise<boolean> {
  try {
    await getHuman();
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-frame mouth opening for one recorded exercise video.
 *
 * Frames where no face is detected yield `null`, so the array stays index-aligned with
 * the video and a gap can never be mistaken for a closed mouth.
 */
export async function computeMouthOpening(
  videoPath: string,
  fps: number | null,
): Promise<MouthOpening | null> {
  let human: Human;
  try {
    human = await getHuman();
  } catch {
    return null; // models unavailable → signal is simply absent from the payload
  }

  const values: ([number, number] | null)[] = [];
  let detected = 0;

  type Decoded = { width: number; height: number; data: Uint8Array };

  for await (const frame of iterMjpegFrames(videoPath)) {
    let raw: Decoded;
    try {
      // useTArray keeps this a Uint8Array rather than a Node Buffer copy.
      raw = jpeg.decode(frame, { useTArray: true, formatAsRGBA: true }) as Decoded;
    } catch {
      values.push(null); // a torn frame is a gap, not a fatal error
      continue;
    }

    // RGBA → RGB, the layout the model expects.
    const rgb = new Uint8Array(raw.width * raw.height * 3);
    for (let i = 0, j = 0; i < raw.data.length; i += 4, j += 3) {
      rgb[j] = raw.data[i];
      rgb[j + 1] = raw.data[i + 1];
      rgb[j + 2] = raw.data[i + 2];
    }

    const tensor = human.tf.tensor(rgb, [1, raw.height, raw.width, 3], "float32");
    try {
      const result = await human.detect(tensor).catch(() => null);
      const mesh = result?.face[0]?.mesh;
      if (!mesh?.length) {
        values.push(null); // no face in this frame — a gap, never a zero
        continue;
      }
      // Mesh coordinates are in pixels; normalise against the frame so the values are
      // "relative to the size of the video frame width and height", per the spec.
      const vertical = Math.abs(mesh[LIP_LOWER][1] - mesh[LIP_UPPER][1]) / raw.height;
      const horizontal = Math.abs(mesh[MOUTH_RIGHT][0] - mesh[MOUTH_LEFT][0]) / raw.width;
      values.push([round(vertical), round(horizontal)]);
      detected += 1;
    } finally {
      tensor.dispose(); // WASM tensors are not GC'd — leaking these OOMs a long video
    }
  }

  if (!values.length) return null;
  return {
    values,
    sampleRate: Math.round(fps ?? 30),
    framesDetected: detected,
    framesTotal: values.length,
  };
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;
