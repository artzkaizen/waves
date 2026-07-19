/**
 * waves · import the team's existing recordings.
 *
 *   bun server/scripts/import-legacy.ts [dir]
 *
 * Their pipeline (legacy/teammates-pi-sensor-project) recorded to loose files —
 * `<label>_<epoch>.csv` (motion), `.wav` (audio), `.mp4` (video) — and processed them on
 * a Mac. This pulls those recordings into the experiment/exercise model so they are
 * served by the API like anything else, and reprocessed with the corrected foot-speed
 * integration and the spec-shaped mouth-opening output.
 *
 * Two conversions matter:
 *
 *   Motion. Their CSV stores RAW MPU-6050 counts. Ours stores physical units, converted
 *   on the Pi. So counts are scaled here: accel /16384 → g (±2 g range), gyro /131 → °/s.
 *   Skipping this would make every recording read as ~17000 g.
 *
 *   Video. Their .mp4 is a real container; ours is a flat [uint32 len][jpeg] sequence.
 *   ffmpeg (host-only, not needed in the deployed image) re-encodes the frames.
 *
 * Each label (normal / medium / big) becomes one experiment, and each recording an
 * exercise within it, so the research comparison lines up with how they collected it.
 */

import { $ } from "bun";
import { eq } from "drizzle-orm";
import { readdir, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { db, mediaDir, mediaRel } from "../db";
import { exercises, experiments, readings } from "../schema";
import { processExercise } from "../features/process";

const ACCEL_LSB_PER_G = 16384; // MPU-6050 at its default ±2 g range
const GYRO_LSB_PER_DPS = 131; // ±250 °/s

const SRC = process.argv[2] ?? "legacy/teammates-pi-sensor-project/dataset";

type Recording = { id: string; label: string; csv: string; wav?: string; mp4?: string };

/** Group the loose files by their shared `<label>_<epoch>` basename. */
async function findRecordings(dir: string): Promise<Recording[]> {
  const files = await readdir(dir);
  const byId = new Map<string, Recording>();

  for (const f of files) {
    const m = f.match(/^(.+)_(\d+)\.(csv|wav|mp4)$/);
    if (!m) continue;
    const [, label, epoch, ext] = m;
    const id = `${label}_${epoch}`;
    const rec = byId.get(id) ?? { id, label, csv: "" };
    if (ext === "csv") rec.csv = join(dir, f);
    if (ext === "wav") rec.wav = join(dir, f);
    if (ext === "mp4") rec.mp4 = join(dir, f);
    byId.set(id, rec);
  }
  // The CSV is the anchor: without motion there is nothing to key the timeline on.
  return [...byId.values()].filter((r) => r.csv);
}

/** Their CSV: time_offset, accel_x..z, gyro_x..z — all raw counts. */
async function parseMotion(path: string) {
  const text = await Bun.file(path).text();
  const lines = text.trim().split("\n");
  const rows: { t: number; ax: number; ay: number; az: number; gx: number; gy: number; gz: number }[] = [];

  for (const line of lines.slice(1)) {
    const p = line.split(",").map(Number);
    if (p.length < 7 || p.some(Number.isNaN)) continue;
    rows.push({
      t: p[0],
      ax: p[1] / ACCEL_LSB_PER_G,
      ay: p[2] / ACCEL_LSB_PER_G,
      az: p[3] / ACCEL_LSB_PER_G,
      gx: p[4] / GYRO_LSB_PER_DPS,
      gy: p[5] / GYRO_LSB_PER_DPS,
      gz: p[6] / GYRO_LSB_PER_DPS,
    });
  }
  return rows;
}

/** mp4 → our [uint32 len][jpeg] container, via ffmpeg. Returns the frame count and fps. */
async function convertVideo(mp4: string, exerciseId: string) {
  const tmp = join(mediaDir(exerciseId), "frames");
  await mkdir(tmp, { recursive: true });

  const probe =
    await $`ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=nw=1:nk=1 ${mp4}`
      .text()
      .catch(() => "30/1");
  const [num, den] = probe.trim().split("/").map(Number);
  const fps = Math.round(den ? num / den : 30) || 30;

  await $`ffmpeg -v error -y -i ${mp4} -q:v 4 ${join(tmp, "%05d.jpg")}`.quiet();

  const frames = (await readdir(tmp)).filter((f) => f.endsWith(".jpg")).sort();
  if (!frames.length) {
    await rm(tmp, { recursive: true, force: true });
    return null;
  }

  const chunks: Uint8Array[] = [];
  for (const f of frames) {
    const jpeg = new Uint8Array(await Bun.file(join(tmp, f)).arrayBuffer());
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, jpeg.byteLength, false); // big-endian
    chunks.push(header, jpeg);
  }
  await Bun.write(join(mediaDir(exerciseId), "video.mjpeg"), new Blob(chunks));

  // poster = first frame
  await Bun.write(
    join(mediaDir(exerciseId), "poster.jpg"),
    Bun.file(join(tmp, frames[0])),
  );
  await rm(tmp, { recursive: true, force: true });

  return { frames: frames.length, fps };
}

