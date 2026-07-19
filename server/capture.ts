/**
 * waves · live capture runtime.
 *
 * The Pi is a stateless follower: it connects and streams motion + audio + JPEG frames
 * continuously, whether or not anything is being recorded. It never creates or names a
 * recording. A *recording* is simply the window during which the server persists that
 * already-flowing stream to an exercise.
 *
 * That inversion is what lets the dashboard show a live preview before you hit record,
 * and it means the Pi needs no session state to get out of sync with the server.
 *
 * At most one exercise records at a time — one physical rig, one participant.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { ServerWebSocket } from "bun";

import { db, mediaDir, mediaRel } from "./db";
import { exercises, readings } from "./schema";
import { eq, sql } from "drizzle-orm";

export type Producer = {
  ws: ServerWebSocket<WsData>;
  device: string;
  audioRate: number | null;
  videoFps: number | null;
};

export type WsData = { role: "producer" | "viewer"; id: string };

type Recording = {
  exerciseId: string;
  t0: number | null; // Pi monotonic ts of the first reading seen
  seq: number;
  videoFile: WriteStream | null;
  videoRel: string | null;
  frameCount: number;
  videoFps: number | null;
};

const producers = new Map<string, Producer>();
const viewers = new Map<string, ServerWebSocket<WsData>>();

let recording: Recording | null = null;
let latestFrame: Uint8Array | null = null;

/** Subscribers to the live MJPEG relay (one per open <img> on the dashboard). */
const frameListeners = new Set<(jpeg: Uint8Array) => void>();

// --------------------------------------------------------------------------- //
// producers / viewers
// --------------------------------------------------------------------------- //

export const producerCount = () => producers.size;
export const activeExerciseId = () => recording?.exerciseId ?? null;

export function addProducer(id: string, p: Producer) {
  producers.set(id, p);
  broadcastToViewers({ type: "producer_status", producers: producers.size });
}

export function removeProducer(id: string) {
  producers.delete(id);
  broadcastToViewers({ type: "producer_status", producers: producers.size });
}

export function addViewer(id: string, ws: ServerWebSocket<WsData>) {
  viewers.set(id, ws);
}

export function removeViewer(id: string) {
  viewers.delete(id);
}

export function firstProducer(): Producer | null {
  return producers.values().next().value ?? null;
}

export function broadcastToViewers(msg: unknown) {
  const text = JSON.stringify(msg);
  for (const ws of viewers.values()) {
    try {
      ws.send(text);
    } catch {
      // a dead socket will be cleaned up by its own close handler
    }
  }
}

/**
 * Recording lifecycle events go to producers as well as viewers.
 *
 * The Pi doesn't need these to stream — it streams unconditionally — but it does need
 * them to bound the audio it buffers locally and uploads as the exercise's WAV. Without
 * them the Pi never learns a recording happened, and the sound-pressure signal silently
 * goes missing from the payload.
 */
function broadcastLifecycle(msg: unknown) {
  const text = JSON.stringify(msg);
  const sockets = [...viewers.values(), ...[...producers.values()].map((p) => p.ws)];
  for (const ws of sockets) {
    try {
      ws?.send(text);
    } catch {
      /* closing socket */
    }
  }
}

// --------------------------------------------------------------------------- //
// live video relay
// --------------------------------------------------------------------------- //

export const getLatestFrame = () => latestFrame;

export function onFrame(fn: (jpeg: Uint8Array) => void): () => void {
  frameListeners.add(fn);
  return () => frameListeners.delete(fn);
}

/**
 * A JPEG arrived from the Pi. Always relay it to live viewers; additionally append it
 * to the recording file if one is open.
 *
 * The container is a flat `[uint32 big-endian length][jpeg]…` sequence — trivially
 * seekable, and it avoids an ffmpeg dependency entirely.
 */
export function pushFrame(jpeg: Uint8Array) {
  latestFrame = jpeg;
  for (const fn of frameListeners) fn(jpeg);

  if (recording?.videoFile) {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(jpeg.byteLength, 0);
    recording.videoFile.write(header);
    recording.videoFile.write(jpeg);
    recording.frameCount += 1;
  }
}

// --------------------------------------------------------------------------- //
// readings
// --------------------------------------------------------------------------- //

export type ReadingsMessage = {
  motion?: number[][]; // [ts, ax, ay, az, gx, gy, gz]
  audio?: number[];
  db?: number | null;
};

/**
 * Persist motion while recording, and always fan the batch out to viewers so the
 * dashboard is live even when idle.
 *
 * `ts` from the Pi is monotonic-clock seconds and means nothing in absolute terms, so
 * it is rebased against the first reading of the recording: `t = ts - t0`.
 */
