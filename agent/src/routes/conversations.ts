/** Conversation CRUD + linear rewind. Conversations are pinned to the X-Role / X-Facility-Id that created them. */
import { Hono } from "hono";
import { z } from "zod";
import { conversationsRepo } from "../db/repo.js";
import { ApiError } from "../lib/errors.js";
import type { Env } from "../lib/hono.js";

export const conversationRoutes = new Hono<Env>();

conversationRoutes.get("/conversations", async (c) => {
  const ctx = c.get("ctx");
  const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 500);
  return c.json({ data: await conversationsRepo().list({ role: ctx.role, facilityId: ctx.facilityId, limit }) });
});

const CreateBody = z.object({ id: z.string().min(1).max(200).optional(), title: z.string().max(200).optional() });

conversationRoutes.post("/conversations", async (c) => {
  const ctx = c.get("ctx");
  const body = CreateBody.parse(await c.req.json().catch(() => ({})));
  const repo = conversationsRepo();
  if (body.id && (await repo.get(body.id))) throw new ApiError(409, "CONFLICT", "Conversation id already exists");
  const conv = await repo.create({ id: body.id, role: ctx.role, facilityId: ctx.facilityId, title: body.title });
  return c.json({ data: conv }, 201);
});

conversationRoutes.get("/conversations/:id", async (c) => {
  const ctx = c.get("ctx");
  const repo = conversationsRepo();
  const conv = await repo.getFor(c.req.param("id"), ctx.role, ctx.facilityId);
  const messages = await repo.messages(conv.id);
  return c.json({ data: { ...conv, message_count: messages.length, messages } });
});

conversationRoutes.patch("/conversations/:id", async (c) => {
  const ctx = c.get("ctx");
  const body = z.object({ title: z.string().min(1).max(200) }).parse(await c.req.json());
  const repo = conversationsRepo();
  await repo.getFor(c.req.param("id"), ctx.role, ctx.facilityId);
  return c.json({ data: await repo.update(c.req.param("id"), { title: body.title }) });
});

conversationRoutes.delete("/conversations/:id", async (c) => {
  const ctx = c.get("ctx");
  const repo = conversationsRepo();
  await repo.getFor(c.req.param("id"), ctx.role, ctx.facilityId);
  await repo.delete(c.req.param("id"));
  return c.json({ data: { id: c.req.param("id"), deleted: true } });
});

const TruncateBody = z.object({ messageId: z.string().min(1), inclusive: z.boolean().default(false) });

/** Edit = { messageId: <user msg>, inclusive: true } then send the edited text; rewind = inclusive: false. */
conversationRoutes.post("/conversations/:id/truncate", async (c) => {
  const ctx = c.get("ctx");
  const body = TruncateBody.parse(await c.req.json());
  const repo = conversationsRepo();
  const conv = await repo.getFor(c.req.param("id"), ctx.role, ctx.facilityId);
  const deleted = await repo.truncate(conv.id, body.messageId, body.inclusive);
  return c.json({ data: { id: conv.id, deleted, messages: await repo.messages(conv.id) } });
});
