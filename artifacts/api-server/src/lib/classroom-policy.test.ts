import assert from "node:assert/strict";
import { test } from "node:test";
import { attendanceSeconds, mediaGrants } from "./classroom-policy.ts";

test("drawing permission never grants a student a camera or microphone", () => {
  assert.deepEqual(mediaGrants("student", true), { canPublish: false, canPublishData: true, canSubscribe: true, roomAdmin: false });
  assert.equal(mediaGrants("viewer", false).canPublishData, false);
  assert.equal(mediaGrants("teacher", false).roomAdmin, true);
});

test("attendance clips overlapping joins to the actual class duration", () => {
  const start = Date.parse("2026-10-26T10:00:00Z");
  const end = start + 60_000;
  assert.equal(attendanceSeconds(start, end, [
    { joinedAt: start - 30_000, leftAt: start + 40_000 },
    { joinedAt: start + 20_000, leftAt: end + 90_000 },
  ]), 60);
  assert.equal(attendanceSeconds(start, end, []), 0);
});

test("unfinished joins count until the class ends, never beyond it", () => {
  const start = Date.parse("2026-10-26T10:00:00Z");
  assert.equal(attendanceSeconds(start, start + 40_000, [{ joinedAt: start + 10_000, leftAt: null }]), 30);
});
