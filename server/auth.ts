/**
 * waves · authentication.
 *
 * Two distinct identities, deliberately separated — they have different threat models:
 *
 *   1. The Pi (producer). Presents a long-lived shared secret, `WAVES_INGEST_TOKEN`.
 *      It is a device, not a person: it never logs in, never owns data, and may only
 *      push sensor frames. A leaked token lets someone push junk readings — bad, but
 *      it cannot read patient data or delete experiments.
 *
 *   2. Experimenters (people). Real accounts with argon2id-hashed passwords and
 *      server-side session tokens. They own experiments and control recording.
 *
 * Sessions are stored server-side (rather than as stateless JWTs) so that logout and
 * revocation are immediate — this is patient-adjacent research data, and being unable
 * to kill a leaked credential until it expires is not a tradeoff worth making.
 */

import { and, eq, gt, lt } from "drizzle-orm";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";

import { db } from "./db";
import { authSessions, users, type User } from "./schema";

export const SESSION_COOKIE = "waves_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** In dev the ingest token may be absent; in production it must not be. */
export function ingestToken(): string | null {
  const token = process.env.WAVES_INGEST_TOKEN?.trim();
  if (token) return token;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "WAVES_INGEST_TOKEN must be set in production — refusing to accept unauthenticated sensor data",
    );
  }
  return null;
}

/** Constant-time compare, so a wrong token can't be recovered byte-by-byte by timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** True if the request carries the producer's shared secret. */
export function isProducerAuthorized(presented: string | null | undefined): boolean {
  const expected = ingestToken();
  if (expected === null) return true; // dev only: no token configured
  if (!presented) return false;
  return safeEqual(presented, expected);
}

// --------------------------------------------------------------------------- //
// accounts
// --------------------------------------------------------------------------- //

export async function registerUser(email: string, password: string): Promise<User> {
  const existing = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase()),
  });
  if (existing) {
    throw new HTTPException(409, { message: "An account with that email already exists" });
  }
  const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
  const [user] = await db
    .insert(users)
    .values({ email: email.toLowerCase(), passwordHash })
    .returning();
  return user;
}

export async function verifyCredentials(
  email: string,
  password: string,
): Promise<User | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase()),
  });
  if (!user) {
    // Hash anyway: otherwise "unknown email" returns measurably faster than "wrong
    // password", which leaks which emails have accounts.
    await Bun.password.hash(password, { algorithm: "argon2id" });
    return null;
  }
  const ok = await Bun.password.verify(password, user.passwordHash);
  return ok ? user : null;
}

// --------------------------------------------------------------------------- //
// sessions
// --------------------------------------------------------------------------- //

export async function createSession(userId: string): Promise<string> {
  const token = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db.insert(authSessions).values({ token, userId, expiresAt });
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.token, token));
}

export async function userForToken(token: string): Promise<User | null> {
  const row = await db.query.authSessions.findFirst({
    where: and(
      eq(authSessions.token, token),
      gt(authSessions.expiresAt, new Date().toISOString()),
    ),
    with: { },
  });
  if (!row) return null;
  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
  return user ?? null;
}

/** Housekeeping: drop expired sessions. Called on boot. */
export async function pruneSessions(): Promise<void> {
  await db
    .delete(authSessions)
    .where(lt(authSessions.expiresAt, new Date().toISOString()));
}

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, // not readable from JS → XSS can't exfiltrate it
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

// --------------------------------------------------------------------------- //
// middleware
// --------------------------------------------------------------------------- //

/** Extract a session token from either the cookie (dashboard) or a Bearer header (API clients). */
export function tokenFromRequest(c: Context): string | null {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) return cookie;
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}

export type AuthEnv = { Variables: { user: User } };

/** Gate: a valid experimenter session is required. */
export async function requireUser(c: Context<AuthEnv>, next: Next) {
  const token = tokenFromRequest(c);
  if (!token) {
    throw new HTTPException(401, { message: "Authentication required" });
  }
  const user = await userForToken(token);
  if (!user) {
    throw new HTTPException(401, { message: "Invalid or expired session" });
  }
  c.set("user", user);
  await next();
}

/** Gate: the Pi's shared ingest secret is required. */
export async function requireProducer(c: Context, next: Next) {
  const header = c.req.header("Authorization");
  const presented = header?.startsWith("Bearer ")
    ? header.slice(7).trim()
    : c.req.query("token") ?? null; // WebSocket clients can't set headers in a browser
  if (!isProducerAuthorized(presented)) {
    throw new HTTPException(401, { message: "Invalid ingest token" });
  }
  await next();
}

export const publicUser = (u: User) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  createdAt: u.createdAt,
});
