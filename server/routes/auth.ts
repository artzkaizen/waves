/**
 * waves · /auth — experimenter accounts.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";

import {
  clearSessionCookie,
  createSession,
  destroySession,
  publicUser,
  registerUser,
  requireUser,
  setSessionCookie,
  tokenFromRequest,
  verifyCredentials,
  type AuthEnv,
} from "../auth";
import { AuthResultSchema, CredentialsSchema, ErrorSchema, UserSchema } from "../schemas";

export const authRouter = new OpenAPIHono<AuthEnv>();

const json = <T>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

const register = createRoute({
  method: "post",
  path: "/register",
  tags: ["Auth"],
  summary: "Create an experimenter account",
  request: { body: { content: { "application/json": { schema: CredentialsSchema } } } },
  responses: {
    201: json(AuthResultSchema, "Account created; the session cookie is set"),
    409: json(ErrorSchema, "Email already registered"),
  },
});

authRouter.openapi(register, async (c) => {
  const { email, password } = c.req.valid("json");
  const user = await registerUser(email, password); // throws 409 if taken
  const token = await createSession(user.id);
  setSessionCookie(c, token);
  return c.json({ user: publicUser(user), token }, 201);
});

const login = createRoute({
  method: "post",
  path: "/login",
  tags: ["Auth"],
  summary: "Log in",
  description:
    "Sets an httpOnly session cookie (used by the dashboard) and also returns the token " +
    "in the body (used by API clients and the E2E tests).",
  request: { body: { content: { "application/json": { schema: CredentialsSchema } } } },
  responses: {
    200: json(AuthResultSchema, "Logged in"),
    401: json(ErrorSchema, "Invalid credentials"),
  },
});

authRouter.openapi(login, async (c) => {
  const { email, password } = c.req.valid("json");
  const user = await verifyCredentials(email, password);
  // One message for both "no such account" and "wrong password" — distinguishing them
  // would let anyone enumerate which emails are registered.
  if (!user) return c.json({ error: "Invalid email or password" }, 401);

  const token = await createSession(user.id);
  setSessionCookie(c, token);
  return c.json({ user: publicUser(user), token }, 200);
});

const logout = createRoute({
  method: "post",
  path: "/logout",
  tags: ["Auth"],
  summary: "Log out (revokes the session server-side)",
  security: [{ sessionAuth: [] }],
  responses: { 204: { description: "Logged out" } },
});

authRouter.openapi(logout, async (c) => {
  const token = tokenFromRequest(c);
  if (token) await destroySession(token);
  clearSessionCookie(c);
  return c.body(null, 204);
});

const me = createRoute({
  method: "get",
  path: "/me",
  tags: ["Auth"],
  summary: "The currently authenticated user",
  security: [{ sessionAuth: [] }],
  middleware: [requireUser] as const,
  responses: {
    200: json(UserSchema, "The current user"),
    401: json(ErrorSchema, "Not authenticated"),
  },
});

authRouter.openapi(me, (c) => c.json(publicUser(c.get("user")), 200));
