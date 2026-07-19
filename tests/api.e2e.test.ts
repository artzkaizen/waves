/**
 * waves · API end-to-end tests.
 *
 * Covers every documented endpoint, driving the real Hono app against a real (temporary)
 * SQLite database — no mocks, no stubs. The only thing faked is the Raspberry Pi itself:
 * a synthetic producer is registered so recording can start, and motion frames are fed in
 * exactly as the WebSocket handler would, so the processing pipeline runs on real data.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the server at a throwaway data dir BEFORE it is imported — db.ts reads this at
// module scope.
const DATA_DIR = mkdtempSync(join(tmpdir(), "waves-e2e-"));
process.env.WAVES_DATA_DIR = DATA_DIR;
process.env.WAVES_INGEST_TOKEN = "test-ingest-token";

const { app } = await import("../server/index");
const capture = await import("../server/capture");

afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }));

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //

let token: string;

const auth = () => ({ Authorization: `Bearer ${token}` });

const api = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...auth(),
      ...(init.headers ?? {}),
    },
  });

const post = (path: string, body?: unknown) =>
  api(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });

const patch = (path: string, body: unknown) =>
  api(path, { method: "PATCH", body: JSON.stringify(body) });

const del = (path: string) => api(path, { method: "DELETE" });

/** Create an experiment and return its id. */
async function newExperiment(overrides: Record<string, unknown> = {}) {
  const res = await post("/experiments", {
    patientNumber: "P-001",
    height: 178,
    age: 64,
    weight: 81.5,
    properties: { cohort: "parkinsons" },
    ...overrides,
  });
  expect(res.status).toBe(201);
  return (await res.json() ) as { id: string };
}

async function newExercise(experimentId: string) {
  const res = await post(`/experiments/${experimentId}/exercises`, {
    properties: { task: "walk-and-count" },
  });
  expect(res.status).toBe(201);
  return (await res.json() ) as { id: string };
}

/**
 * Stand in for the Pi: register a producer, then feed motion + a WAV exactly the way the
 * /ingest WebSocket handler does. Produces a walking-like signal so step detection has
 * something real to find.
 */
function attachFakePi() {
  capture.addProducer("test-pi", {
    ws: null as never,
    device: "pi-test",
    audioRate: 16000,
    videoFps: 12,
  });
}

function detachFakePi() {
  capture.removeProducer("test-pi");
}

/** ~2 s of 40 Hz motion with a 2 Hz stride, i.e. about four steps. */
function feedMotion(seconds = 2) {
  const hz = 40;
  const n = seconds * hz;
  for (let i = 0; i < n; i += 8) {
    const batch: number[][] = [];
    for (let k = 0; k < 8 && i + k < n; k++) {
      const t = (i + k) / hz;
      const stride = Math.sin(2 * Math.PI * 2 * t); // 2 strides/sec
      batch.push([t, stride * 0.9, 0.15 * stride, 1 + 0.4 * stride, 0, 0, 0]);
    }
    capture.ingestReadings({ motion: batch, db: -28.5 });
  }
}

/** A 1 s 16 kHz mono WAV holding a 440 Hz tone, POSTed the way the Pi does. */
function makeWav(seconds = 1, rate = 16000): ArrayBuffer {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), true);
  }
  return buf;
}

// --------------------------------------------------------------------------- //

beforeAll(async () => {
  const res = await app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "experimenter@waves.test", password: "correct-horse" }),
  });
  expect(res.status).toBe(201);
  token = ((await res.json() ) as { token: string }).token;
});

// --------------------------------------------------------------------------- //

describe("auth", () => {
  test("rejects a short password", async () => {
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "x@y.test", password: "short" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects a duplicate email", async () => {
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "experimenter@waves.test", password: "correct-horse" }),
    });
    expect(res.status).toBe(409);
  });

  test("logs in and returns the current user", async () => {
    const login = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "experimenter@waves.test", password: "correct-horse" }),
    });
    expect(login.status).toBe(200);
    const body = (await login.json() ) as { token: string; user: { email: string } };
    expect(body.user.email).toBe("experimenter@waves.test");

    const me = await app.request("/auth/me", {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(me.status).toBe(200);
  });

  test("rejects a wrong password", async () => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "experimenter@waves.test", password: "wrong-password" }),
    });
    expect(res.status).toBe(401);
  });

  test("logout revokes the session immediately", async () => {
    const login = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "experimenter@waves.test", password: "correct-horse" }),
    });
    const { token: t } = (await login.json() ) as { token: string };

    const out = await app.request("/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}` },
    });
    expect(out.status).toBe(204);

    const after = await app.request("/auth/me", { headers: { Authorization: `Bearer ${t}` } });
    expect(after.status).toBe(401);
  });

  test("protected routes reject an anonymous caller", async () => {
    const res = await app.request("/experiments");
    expect(res.status).toBe(401);
  });
});

