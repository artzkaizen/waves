/**
 * waves · /exercises — one recording step within an experiment.
 *
 * Exports two routers: the nested one (exercises *of* an experiment) and the flat one
 * (an exercise addressed directly by id), matching the course API's route layout.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { count, desc, eq } from "drizzle-orm";
import { rm } from "node:fs/promises";

import { requireUser, type AuthEnv } from "../auth";
import {
  abortRecording,
  activeExerciseId,
  producerCount,
  startRecording,
  stopRecording,
} from "../capture";
import { db, mediaDir, toExercise } from "../db";
import { processExercise } from "../features/process";
import { exerciseData, exercises, experiments, readings } from "../schema";
import {
  CreateExerciseSchema,
  ErrorSchema,
  ExerciseDataSchema,
  ExerciseIdParam,
  ExerciseSchema,
  IdParam,
  PaginationQuery,
  paginated,
} from "../schemas";

const json = <T>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

const notFound = { 404: json(ErrorSchema, "Exercise not found") };
const conflict = {
  409: json(ErrorSchema, "Not valid in the exercise's current state"),
};

// =========================================================================== //
// nested under an experiment
// =========================================================================== //

export const experimentExercisesRouter = new OpenAPIHono<AuthEnv>();
experimentExercisesRouter.use("*", requireUser);

const createExercise = createRoute({
  method: "post",
  path: "/{experimentId}/exercises",
  tags: ["Exercises"],
  summary: "Create an exercise within an experiment",
  security: [{ sessionAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: CreateExerciseSchema } } },
  },
  responses: {
    201: json(ExerciseSchema, "The created exercise"),
    404: json(ErrorSchema, "Experiment not found"),
  },
});

experimentExercisesRouter.openapi(createExercise, async (c) => {
  const { experimentId } = c.req.valid("param");
  const body = c.req.valid("json");

  const parent = await db.query.experiments.findFirst({
    where: eq(experiments.id, experimentId),
  });
  if (!parent) return c.json({ error: "Experiment not found" }, 404);

  const [row] = await db
    .insert(exercises)
    .values({
      experimentId,
      properties: body.properties ?? {},
      notes: body.notes ?? null,
    })
    .returning();
  return c.json(toExercise(row), 201);
});

const listExperimentExercises = createRoute({
  method: "get",
  path: "/{experimentId}/exercises",
  tags: ["Exercises"],
  summary: "List the exercises of one experiment",
  security: [{ sessionAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: json(ExerciseSchema.array(), "The experiment's exercises, newest first"),
    404: json(ErrorSchema, "Experiment not found"),
  },
});

experimentExercisesRouter.openapi(listExperimentExercises, async (c) => {
  const { experimentId } = c.req.valid("param");
  const parent = await db.query.experiments.findFirst({
    where: eq(experiments.id, experimentId),
  });
  if (!parent) return c.json({ error: "Experiment not found" }, 404);

  const rows = await db
    .select()
    .from(exercises)
    .where(eq(exercises.experimentId, experimentId))
    .orderBy(desc(exercises.createdAt));
  return c.json(rows.map(toExercise), 200);
});

// =========================================================================== //
// addressed directly by exercise id
// =========================================================================== //

export const exercisesRouter = new OpenAPIHono<AuthEnv>();
exercisesRouter.use("*", requireUser);

const listExercises = createRoute({
  method: "get",
  path: "/",
  tags: ["Exercises"],
  summary: "List all exercises across experiments (paginated)",
  security: [{ sessionAuth: [] }],
  request: { query: PaginationQuery },
  responses: { 200: json(paginated(ExerciseSchema), "A page of exercises") },
});

exercisesRouter.openapi(listExercises, async (c) => {
  const { page, pageSize } = c.req.valid("query");
  const [{ total }] = await db.select({ total: count() }).from(exercises);
  const rows = await db
    .select()
    .from(exercises)
    .orderBy(desc(exercises.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const counts = await db
    .select({ eid: readings.exerciseId, c: count() })
    .from(readings)
    .groupBy(readings.exerciseId);
  const countMap = new Map(counts.map((x) => [x.eid, Number(x.c)]));
  return c.json(
    { items: rows.map((r) => toExercise(r, countMap.get(r.id) ?? 0)), page, pageSize, total },
    200,
  );
});

const getExercise = createRoute({
  method: "get",
  path: "/{exerciseId}",
  tags: ["Exercises"],
  summary: "Get one exercise (metadata + recording status)",
  security: [{ sessionAuth: [] }],
  request: { params: ExerciseIdParam },
  responses: { 200: json(ExerciseSchema, "The exercise"), ...notFound },
});

exercisesRouter.openapi(getExercise, async (c) => {
  const { exerciseId } = c.req.valid("param");
  const row = await db.query.exercises.findFirst({ where: eq(exercises.id, exerciseId) });
  if (!row) return c.json({ error: "Exercise not found" }, 404);
  const [rc] = await db
    .select({ c: count() })
    .from(readings)
    .where(eq(readings.exerciseId, exerciseId));
  return c.json(toExercise(row, Number(rc?.c ?? 0)), 200);
});

const deleteExercise = createRoute({
  method: "delete",
  path: "/{exerciseId}",
  tags: ["Exercises"],
  summary: "Delete an exercise completely",
  security: [{ sessionAuth: [] }],
  request: { params: ExerciseIdParam },
  responses: { 204: { description: "Deleted" }, ...notFound },
});

exercisesRouter.openapi(deleteExercise, async (c) => {
  const { exerciseId } = c.req.valid("param");
  // If it is mid-recording, stop writing to it before the row disappears.
  abortRecording(exerciseId);

  const [row] = await db
    .delete(exercises)
    .where(eq(exercises.id, exerciseId))
    .returning({ id: exercises.id });
  if (!row) return c.json({ error: "Exercise not found" }, 404);

  await rm(mediaDir(exerciseId), { recursive: true, force: true });
  return c.body(null, 204);
});

// --------------------------------------------------------------------------- //
// recording control
// --------------------------------------------------------------------------- //

const startRoute = createRoute({
  method: "post",
  path: "/{exerciseId}/recording/start",
  tags: ["Recording"],
  summary: "Start recording for an exercise",
  description:
    "Begins persisting the Pi's already-flowing sensor stream to this exercise. Fails " +
    "if the exercise already has data (clear it first), if it is already recording, or " +
    "if another exercise is currently recording — there is one physical rig.",
  security: [{ sessionAuth: [] }],
  request: { params: ExerciseIdParam },
  responses: {
    200: json(ExerciseSchema, "Recording started"),
    ...notFound,
    ...conflict,
  },
});

exercisesRouter.openapi(startRoute, async (c) => {
  const { exerciseId } = c.req.valid("param");
  const row = await db.query.exercises.findFirst({ where: eq(exercises.id, exerciseId) });
  if (!row) return c.json({ error: "Exercise not found" }, 404);

  if (row.hasData) {
    return c.json(
      { error: "Exercise already has data. Clear it before recording again." },
      409,
    );
  }
  if (row.recordingStatus === "recording") {
    return c.json({ error: "Recording is already in progress." }, 409);
  }
  const active = activeExerciseId();
  if (active && active !== exerciseId) {
    return c.json(
      { error: `Another exercise (${active}) is currently recording.` },
      409,
    );
  }
  if (producerCount() === 0) {
    // Refuse rather than silently record an empty exercise: a recording with no sensor
    // attached looks identical to a successful one until you open the data and find it
    // empty, by which point the participant has gone home.
    return c.json({ error: "No sensor device is connected." }, 409);
  }

  await startRecording(exerciseId);
  const updated = await db.query.exercises.findFirst({
    where: eq(exercises.id, exerciseId),
  });
  return c.json(toExercise(updated!), 200);
});

const stopRoute = createRoute({
  method: "post",
  path: "/{exerciseId}/recording/stop",
  tags: ["Recording"],
  summary: "Stop recording for an exercise",
  description:
    "Finalises the recording and processes the raw capture into the derived signals, " +
    "so that GET /exercises/{id}/data is ready to serve.",
  security: [{ sessionAuth: [] }],
  request: { params: ExerciseIdParam },
  responses: {
    200: json(ExerciseSchema, "Recording stopped"),
    ...notFound,
    ...conflict,
  },
});

exercisesRouter.openapi(stopRoute, async (c) => {
  const { exerciseId } = c.req.valid("param");
  const row = await db.query.exercises.findFirst({ where: eq(exercises.id, exerciseId) });
  if (!row) return c.json({ error: "Exercise not found" }, 404);
  if (row.recordingStatus !== "recording") {
    return c.json({ error: "Exercise is not currently recording." }, 409);
  }

  await stopRecording(exerciseId);

  // Process now, not on read: the face mesh runs a network over every frame, which is
  // far too slow to redo per GET. Failure here must not fail the stop — the raw capture
  // is safely on disk either way, and the data route can retry.
  try {
    await processExercise(exerciseId);
  } catch (err) {
    console.error(`[waves] processing failed for exercise ${exerciseId}:`, err);
  }

  const updated = await db.query.exercises.findFirst({
    where: eq(exercises.id, exerciseId),
  });
  return c.json(toExercise(updated!), 200);
});

// --------------------------------------------------------------------------- //
// processed data
// --------------------------------------------------------------------------- //

const getData = createRoute({
  method: "get",
  path: "/{exerciseId}/data",
  tags: ["Recording"],
  summary: "Get the recorded and processed data for an exercise",
  security: [{ sessionAuth: [] }],
  request: { params: ExerciseIdParam },
  responses: {
    200: json(ExerciseDataSchema, "The processed signals and aggregates"),
    404: json(ErrorSchema, "Exercise not found, or it has no data yet"),
  },
});

exercisesRouter.openapi(getData, async (c) => {
  const { exerciseId } = c.req.valid("param");
  const row = await db.query.exercises.findFirst({ where: eq(exercises.id, exerciseId) });
  if (!row) return c.json({ error: "Exercise not found" }, 404);
  if (!row.hasData) return c.json({ error: "Exercise has no data yet" }, 404);

  const cached = await db.query.exerciseData.findFirst({
    where: eq(exerciseData.exerciseId, exerciseId),
  });
  if (cached) return c.json(cached.payload as never, 200);

  // Not cached — processing failed at stop, or the cache was cleared. Compute it now.
  const payload = await processExercise(exerciseId);
  return c.json(payload as never, 200);
});

const deleteData = createRoute({
  method: "delete",
  path: "/{exerciseId}/data",
  tags: ["Recording"],
  summary: "Clear the recorded data of an exercise",
  description:
    "Keeps the exercise but removes its readings, media and processed signals, resetting " +
    "it to `idle` so a new recording can be started.",
  security: [{ sessionAuth: [] }],
  request: { params: ExerciseIdParam },
  responses: { 204: { description: "Cleared" }, ...notFound },
});

exercisesRouter.openapi(deleteData, async (c) => {
  const { exerciseId } = c.req.valid("param");
  const row = await db.query.exercises.findFirst({ where: eq(exercises.id, exerciseId) });
  if (!row) return c.json({ error: "Exercise not found" }, 404);

  abortRecording(exerciseId);

  await db.delete(readings).where(eq(readings.exerciseId, exerciseId));
  await db.delete(exerciseData).where(eq(exerciseData.exerciseId, exerciseId));
  await rm(mediaDir(exerciseId), { recursive: true, force: true });

  await db
    .update(exercises)
    .set({
      recordingStatus: "idle",
      hasData: false,
      recordingStartedAt: null,
      recordingEndedAt: null,
      audioPath: null,
      audioRate: null,
      videoPath: null,
      videoFps: null,
      posterPath: null,
    })
    .where(eq(exercises.id, exerciseId));

  return c.body(null, 204);
});
