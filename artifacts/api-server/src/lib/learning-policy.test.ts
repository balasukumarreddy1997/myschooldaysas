import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignmentTransitionAllowed,
  canManageLearningSection,
  canReadStudentLearning,
  canSubmitLearningWork,
  gradeForScore,
  isLateSubmission,
  isValidGradeScale,
} from "./learning-policy.ts";

test("assignments publish and close through allowed transitions only", () => {
  assert.equal(assignmentTransitionAllowed("draft", "published"), true);
  assert.equal(assignmentTransitionAllowed("published", "closed"), true);
  assert.equal(assignmentTransitionAllowed("closed", "draft"), false);
  assert.equal(assignmentTransitionAllowed("draft", "closed"), false);
});

test("grade scale resolves the highest matching percentage threshold", () => {
  const scale = [
    { grade: "A1", minPercent: 90 },
    { grade: "B1", minPercent: 70 },
    { grade: "E", minPercent: 33 },
    { grade: "F", minPercent: 0 },
  ];
  assert.equal(gradeForScore(9, 10, scale), "A1");
  assert.equal(gradeForScore(6.99, 10, scale), "E");
  assert.equal(gradeForScore(2, 10, scale), "F");
  assert.equal(gradeForScore(1, 0, scale), null);
});

test("late submission uses the persisted deadline and server timestamp", () => {
  const dueAt = Date.parse("2026-10-26T10:00:00Z");
  assert.equal(isLateSubmission(dueAt, dueAt), false);
  assert.equal(isLateSubmission(dueAt, dueAt + 1), true);
});

test("section access denies unassigned teachers and preserves admin access", () => {
  assert.equal(canManageLearningSection({ admin: false, teacher: true, student: false, parent: false }, false), false);
  assert.equal(canManageLearningSection({ admin: false, teacher: true, student: false, parent: false }, true), true);
  assert.equal(canManageLearningSection({ admin: true, teacher: false, student: false, parent: false }, false), true);
});

test("guardian views require a linked child and only students can submit", () => {
  const parent = { admin: false, teacher: false, student: false, parent: true };
  assert.equal(canReadStudentLearning(parent, { isSelf: false, isLinkedChild: false, teachesSection: false }), false);
  assert.equal(canReadStudentLearning(parent, { isSelf: false, isLinkedChild: true, teachesSection: false }), true);
  assert.equal(canSubmitLearningWork(parent), false);
  assert.equal(canSubmitLearningWork({ admin: false, teacher: false, student: true, parent: false }), true);
});

test("grade scales require unique bands and a zero-percent fallback", () => {
  assert.equal(isValidGradeScale([{ grade: "A", minPercent: 90 }, { grade: "F", minPercent: 0 }]), true);
  assert.equal(isValidGradeScale([{ grade: "A", minPercent: 90 }, { grade: "F", minPercent: 10 }]), false);
  assert.equal(isValidGradeScale([{ grade: "A", minPercent: 90 }, { grade: "a", minPercent: 0 }]), false);
});
