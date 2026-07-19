/**
 * waves · server (Hono + Bun + Drizzle).
 *
 *   REST  /experiments, /exercises        the course API (OpenAPI at /openapi.json, docs at /docs)
 *   REST  /auth                           experimenter accounts
 *   WS    /ingest                         the Pi pushes motion/audio JSON + binary JPEG frames
 *   WS    /live                           the dashboard subscribes to the live stream
 *   HTTP  /api/stream.mjpeg               live camera relay for an <img>
 *
 * The Pi streams continuously whenever it is connected; a *recording* is just the window
 * during which the server persists that stream to an exercise.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { createBunWebSocket } from "hono/bun";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { asc, eq } from "drizzle-orm";
import type { ServerWebSocket } from "bun";

import {
  addProducer,
  addViewer,
  activeExerciseId,
  getLatestFrame,
  ingestReadings,
  onFrame,
  producerCount,
  pushFrame,
  removeProducer,
  removeViewer,
  type WsData,
} from "./capture";
import {
  ingestToken,
  isProducerAuthorized,
  pruneSessions,
  requireUser,
  type AuthEnv,
} from "./auth";
import { db, mediaAbs, mediaDir, mediaRel, runMigrations } from "./db";
import { exercises, readings } from "./schema";
import { iterMjpegFrames } from "./features/mjpeg";
import { processExercise } from "./features/process";
import { authRouter } from "./routes/auth";
import { exercisesRouter, experimentExercisesRouter } from "./routes/exercises";
import { experimentsRouter } from "./routes/experiments";

// Fail fast, at boot, rather than lazily on the first /ingest connection. A production
// server that starts happily and only reveals it has no ingest token when the Pi tries
// to stream is a server that fails in front of the participant, mid-experiment.
ingestToken();

runMigrations();
await pruneSessions();

const app = new OpenAPIHono<AuthEnv>();
const { upgradeWebSocket, websocket } = createBunWebSocket<WsData>();

app.use("*", logger());
// The Vite dev server runs on :5173 and calls this API on :8000. Credentials are on, so
// the origin cannot be "*" — it must be reflected explicitly.
app.use(
  "/api/*",
  cors({
    origin: (o) => o ?? "*",
    credentials: true,
  }),
);
app.use("/auth/*", cors({ origin: (o) => o ?? "*", credentials: true }));
app.use("/experiments/*", cors({ origin: (o) => o ?? "*", credentials: true }));
app.use("/exercises/*", cors({ origin: (o) => o ?? "*", credentials: true }));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error("[waves] unhandled:", err);
  return c.json({ error: "Internal server error" }, 500);
});

// --------------------------------------------------------------------------- //
// the course API
// --------------------------------------------------------------------------- //

app.route("/auth", authRouter);
app.route("/experiments", experimentsRouter);
app.route("/experiments", experimentExercisesRouter);
app.route("/exercises", exercisesRouter);

app.openAPIRegistry.registerComponent("securitySchemes", "sessionAuth", {
  type: "apiKey",
  in: "cookie",
  name: "waves_session",
  description:
    "Session cookie set by POST /auth/login. API clients may instead send the same " +
    "token as `Authorization: Bearer <token>`.",
});

app.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "waves · Experiment API",
    version: "3.0.0",
    description:
      "Records correlated speech and movement data from a Raspberry Pi sensor rig " +
      "(INMP441 microphone, MPU-6050 IMU, camera) and serves the processed signals: " +
      "sound pressure, mouth opening, foot speed and step lengths.\n\n" +
      "An **experiment** is the umbrella entity for one participant. An **exercise** is " +
      "a single recording step within it.",
  },
  servers: [{ url: "/", description: "this server" }],
});

app.get("/docs", Scalar({ url: "/openapi.json", pageTitle: "waves · API" }));

// --------------------------------------------------------------------------- //
// WebSocket /ingest — the Pi
// --------------------------------------------------------------------------- //

app.get(
  "/ingest",
  upgradeWebSocket((c) => {
    // A browser cannot set headers on a WebSocket handshake, so the token may also
    // arrive as a query param. The Pi sends it as a header.
    const header = c.req.header("Authorization");
    const presented = header?.startsWith("Bearer ")
      ? header.slice(7).trim()
      : c.req.query("token");
    const authorized = isProducerAuthorized(presented);
    const id = crypto.randomUUID();

    return {
      onOpen(_evt, ws) {
        if (!authorized) {
          ws.close(4401, "invalid ingest token");
        }
        // NB: do not touch ws.raw.data — Hono's Bun adapter keeps its own event
        // handlers there, and overwriting it detaches the socket from the adapter.
      },

      onMessage(evt, ws) {
        if (!authorized) return;
        const raw = ws.raw as unknown as ServerWebSocket<WsData>;

        // Binary frames are raw JPEG video — no JSON, no base64.
        if (evt.data instanceof ArrayBuffer) {
          pushFrame(new Uint8Array(evt.data));
          return;
        }
        if (evt.data instanceof Blob) return; // not expected from the Pi

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(evt.data));
        } catch {
          ws.send(JSON.stringify({ type: "error", error: "bad_message" }));
          return;
        }

        if (msg.type === "hello") {
          const caps = (msg.caps ?? {}) as Record<string, boolean>;
          addProducer(id, {
            ws: raw,
            device: String(msg.device ?? "pi"),
            audioRate: (msg.audio_rate as number) ?? null,
            videoFps: (msg.video_fps as number) ?? null,
          });
          console.log(`[waves] producer connected: ${msg.device} caps=${JSON.stringify(caps)}`);
          ws.send(
            JSON.stringify({ type: "welcome", active_exercise: activeExerciseId() }),
          );
          return;
        }

        if (msg.type === "readings") {
          ingestReadings(msg as never);
          return;
        }

        if (msg.type === "bye") {
          removeProducer(id);
        }
      },

      onClose() {
        removeProducer(id);
        console.log("[waves] producer disconnected");
      },
    };
  }),
);

// --------------------------------------------------------------------------- //
// WebSocket /live — the dashboard
// --------------------------------------------------------------------------- //

app.get(
  "/live",
  upgradeWebSocket(() => {
    const id = crypto.randomUUID();
    return {
      onOpen(_evt, ws) {
        const raw = ws.raw as unknown as ServerWebSocket<WsData>;
        addViewer(id, raw);
        ws.send(
          JSON.stringify({
            type: "welcome",
            producers: producerCount(),
            active_exercise: activeExerciseId(),
          }),
        );
      },
      onClose() {
        removeViewer(id);
      },
    };
  }),
);

// --------------------------------------------------------------------------- //
// media
// --------------------------------------------------------------------------- //

const BOUNDARY = "frame";

const mjpegPart = (jpeg: Uint8Array) =>
  Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.byteLength}\r\n\r\n`,
    ),
    jpeg,
    Buffer.from("\r\n"),
  ]);

/** Live camera relay — whatever the Pi is pushing right now, session or not. */
app.get("/api/stream.mjpeg", (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const first = getLatestFrame();
      if (first) controller.enqueue(mjpegPart(first));

      const unsubscribe = onFrame((jpeg) => {
        try {
          controller.enqueue(mjpegPart(jpeg));
        } catch {
          unsubscribe();
        }
      });
      c.req.raw.signal.addEventListener("abort", () => {
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
});

/** The Pi POSTs the exercise's WAV once, when recording stops. */
app.post("/api/exercises/:id/audio", async (c) => {
  const header = c.req.header("Authorization");
  const presented = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!isProducerAuthorized(presented)) {
    return c.json({ error: "Invalid ingest token" }, 401);
  }

  const exerciseId = c.req.param("id")!;
  const row = await db.query.exercises.findFirst({ where: eq(exercises.id, exerciseId) });
  if (!row) return c.json({ error: "Exercise not found" }, 404);

  const body = await c.req.arrayBuffer();
  if (!body.byteLength) return c.json({ error: "Empty body" }, 400);

  await Bun.write(`${mediaDir(exerciseId)}/audio.wav`, body);
  await db
    .update(exercises)
    .set({ audioPath: mediaRel(exerciseId, "audio.wav") })
    .where(eq(exercises.id, exerciseId));

  // The Pi can only finish the WAV once it *knows* recording stopped, so the upload
  // necessarily lands after the stop request has already processed the exercise. Without
  // this re-run, soundPressure would be permanently missing from the payload.
  if (row.recordingStatus === "stopped") {
    try {
      await processExercise(exerciseId);
    } catch (err) {
      console.error(`[waves] reprocessing after audio upload failed:`, err);
    }
  }

  return c.json({ ok: true });
});

/** Library thumbnail: the first recorded frame. */
app.get("/api/exercises/:id/poster.jpg", requireUser, async (c) => {
  const row = await db.query.exercises.findFirst({
    where: eq(exercises.id, c.req.param("id")!),
  });
  if (!row?.posterPath) return c.json({ error: "No poster" }, 404);
  const file = Bun.file(mediaAbs(row.posterPath));
  if (!(await file.exists())) return c.json({ error: "No poster" }, 404);
  return new Response(file, { headers: { "Content-Type": "image/jpeg" } });
});

app.get("/api/exercises/:id/audio.wav", requireUser, async (c) => {
  const row = await db.query.exercises.findFirst({
    where: eq(exercises.id, c.req.param("id")!),
  });
  if (!row?.audioPath) return c.json({ error: "No audio" }, 404);
  const file = Bun.file(mediaAbs(row.audioPath));
  if (!(await file.exists())) return c.json({ error: "No audio" }, 404);
  return new Response(file, { headers: { "Content-Type": "audio/wav" } });
});

// Motion readings as CSV — columns mirror collect_data.py's dataset CSV (plus dB).
// Values are contract units (accel g, gyro °/s), t = seconds since recording start.
app.get("/api/exercises/:id/export.csv", requireUser, async (c) => {
  const id = c.req.param("id")!;
  const rows = await db
    .select()
    .from(readings)
    .where(eq(readings.exerciseId, id))
    .orderBy(asc(readings.seq));
  const header = "time_offset,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,db\n";
  const body = rows
    .map((r) => [r.t, r.ax, r.ay, r.az, r.gx, r.gy, r.gz, r.db ?? ""].join(","))
    .join("\n");
  return new Response(header + body + "\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${id}.csv"`,
    },
  });
});

// Recorded video playback — re-stream the exercise's stored video.mjpeg (length-prefixed
// JPEG frames) as multipart/x-mixed-replace, paced at its recorded fps, so an <img> plays it.
app.get("/api/exercises/:id/video.mjpeg", requireUser, async (c) => {
  const row = await db.query.exercises.findFirst({
    where: eq(exercises.id, c.req.param("id")!),
  });
  if (!row?.videoPath) return c.json({ error: "No video" }, 404);
  const abs = mediaAbs(row.videoPath);
  if (!(await Bun.file(abs).exists())) return c.json({ error: "No video" }, 404);
  const frameMs = 1000 / (row.videoFps && row.videoFps > 0 ? row.videoFps : 12);
  let cancelled = false;
  c.req.raw.signal.addEventListener("abort", () => {
    cancelled = true;
  });
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const jpeg of iterMjpegFrames(abs)) {
          if (cancelled) break;
          controller.enqueue(mjpegPart(jpeg));
          await new Promise((r) => setTimeout(r, frameMs));
        }
      } catch {
        /* client went away mid-stream */
      }
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-store",
    },
  });
});

app.get("/healthz", (c) =>
  c.json({ ok: true, producers: producerCount(), recording: activeExerciseId() }),
);

// --------------------------------------------------------------------------- //
// the built dashboard
// --------------------------------------------------------------------------- //

// In production this process serves the dashboard as well as the API — one image, one
// container, one origin. Same-origin also means the httpOnly session cookie just works,
// with no CORS-with-credentials configuration to get wrong.
const DIST = "dist";

app.get("/assets/*", async (c) => {
  const path = new URL(c.req.url).pathname;
  // Vite fingerprints these filenames, so a given URL's bytes never change.
  const file = Bun.file(`${DIST}${path}`);
  if (!(await file.exists())) return c.notFound();
  return new Response(file, {
    headers: { "Cache-Control": "public, max-age=31536000, immutable" },
  });
});

/**
 * SPA fallback. Anything that isn't an API route, a WebSocket or a static asset is a
 * client-side route, so it must return the app shell rather than a 404 — otherwise a
 * refresh on any page but "/" breaks.
 *
 * This is registered last, so every real route above wins first.
 */
app.get("*", async (c) => {
  const path = new URL(c.req.url).pathname;

  // Real files at the dist root (favicon.svg, robots.txt, …) are served as themselves;
  // without this the fallback below would hand back HTML for them.
  if (path !== "/" && !path.endsWith("/")) {
    const asset = Bun.file(`${DIST}${path}`);
    if (await asset.exists()) return new Response(asset);
  }

  const index = Bun.file(`${DIST}/index.html`);
  if (!(await index.exists())) {
    return c.json({ error: "Dashboard not built. Run `bun run build`." }, 404);
  }
  // Never cache the shell: it names the fingerprinted bundles, so a stale copy would
  // point at assets that no longer exist after a deploy.
  return new Response(index, {
    headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" },
  });
});

const port = Number(process.env.PORT ?? process.env.WAVES_PORT ?? 8000);

export default {
  port,
  fetch: app.fetch,
  websocket,
  idleTimeout: 0, // MJPEG responses are long-lived by design
};

export { app };
