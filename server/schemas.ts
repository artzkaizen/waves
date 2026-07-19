/**
 * waves · Zod schemas — the single source of truth for the API.
 *
 * These validate every request/response AND generate the OpenAPI document served at
 * /openapi.json (rendered at /docs). Because the spec is derived from the same schemas
 * the handlers run against, the documentation cannot drift from the implementation.
 */

import { z } from "@hono/zod-openapi";

const Properties = z
  .record(z.string(), z.string())
  .openapi({ example: { task: "walk-and-count", route: "10m" } });

// --------------------------------------------------------------------------- //
// experiments
// --------------------------------------------------------------------------- //

export const ExperimentSchema = z
  .object({
    id: z.uuid(),
    patientNumber: z.string().nullable(),
    height: z.number().nullable().openapi({ description: "cm" }),
    age: z.number().int().nullable(),
    weight: z.number().nullable().openapi({ description: "kg" }),
    createdAt: z.iso.datetime().openapi({ description: "set by the server" }),
    properties: Properties,
  })
  .openapi("Experiment");

export const CreateExperimentSchema = z
  .object({
    patientNumber: z.string().optional(),
    height: z.number().positive().optional(),
    age: z.number().int().positive().optional(),
    weight: z.number().positive().optional(),
    properties: Properties.optional(),
  })
  .openapi("CreateExperiment");

/** PATCH: every field optional, but at least one must be present. */
export const UpdateExperimentSchema = CreateExperimentSchema.refine(
  (v) => Object.keys(v).length > 0,
  { message: "at least one field must be provided" },
).openapi("UpdateExperiment");

// --------------------------------------------------------------------------- //
// exercises
// --------------------------------------------------------------------------- //

export const ExerciseSchema = z
  .object({
    id: z.uuid(),
    experimentId: z.uuid(),
    createdAt: z.iso.datetime(),
    properties: Properties,
    recordingStatus: z.enum(["idle", "recording", "stopped"]),
    hasData: z.boolean(),
    recordingStartedAt: z.iso.datetime().nullable(),
    recordingEndedAt: z.iso.datetime().nullable(),
    readingCount: z.number().int().nonnegative(),
    notes: z.string().nullable(),
  })
  .openapi("Exercise");

export const CreateExerciseSchema = z
  .object({
    properties: Properties.optional(),
    notes: z.string().optional(),
  })
  .openapi("CreateExercise");

// --------------------------------------------------------------------------- //
// exercise data — the processed signal payload
// --------------------------------------------------------------------------- //

const MouthOpeningSchema = z
  .object({
    values: z
      .array(z.tuple([z.number(), z.number()]).nullable())
      .openapi({
        description:
          "[vertical, horizontal] per video frame, relative to frame height/width. " +
          "null for frames where no face was detected, so the array stays time-aligned.",
        example: [[0.031, 0.118], null],
      }),
    sampleRate: z.number().openapi({ description: "Hz" }),
    framesDetected: z.number().int(),
    framesTotal: z.number().int(),
  })
  .openapi("MouthOpening");

const SoundPressureSchema = z
  .object({
    values: z.array(z.number()),
    unit: z.literal("dB").openapi({
      description:
        "dBFS (relative to full scale), not calibrated SPL — the INMP441 is not a " +
        "calibrated measurement microphone, so there is no reference pressure.",
    }),
    sampleRate: z.number().openapi({ description: "Hz" }),
  })
  .openapi("SoundPressure");

const FootSpeedSchema = z
  .object({
    values: z.array(z.number()),
    unit: z.literal("cm/s"),
    sampleRate: z.number().openapi({ description: "Hz" }),
  })
  .openapi("FootSpeed");

const StatsSchema = z.object({
  mouthOpeningVertical: z.number().nullable(),
  soundPressure: z.number().nullable(),
  footSpeed: z.number().nullable(),
  stepLength: z.number().nullable(),
});

export const ExerciseDataSchema = z
  .object({
    exerciseId: z.uuid(),
    startedAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    mouthOpening: MouthOpeningSchema.optional().openapi({
      description: "absent if the exercise has no video, or MediaPipe is unavailable",
    }),
    soundPressure: SoundPressureSchema.optional(),
    footSpeed: FootSpeedSchema.optional(),
    aggregates: z.object({
      stepLengths: z.object({
        values: z.array(z.number()),
        unit: z.literal("cm"),
      }),
      averages: StatsSchema,
      medians: StatsSchema,
    }),
  })
  .openapi("ExerciseData");

// --------------------------------------------------------------------------- //
// auth
// --------------------------------------------------------------------------- //

export const CredentialsSchema = z
  .object({
    email: z.email(),
    password: z.string().min(8).openapi({ description: "minimum 8 characters" }),
  })
  .openapi("Credentials");

export const UserSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    role: z.enum(["experimenter", "admin"]),
    createdAt: z.iso.datetime(),
  })
  .openapi("User");

export const AuthResultSchema = z
  .object({ user: UserSchema, token: z.string() })
  .openapi("AuthResult");

// --------------------------------------------------------------------------- //
// shared
// --------------------------------------------------------------------------- //

export const ErrorSchema = z
  .object({ error: z.string() })
  .openapi("Error");

export const PaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({ example: 1 }),
  pageSize: z.coerce.number().int().min(1).max(200).default(20).openapi({ example: 20 }),
});

export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  });

export const IdParam = z.object({
  experimentId: z.uuid().openapi({ param: { name: "experimentId", in: "path" } }),
});

export const ExerciseIdParam = z.object({
  exerciseId: z.uuid().openapi({ param: { name: "exerciseId", in: "path" } }),
});