export function ingestReadings(msg: ReadingsMessage) {
  broadcastToViewers({ type: "readings", ...msg });

  const rec = recording;
  const motion = msg.motion;
  if (!rec || !motion?.length) return;

  if (rec.t0 === null) rec.t0 = Number(motion[0][0]) || 0;
  const t0 = rec.t0;

  // Number() yields NaN for a missing or malformed field, never null — and NaN would be
  // persisted as a garbage float that silently poisons every downstream average. Map it
  // to a real NULL instead, which the processing code already treats as "not measured".
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const rows = motion.map((m, i) => ({
    exerciseId: rec.exerciseId,
    seq: rec.seq + i,
    t: (num(m[0]) ?? t0) - t0,
    ax: num(m[1]),
    ay: num(m[2]),
    az: num(m[3]),
    gx: num(m[4]),
    gy: num(m[5]),
    gz: num(m[6]),
    db: msg.db ?? null, // per-batch level, stamped onto each row of the batch
  }));
  rec.seq += rows.length;

  db.insert(readings).values(rows).onConflictDoNothing().run();
}

// --------------------------------------------------------------------------- //
// recording lifecycle — driven by POST /exercises/:id/recording/start|stop
// --------------------------------------------------------------------------- //

export async function startRecording(exerciseId: string) {
  const src = firstProducer();
  await mkdir(mediaDir(exerciseId), { recursive: true });

  const rel = mediaRel(exerciseId, "video.mjpeg");
  let videoFile: WriteStream | null = null;
  try {
    videoFile = createWriteStream(`${mediaDir(exerciseId)}/video.mjpeg`);
  } catch {
    videoFile = null; // audio + motion still record without video
  }

  recording = {
    exerciseId,
    t0: null,
    seq: 0,
    videoFile,
    videoRel: videoFile ? rel : null,
    frameCount: 0,
    videoFps: src?.videoFps ?? null,
  };

  const startedAt = new Date().toISOString();
  await db
    .update(exercises)
    .set({
      recordingStatus: "recording",
      recordingStartedAt: startedAt,
      recordingEndedAt: null,
      device: src?.device ?? null,
      audioRate: src?.audioRate ?? null,
    })
    .where(eq(exercises.id, exerciseId));

  broadcastLifecycle({ type: "recording_started", exerciseId, startedAt });
  return { startedAt, hasProducer: src !== null };
}

export async function stopRecording(exerciseId: string) {
  const rec = recording;
  recording = null; // stop accepting frames/readings before we finalise

  if (rec?.videoFile) {
    await new Promise<void>((resolve) => rec.videoFile!.end(resolve));
  }

  // A recording that captured no frames has no video — don't advertise one.
  const hasVideo = (rec?.frameCount ?? 0) > 0;
  if (hasVideo && rec?.videoRel) {
    await writePoster(exerciseId, rec.videoRel);
  }

  const endedAt = new Date().toISOString();
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)`.as("n") })
    .from(readings)
    .where(eq(readings.exerciseId, exerciseId));

  await db
    .update(exercises)
    .set({
      recordingStatus: "stopped",
      recordingEndedAt: endedAt,
      // "has data" means there is something to process — motion or video.
      hasData: n > 0 || hasVideo,
      videoPath: hasVideo ? rec!.videoRel : null,
      videoFps: hasVideo ? rec!.videoFps : null,
      posterPath: hasVideo ? mediaRel(exerciseId, "poster.jpg") : null,
    })
    .where(eq(exercises.id, exerciseId));

  broadcastLifecycle({ type: "recording_stopped", exerciseId, endedAt });

  // Kick off processing immediately on session end (footSpeed from motion + mouthOpening
  // from the recorded video). soundPressure needs the WAV, which the Pi POSTs a moment
  // later — the audio-upload handler re-runs processExercise to fold that in. Dynamic
  // import avoids a capture ↔ process import cycle; fire-and-forget so stop stays snappy.
  if (n > 0 || hasVideo) {
    import("./features/process")
      .then((m) => m.processExercise(exerciseId))
      .catch((err) => console.error(`[waves] processing on stop failed:`, err));
  }

  return { endedAt, readingCount: n, hasVideo };
}

/** First recorded frame → poster.jpg, used as the library thumbnail. */
async function writePoster(exerciseId: string, _videoRel: string) {
  const path = `${mediaDir(exerciseId)}/video.mjpeg`;
  const fh = Bun.file(path);
  const buf = new Uint8Array(await fh.arrayBuffer());
  if (buf.byteLength < 4) return;
  const len = new DataView(buf.buffer, buf.byteOffset).getUint32(0, false);
  if (len <= 0 || 4 + len > buf.byteLength) return;
  await Bun.write(`${mediaDir(exerciseId)}/poster.jpg`, buf.subarray(4, 4 + len));
}

/** Abandon an in-flight recording (used when its exercise is deleted mid-record). */
export function abortRecording(exerciseId: string) {
  if (recording?.exerciseId !== exerciseId) return;
  recording.videoFile?.end();
  recording = null;
}
