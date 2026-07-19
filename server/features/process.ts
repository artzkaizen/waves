/**
 * waves · raw recording → the processed exercise-data payload.
 *
 * Assembles the four derived signals the course spec asks for, from what the recording
 * actually persisted. Any signal whose source is missing (no mic, no camera, no motion)
 * is simply omitted from the payload rather than faked or zero-filled — a consumer can
 * then tell "we didn't measure this" apart from "we measured this and it was zero".
 *
 * Processing is deliberately done once, on stop, and cached in `exercise_data`: the face
 * mesh runs a neural net over every video frame, which is far too slow to redo on each
 * GET.
 */

import { asc, eq } from "drizzle-orm";

import { db, mediaAbs } from "../db";
import { exerciseData, exercises, readings } from "../schema";
import { computeMouthOpening } from "./mouth";
import {
  buildAggregates,
  computeFootSpeed,
  computeSoundPressure,
  computeStepLengths,
} from "./signals";

export async function processExercise(exerciseId: string) {
  const exercise = await db.query.exercises.findFirst({
    where: eq(exercises.id, exerciseId),
  });
  if (!exercise) throw new Error(`No such exercise: ${exerciseId}`);

  const rows = await db
    .select()
    .from(readings)
    .where(eq(readings.exerciseId, exerciseId))
    .orderBy(asc(readings.seq));

  // --- sound pressure, from the uploaded session WAV ------------------------ //
  let sound = null;
  if (exercise.audioPath) {
    const file = Bun.file(mediaAbs(exercise.audioPath));
    if (await file.exists()) {
      sound = computeSoundPressure(await file.arrayBuffer());
    }
  }

  // --- foot speed + step lengths, from the motion readings ------------------ //
  let speed = null;
  let stepLengths: number[] = [];
  if (rows.length >= 2) {
    const full = computeFootSpeed(
      rows.map((r) => r.t),
      rows.map((r) => r.ax ?? 0),
      rows.map((r) => r.ay ?? 0),
      rows.map((r) => r.az ?? 0),
    );
    if (full) {
      stepLengths = computeStepLengths(full.accelMag, full.t, full.speedCms);
      // strip the intermediates the aggregate step needed; they're not part of the API
      speed = { values: full.values, unit: full.unit, sampleRate: full.sampleRate };
    }
  }

  // --- mouth opening, from the recorded video ------------------------------- //
  let mouth = null;
  if (exercise.videoPath) {
    mouth = await computeMouthOpening(mediaAbs(exercise.videoPath), exercise.videoFps);
  }

  const payload = {
    exerciseId,
    startedAt: exercise.recordingStartedAt,
    endedAt: exercise.recordingEndedAt,
    ...(mouth ? { mouthOpening: mouth } : {}),
    ...(sound ? { soundPressure: sound } : {}),
    ...(speed ? { footSpeed: speed } : {}),
    aggregates: buildAggregates(sound, speed, mouth, stepLengths),
  };

  await db
    .insert(exerciseData)
    .values({ exerciseId, payload })
    .onConflictDoUpdate({
      target: exerciseData.exerciseId,
      set: { payload, computedAt: new Date().toISOString() },
    });

  return payload;
}
