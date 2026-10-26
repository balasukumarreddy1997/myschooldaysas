import assert from "node:assert/strict";
import test from "node:test";
import {
  academicTimeRangesOverlap,
  canParentViewLiveClassroom,
  canManageAcademicSetup,
  sectionHasCapacity,
  isValidAcademicTimeRange,
} from "./academic-scheduling-policy.ts";

test("only administrator roles can manage academic setup", () => {
  assert.equal(canManageAcademicSetup(["org_admin"]), true);
  assert.equal(canManageAcademicSetup(["campus_admin"]), true);
  assert.equal(canManageAcademicSetup(["teacher"]), false);
  assert.equal(canManageAcademicSetup(["student"]), false);
  assert.equal(canManageAcademicSetup(["parent"]), false);
});

test("academic time ranges require valid ordered 24-hour times", () => {
  assert.equal(isValidAcademicTimeRange("08:00", "08:45"), true);
  assert.equal(isValidAcademicTimeRange("23:00", "23:59"), true);
  assert.equal(isValidAcademicTimeRange("08:45", "08:00"), false);
  assert.equal(isValidAcademicTimeRange("24:00", "25:00"), false);
  assert.equal(isValidAcademicTimeRange("8:00", "09:00"), false);
});

test("adjacent schedule slots do not conflict; overlapping slots do", () => {
  assert.equal(academicTimeRangesOverlap("08:00", "09:00", "09:00", "10:00"), false);
  assert.equal(academicTimeRangesOverlap("08:00", "09:00", "08:45", "09:30"), true);
  assert.equal(academicTimeRangesOverlap("08:00", "09:00", "07:30", "08:15"), true);
});

test("parent classroom viewing requires role, session setting, linked student, flag, and consent", () => {
  assert.equal(canParentViewLiveClassroom(true, true, true, true), true);
  assert.equal(canParentViewLiveClassroom(false, true, true, true), false);
  assert.equal(canParentViewLiveClassroom(true, false, true, true), false);
  assert.equal(canParentViewLiveClassroom(true, true, false, true), false);
  assert.equal(canParentViewLiveClassroom(true, true, true, false), false);
});

test("section capacity allows unlimited sections and rejects a full or overfull section", () => {
  assert.equal(sectionHasCapacity(null, 10_000), true);
  assert.equal(sectionHasCapacity(3, 2), true);
  assert.equal(sectionHasCapacity(3, 3), false);
  assert.equal(sectionHasCapacity(3, 4), false);
});
