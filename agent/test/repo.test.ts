/** Conversation repository: create, append, edit-in-place, truncate inclusive / exclusive, role pinning. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { ConversationRepo, titleFrom } from "../src/db/repo.js";

const msg = (id: string, role: "user" | "assistant", text: string) => ({ id, role, parts: [{ type: "text" as const, text }] });

describe("ConversationRepo", () => {
  let repo: ConversationRepo;
  beforeEach(async () => {
    const db = openDb(path.join(mkdtempSync(path.join(os.tmpdir(), "es-repo-")), "t.sqlite"));
    repo = new ConversationRepo(() => db);
  });

  it("creates, lists per role / facility, renames and deletes", async () => {
    const a = await repo.create({ role: "ministry", facilityId: null, title: "Trends" });
    await repo.create({ role: "doctor", facilityId: 101 });
    await repo.create({ role: "doctor", facilityId: 102 });
    expect((await repo.list({ role: "ministry", facilityId: null })).map((c) => c.id)).toEqual([a.id]);
    expect(await repo.list({ role: "doctor", facilityId: 101 })).toHaveLength(1);
    await repo.update(a.id, { title: "Renamed" });
    expect((await repo.get(a.id))?.title).toBe("Renamed");
    expect(await repo.delete(a.id)).toBe(true);
    expect(await repo.get(a.id)).toBeNull();
  });

  it("appends in order and stores parts + metadata verbatim", async () => {
    const c = await repo.create({ role: "ministry", facilityId: null });
    await repo.upsertMessage(c.id, msg("u1", "user", "How has the rate changed?"));
    const widget = { type: "tool-make_chart", toolCallId: "t1", state: "output-available", input: {}, output: { kind: "chart", id: "ch_1", spec: { type: "kpi" } } };
    await repo.upsertMessage(c.id, { id: "a1", role: "assistant", parts: [widget as never, { type: "text", text: "It rose." }], metadata: { validated_numbers: true } });
    const ms = await repo.messages(c.id);
    expect(ms.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(ms[1].parts[0]).toEqual(widget);
    expect(ms[1].metadata).toEqual({ validated_numbers: true });
    const list = await repo.list({ role: "ministry", facilityId: null });
    expect(list[0]).toMatchObject({ message_count: 2, last_message_preview: "It rose." });
  });

  it("truncate exclusive (rewind) keeps the message, inclusive (edit) removes it", async () => {
    const c = await repo.create({ role: "ministry", facilityId: null });
    for (const [id, role] of [["u1", "user"], ["a1", "assistant"], ["u2", "user"], ["a2", "assistant"]] as const) {
      await repo.upsertMessage(c.id, msg(id, role, id));
    }
    expect(await repo.truncate(c.id, "u2", false)).toBe(1);
    expect((await repo.messages(c.id)).map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
    expect(await repo.truncate(c.id, "a1", true)).toBe(2);
    expect((await repo.messages(c.id)).map((m) => m.id)).toEqual(["u1"]);
    // after truncation new messages continue the sequence
    await repo.upsertMessage(c.id, msg("u3", "user", "edited"));
    expect((await repo.messages(c.id)).map((m) => m.id)).toEqual(["u1", "u3"]);
    await expect(repo.truncate(c.id, "nope", true)).rejects.toThrow(/not found/i);
  });

  it("upsert replaces an existing message in place", async () => {
    const c = await repo.create({ role: "ministry", facilityId: null });
    await repo.upsertMessage(c.id, msg("u1", "user", "first"));
    await repo.upsertMessage(c.id, msg("u1", "user", "edited"));
    const ms = await repo.messages(c.id);
    expect(ms).toHaveLength(1);
    expect((ms[0].parts[0] as { text: string }).text).toBe("edited");
  });

  it("drops trailing assistant messages for regenerate", async () => {
    const c = await repo.create({ role: "ministry", facilityId: null });
    await repo.upsertMessage(c.id, msg("u1", "user", "q"));
    await repo.upsertMessage(c.id, msg("a1", "assistant", "a"));
    expect(await repo.dropTrailingAssistant(c.id)).toBe(1);
    expect((await repo.messages(c.id)).map((m) => m.id)).toEqual(["u1"]);
  });

  it("conversations are pinned to role + facility", async () => {
    const c = await repo.create({ role: "doctor", facilityId: 101 });
    await expect(repo.getFor(c.id, "doctor", 101)).resolves.toMatchObject({ id: c.id });
    await expect(repo.getFor(c.id, "doctor", 102)).rejects.toMatchObject({ status: 403 });
    await expect(repo.getFor(c.id, "ministry", null)).rejects.toMatchObject({ status: 403 });
    await expect(repo.getFor("missing", "ministry", null)).rejects.toMatchObject({ status: 404 });
  });

  it("titles come from the first user text", () => {
    expect(titleFrom(msg("u", "user", "  How has the   under-50 rate changed since 2015?  "))).toBe("How has the under-50 rate changed since 2015?");
    expect(titleFrom(msg("u", "user", "x".repeat(100))).length).toBe(72);
  });
});