// --------------------------------------------------------------------------- //

describe("experiments", () => {
  test("creates one, with a server-assigned id and date", async () => {
    const res = await post("/experiments", {
      patientNumber: "P-100",
      height: 170,
      age: 70,
      weight: 75,
      properties: { cohort: "control" },
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.createdAt).toBeTruthy();
    expect(body.properties).toEqual({ cohort: "control" });
  });

  test("rejects an invalid body", async () => {
    const res = await post("/experiments", { age: -5 });
    expect(res.status).toBe(400);
  });

  test("lists them paginated", async () => {
    await newExperiment();
    const res = await api("/experiments?page=1&pageSize=2");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.items.length).toBeLessThanOrEqual(2);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.page).toBe(1);
  });

  test("gets one by id", async () => {
    const { id } = await newExperiment();
    const res = await api(`/experiments/${id}`);
    expect(res.status).toBe(200);
    expect((await res.json() as any).id).toBe(id);
  });

  test("404s for an unknown id", async () => {
    const res = await api(`/experiments/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
  });

  test("patches only the fields provided", async () => {
    const { id } = await newExperiment({ patientNumber: "P-200", age: 60 });
    const res = await patch(`/experiments/${id}`, { age: 61 });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.age).toBe(61);
    expect(body.patientNumber).toBe("P-200"); // untouched, not nulled
  });

  test("deletes it and everything under it", async () => {
    const { id } = await newExperiment();
    const ex = await newExercise(id);

    expect((await del(`/experiments/${id}`)).status).toBe(204);
    expect((await api(`/experiments/${id}`)).status).toBe(404);
    expect((await api(`/exercises/${ex.id}`)).status).toBe(404); // cascaded
  });
});

// --------------------------------------------------------------------------- //

describe("exercises", () => {
  test("creates one within an experiment", async () => {
    const { id } = await newExperiment();
    const res = await post(`/experiments/${id}/exercises`, {
      properties: { task: "syllables" },
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.experimentId).toBe(id);
    expect(body.recordingStatus).toBe("idle");
    expect(body.hasData).toBe(false);
  });

  test("404s when the experiment does not exist", async () => {
    const res = await post(`/experiments/${crypto.randomUUID()}/exercises`, {});
    expect(res.status).toBe(404);
  });

  test("lists the exercises of one experiment", async () => {
    const { id } = await newExperiment();
    await newExercise(id);
    await newExercise(id);
    const res = await api(`/experiments/${id}/exercises`);
    expect(res.status).toBe(200);
    expect((await res.json() as any).length).toBe(2);
  });

  test("lists all exercises across experiments, paginated", async () => {
    const res = await api("/exercises?page=1&pageSize=5");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.total).toBeGreaterThan(0);
  });

  test("gets and deletes one", async () => {
    const { id } = await newExperiment();
    const ex = await newExercise(id);

    expect((await api(`/exercises/${ex.id}`)).status).toBe(200);
    expect((await del(`/exercises/${ex.id}`)).status).toBe(204);
    expect((await api(`/exercises/${ex.id}`)).status).toBe(404);
  });
});

// --------------------------------------------------------------------------- //

describe("recording", () => {
  test("refuses to start with no sensor connected", async () => {
    const { id } = await newExperiment();
    const ex = await newExercise(id);
    detachFakePi();

    const res = await post(`/exercises/${ex.id}/recording/start`);
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toMatch(/no sensor/i);
  });

  test("start → stop produces processed data", async () => {
    attachFakePi();
    const { id } = await newExperiment();
    const ex = await newExercise(id);

    const started = await post(`/exercises/${ex.id}/recording/start`);
    expect(started.status).toBe(200);
    expect((await started.json() as any).recordingStatus).toBe("recording");

    feedMotion(2);

    // the Pi uploads the WAV on stop, authenticated with the ingest token
    const wav = await app.request(`/api/exercises/${ex.id}/audio`, {
      method: "POST",
      headers: { Authorization: "Bearer test-ingest-token" },
      body: makeWav(1),
    });
    expect(wav.status).toBe(200);

    const stopped = await post(`/exercises/${ex.id}/recording/stop`);
    expect(stopped.status).toBe(200);
    const body = await stopped.json() as any;
    expect(body.recordingStatus).toBe("stopped");
    expect(body.hasData).toBe(true);
    expect(body.recordingEndedAt).toBeTruthy();

    detachFakePi();

    // --- the actual signals ------------------------------------------------ //
    const data = await api(`/exercises/${ex.id}/data`);
    expect(data.status).toBe(200);
    const d = await data.json() as any;

    expect(d.exerciseId).toBe(ex.id);

    // sound pressure: dBFS at 100 Hz, always negative (relative to full scale)
    expect(d.soundPressure.unit).toBe("dB");
    expect(d.soundPressure.sampleRate).toBe(100);
    expect(d.soundPressure.values.length).toBe(100); // 1 s at 10 ms windows
    expect(Math.max(...d.soundPressure.values)).toBeLessThan(0);

    // foot speed: cm/s at ~40 Hz
    expect(d.footSpeed.unit).toBe("cm/s");
    expect(d.footSpeed.sampleRate).toBe(40);
    expect(d.footSpeed.values.length).toBe(80); // 2 s at 40 Hz
    expect(d.footSpeed.values.every((v: number) => v >= 0)).toBe(true);

    // a 2 Hz stride over 2 s → about 4 steps, so 3-ish gaps between them
    expect(d.aggregates.stepLengths.unit).toBe("cm");
    expect(d.aggregates.stepLengths.values.length).toBeGreaterThanOrEqual(2);

    expect(d.aggregates.averages.soundPressure).toBeLessThan(0);
    expect(d.aggregates.averages.footSpeed).toBeGreaterThan(0);
    expect(d.aggregates.medians.footSpeed).toBeGreaterThan(0);
    // no camera on the fake Pi → the signal is absent rather than faked
    expect(d.mouthOpening).toBeUndefined();
    expect(d.aggregates.averages.mouthOpeningVertical).toBeNull();
  });

  test("refuses to start an exercise that already has data", async () => {
    attachFakePi();
    const { id } = await newExperiment();
    const ex = await newExercise(id);

    await post(`/exercises/${ex.id}/recording/start`);
    feedMotion(1);
    await post(`/exercises/${ex.id}/recording/stop`);

    const again = await post(`/exercises/${ex.id}/recording/start`);
    expect(again.status).toBe(409);
    expect((await again.json() as any).error).toMatch(/already has data/i);
    detachFakePi();
  });

  test("refuses to stop an exercise that is not recording", async () => {
    const { id } = await newExperiment();
    const ex = await newExercise(id);
    const res = await post(`/exercises/${ex.id}/recording/stop`);
    expect(res.status).toBe(409);
  });

  test("refuses to record two exercises at once — there is one rig", async () => {
    attachFakePi();
    const { id } = await newExperiment();
    const a = await newExercise(id);
    const b = await newExercise(id);

    expect((await post(`/exercises/${a.id}/recording/start`)).status).toBe(200);
    const second = await post(`/exercises/${b.id}/recording/start`);
    expect(second.status).toBe(409);

    await post(`/exercises/${a.id}/recording/stop`);
    detachFakePi();
  });

  test("clearing data resets the exercise so it can record again", async () => {
    attachFakePi();
    const { id } = await newExperiment();
    const ex = await newExercise(id);

    await post(`/exercises/${ex.id}/recording/start`);
    feedMotion(1);
    await post(`/exercises/${ex.id}/recording/stop`);
    expect((await api(`/exercises/${ex.id}/data`)).status).toBe(200);

    expect((await del(`/exercises/${ex.id}/data`)).status).toBe(204);

    const after = await api(`/exercises/${ex.id}`);
    const body = await after.json() as any;
    expect(body.hasData).toBe(false);
    expect(body.recordingStatus).toBe("idle");
    expect((await api(`/exercises/${ex.id}/data`)).status).toBe(404); // gone

    // and it can be recorded again
    expect((await post(`/exercises/${ex.id}/recording/start`)).status).toBe(200);
    await post(`/exercises/${ex.id}/recording/stop`);
    detachFakePi();
  });

  test("404s for data on an exercise that has none", async () => {
    const { id } = await newExperiment();
    const ex = await newExercise(id);
    const res = await api(`/exercises/${ex.id}/data`);
    expect(res.status).toBe(404);
  });
});

// --------------------------------------------------------------------------- //

describe("ingest auth", () => {
  test("rejects an audio upload with a bad token", async () => {
    const { id } = await newExperiment();
    const ex = await newExercise(id);
    const res = await app.request(`/api/exercises/${ex.id}/audio`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
      body: makeWav(1),
    });
    expect(res.status).toBe(401);
  });
});

// --------------------------------------------------------------------------- //

describe("docs", () => {
  test("serves an OpenAPI document covering every route", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const spec = await res.json() as any;

    expect(spec.openapi).toBe("3.1.0");
    for (const path of [
      "/experiments",
      "/experiments/{experimentId}",
      "/experiments/{experimentId}/exercises",
      "/exercises",
      "/exercises/{exerciseId}",
      "/exercises/{exerciseId}/recording/start",
      "/exercises/{exerciseId}/recording/stop",
      "/exercises/{exerciseId}/data",
    ]) {
      expect(spec.paths[path]).toBeDefined();
    }
  });

  test("healthz reports rig status", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect((await res.json() as any).ok).toBe(true);
  });
});
