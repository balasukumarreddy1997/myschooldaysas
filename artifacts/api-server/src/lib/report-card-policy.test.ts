import assert from "node:assert/strict";
import test from "node:test";
import { attendancePercent, escapeHtml } from "./report-card-policy.ts";

test("attendance percentage returns null when no attendance has been captured", () => {
  assert.equal(attendancePercent(0, 0), null);
});

test("attendance percentage uses only counted attendance days", () => {
  assert.equal(attendancePercent(8, 10), 80);
  assert.equal(attendancePercent(2, 3), 66.67);
});

test("print rendering escapes HTML and attribute-breaking characters", () => {
  assert.equal(escapeHtml(`<script title="x">&'`), "&lt;script title=&quot;x&quot;&gt;&amp;&#39;");
});
