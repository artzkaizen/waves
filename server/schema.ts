/**
 * waves · Drizzle schema.
 *
 * The data model follows the course API: an `experiment` is the umbrella entity, an
 * `exercise` is one recording step within it. Raw motion lands in `readings`; audio and
 * video land on disk (paths only in the DB); the derived signal payload is cached in
 * `exerciseData` so `GET /exercises/:id/data` doesn't re-run MediaPipe per request.
 */

import { relations } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(uuid),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["experimenter", "admin"] })
    .notNull()
    .default("experimenter"),
  createdAt: text("created_at").notNull().$defaultFn(nowIso),
});

export const authSessions = sqliteTable("auth_sessions", {
  token: text("token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().$defaultFn(nowIso),
  expiresAt: text("expires_at").notNull(),
});

export const experiments = sqliteTable("experiments", {
  id: text("id").primaryKey().$defaultFn(uuid),
  patientNumber: text("patient_number"),
  height: real("height"), // cm
  age: integer("age"),
  weight: real("weight"), // kg
  createdAt: text("created_at").notNull().$defaultFn(nowIso),
  // string→string map, per the spec's "custom properties"
  properties: text("properties", { mode: "json" })
    .notNull()
    .$type<Record<string, string>>()
    .default({}),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
});

export const exercises = sqliteTable(
  "exercises",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    experimentId: text("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
    properties: text("properties", { mode: "json" })
      .notNull()
      .$type<Record<string, string>>()
      .default({}),
    recordingStatus: text("recording_status", {
      enum: ["idle", "recording", "stopped"],
    })
      .notNull()
      .default("idle"),
    hasData: integer("has_data", { mode: "boolean" }).notNull().default(false),
    recordingStartedAt: text("recording_started_at"),
    recordingEndedAt: text("recording_ended_at"),

    // capture metadata / media on disk
    device: text("device"),
    audioPath: text("audio_path"),
    audioRate: integer("audio_rate"),
    videoPath: text("video_path"),
    videoFps: integer("video_fps"),
    posterPath: text("poster_path"),
    notes: text("notes"),
  },
  (t) => [index("idx_exercises_experiment").on(t.experimentId)],
);

export const readings = sqliteTable(
  "readings",
  {
    exerciseId: text("exercise_id")
      .notNull()
      .references(() => exercises.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    t: real("t").notNull(), // seconds since recording start
    ax: real("ax"), // g
    ay: real("ay"),
    az: real("az"),
    gx: real("gx"), // deg/s
    gy: real("gy"),
    gz: real("gz"),
    db: real("db"), // dBFS, nullable
  },
  (t) => [
    primaryKey({ columns: [t.exerciseId, t.seq] }),
    index("idx_readings_exercise").on(t.exerciseId, t.seq),
  ],
);

export const exerciseData = sqliteTable("exercise_data", {
  exerciseId: text("exercise_id")
    .primaryKey()
    .references(() => exercises.id, { onDelete: "cascade" }),
  payload: text("payload", { mode: "json" }).notNull(), // the computed data response
  computedAt: text("computed_at").notNull().$defaultFn(nowIso),
});

// --------------------------------------------------------------------------- //
// relations
// --------------------------------------------------------------------------- //

export const experimentsRelations = relations(experiments, ({ one, many }) => ({
  owner: one(users, { fields: [experiments.ownerId], references: [users.id] }),
  exercises: many(exercises),
}));

export const exercisesRelations = relations(exercises, ({ one, many }) => ({
  experiment: one(experiments, {
    fields: [exercises.experimentId],
    references: [experiments.id],
  }),
  readings: many(readings),
  data: one(exerciseData),
}));

export const readingsRelations = relations(readings, ({ one }) => ({
  exercise: one(exercises, {
    fields: [readings.exerciseId],
    references: [exercises.id],
  }),
}));

export type Experiment = typeof experiments.$inferSelect;
export type Exercise = typeof exercises.$inferSelect;
export type Reading = typeof readings.$inferSelect;
export type User = typeof users.$inferSelect;