// --------------------------------------------------------------------------- //

const recordings = await findRecordings(SRC);
if (!recordings.length) {
  console.error(`No recordings found in ${SRC}`);
  process.exit(1);
}
console.log(`Found ${recordings.length} recordings in ${SRC}\n`);

// one experiment per label, so normal/medium/big stay comparable
const experimentIds = new Map<string, string>();
for (const label of new Set(recordings.map((r) => r.label))) {
  const [row] = await db
    .insert(experiments)
    .values({
      patientNumber: `legacy-${label}`,
      properties: { source: "legacy import", intensity: label },
    })
    .returning();
  experimentIds.set(label, row.id);
}

for (const rec of recordings) {
  const experimentId = experimentIds.get(rec.label)!;
  const motion = await parseMotion(rec.csv);

  const startedAt = new Date(Number(rec.id.split("_").pop()) * 1000).toISOString();
  const duration = motion.at(-1)?.t ?? 0;
  const endedAt = new Date(Date.parse(startedAt) + duration * 1000).toISOString();

  const [exercise] = await db
    .insert(exercises)
    .values({
      experimentId,
      properties: { source: "legacy import", recording: rec.id, intensity: rec.label },
      recordingStatus: "stopped",
      hasData: true,
      recordingStartedAt: startedAt,
      recordingEndedAt: endedAt,
      device: "pi008-legacy",
    })
    .returning();

  await mkdir(mediaDir(exercise.id), { recursive: true });

  if (motion.length) {
    await db.insert(readings).values(
      motion.map((m, seq) => ({ exerciseId: exercise.id, seq, db: null, ...m })),
    );
  }

  if (rec.wav) {
    await Bun.write(join(mediaDir(exercise.id), "audio.wav"), Bun.file(rec.wav));
    await db
      .update(exercises)
      .set({ audioPath: mediaRel(exercise.id, "audio.wav"), audioRate: 16000 })
      .where(eq(exercises.id, exercise.id));
  }

  let video = null;
  if (rec.mp4) {
    video = await convertVideo(rec.mp4, exercise.id);
    if (video) {
      await db
        .update(exercises)
        .set({
          videoPath: mediaRel(exercise.id, "video.mjpeg"),
          videoFps: video.fps,
          posterPath: mediaRel(exercise.id, "poster.jpg"),
        })
        .where(eq(exercises.id, exercise.id));
    }
  }

  process.stdout.write(
    `  ${rec.id.padEnd(24)} ${String(motion.length).padStart(4)} motion` +
      `${rec.wav ? " · audio" : ""}${video ? ` · ${video.frames} frames @ ${video.fps}fps` : ""} … `,
  );

  const data = await processExercise(exercise.id);
  const a = data.aggregates.averages;
  const detected = data.mouthOpening
    ? `${data.mouthOpening.framesDetected}/${data.mouthOpening.framesTotal}`
    : "—";
  console.log(
    `dB ${a.soundPressure ?? "—"} · speed ${a.footSpeed ?? "—"} cm/s · ` +
      `steps ${data.aggregates.stepLengths.values.length} · face ${detected}`,
  );
}

console.log(`\nImported ${recordings.length} recordings into ${experimentIds.size} experiments.`);
