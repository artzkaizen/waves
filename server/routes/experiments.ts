/**
 * waves · /experiments — the umbrella entity.
 *
 * Every route is declared with `createRoute`, so the OpenAPI document and the runtime
 * validation come from the same definition.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { count, desc, eq } from "drizzle-orm";
import { rm } from "node:fs/promises";

import { requireUser, type AuthEnv } from "../auth";
import { db, mediaDir, toExperiment } from "../db";
import { exercises, experiments } from "../schema";
import {
  CreateExperimentSchema,
  ErrorSchema,
  ExperimentSchema,
  IdParam,
  PaginationQuery,
  UpdateExperimentSchema,
  paginated,
} from "../schemas";

export const experimentsRouter = new OpenAPIHono<AuthEnv>();

experimentsRouter.use("*", requireUser);

const notFound = {
  404: {
    content: { "application/json": { schema: ErrorSchema } },
    description: "Experiment not found",
  },
};

// --------------------------------------------------------------------------- //

const createExperiment = createRoute({
  method: "post",
  path: "/",
  tags: ["Experiments"],
  summary: "Create an experiment",
  description:
    "The creation date is set by the server, not the client. Custom properties are an " +
    "arbitrary string→string map.",
  security: [{ sessionAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: CreateExperimentSchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: ExperimentSchema } },
      description: "The created experiment",
    },
  },
});

experimentsRouter.openapi(createExperiment, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user");
  const [row] = await db
    .insert(experiments)
    .values({
      patientNumber: body.patientNumber ?? null,
      height: body.height ?? null,
      age: body.age ?? null,
      weight: body.weight ?? null,
      properties: body.properties ?? {},
      ownerId: user.id,
    })
    .returning();
  return c.json(toExperiment(row), 201);
});

// --------------------------------------------------------------------------- //

const listExperiments = createRoute({
  method: "get",
  path: "/",
  tags: ["Experiments"],
  summary: "List experiments (paginated)",
  security: [{ sessionAuth: [] }],
  request: { query: PaginationQuery },
  responses: {
    200: {
      content: { "application/json": { schema: paginated(ExperimentSchema) } },
      description: "A page of experiments, newest first",
    },
  },
});

experimentsRouter.openapi(listExperiments, async (c) => {
  const { page, pageSize } = c.req.valid("query");
  const [{ total }] = await db.select({ total: count() }).from(experiments);
  const rows = await db
    .select()
    .from(experiments)
    .orderBy(desc(experiments.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return c.json({ items: rows.map(toExperiment), page, pageSize, total }, 200);
});

// --------------------------------------------------------------------------- //

const getExperiment = createRoute({
  method: "get",
  path: "/{experimentId}",
  tags: ["Experiments"],
  summary: "Get one experiment",
  security: [{ sessionAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: { "application/json": { schema: ExperimentSchema } },
      description: "The experiment",
    },
    ...notFound,
  },
});

experimentsRouter.openapi(getExperiment, async (c) => {
  const { experimentId } = c.req.valid("param");
  const row = await db.query.experiments.findFirst({
    where: eq(experiments.id, experimentId),
  });
  if (!row) return c.json({ error: "Experiment not found" }, 404);
  return c.json(toExperiment(row), 200);
});

// --------------------------------------------------------------------------- //

const updateExperiment = createRoute({
  method: "patch",
  path: "/{experimentId}",
  tags: ["Experiments"],
  summary: "Update an experiment",
  description: "Partial update. Fields not present in the body are left unchanged.",
  security: [{ sessionAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateExperimentSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ExperimentSchema } },
      description: "The updated experiment",
    },
    ...notFound,
  },
});

experimentsRouter.openapi(updateExperiment, async (c) => {
  const { experimentId } = c.req.valid("param");
  const body = c.req.valid("json");

  // Only touch the columns the client actually sent — a PATCH must not null out
  // fields merely because they were omitted.
  const patch: Partial<typeof experiments.$inferInsert> = {};
  if (body.patientNumber !== undefined) patch.patientNumber = body.patientNumber;
  if (body.height !== undefined) patch.height = body.height;
  if (body.age !== undefined) patch.age = body.age;
  if (body.weight !== undefined) patch.weight = body.weight;
  if (body.properties !== undefined) patch.properties = body.properties;

  const [row] = await db
    .update(experiments)
    .set(patch)
    .where(eq(experiments.id, experimentId))
    .returning();

  if (!row) return c.json({ error: "Experiment not found" }, 404);
  return c.json(toExperiment(row), 200);
});

// --------------------------------------------------------------------------- //

const deleteExperiment = createRoute({
  method: "delete",
  path: "/{experimentId}",
  tags: ["Experiments"],
  summary: "Delete an experiment and all its data",
  description:
    "Cascades to every exercise of the experiment, their readings, and their processed data.",
  security: [{ sessionAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: { description: "Deleted" },
    ...notFound,
  },
});

experimentsRouter.openapi(deleteExperiment, async (c) => {
  const { experimentId } = c.req.valid("param");

  // The DB cascade removes the rows, but the audio/video files live on disk and would
  // be orphaned — collect the exercise ids before the rows disappear.
  const owned = await db
    .select({ id: exercises.id })
    .from(exercises)
    .where(eq(exercises.experimentId, experimentId));

  const [row] = await db
    .delete(experiments)
    .where(eq(experiments.id, experimentId))
    .returning({ id: experiments.id });
  if (!row) return c.json({ error: "Experiment not found" }, 404);

  for (const ex of owned) {
    await rm(mediaDir(ex.id), { recursive: true, force: true });
  }
  return c.body(null, 204);
});
