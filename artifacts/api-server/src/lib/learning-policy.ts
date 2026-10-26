export type AssignmentStatus = "draft" | "published" | "closed";
export type LearningRoleScope = { admin: boolean; teacher: boolean; student: boolean; parent: boolean };

export function canManageLearningSection(scope: LearningRoleScope, isAssigned: boolean): boolean {
  return scope.admin || (scope.teacher && isAssigned);
}

export function canReadStudentLearning(
  scope: LearningRoleScope,
  relationship: { isSelf: boolean; isLinkedChild: boolean; teachesSection: boolean },
): boolean {
  return scope.admin
    || (scope.teacher && relationship.teachesSection)
    || (scope.student && relationship.isSelf)
    || (scope.parent && relationship.isLinkedChild);
}

export function canSubmitLearningWork(scope: LearningRoleScope): boolean {
  return scope.student;
}

export function isValidGradeScale(bands: { grade: string; minPercent: number }[]): boolean {
  if (bands.length < 2 || bands.length > 12) return false;
  const grades = bands.map((band) => band.grade.trim().toUpperCase());
  const thresholds = bands.map((band) => band.minPercent);
  return new Set(grades).size === bands.length
    && new Set(thresholds).size === bands.length
    && thresholds.every((value) => Number.isFinite(value) && value >= 0 && value <= 100)
    && grades.every(Boolean)
    && thresholds.includes(0);
}

export function assignmentTransitionAllowed(from: AssignmentStatus, to: AssignmentStatus): boolean {
  if (from === to) return true;
  return (from === "draft" && to === "published") || (from === "published" && to === "closed");
}

export function gradeForScore(
  score: number,
  maxPoints: number,
  bands: { grade: string; minPercent: number }[],
): string | null {
  if (!Number.isFinite(score) || !Number.isFinite(maxPoints) || maxPoints <= 0) return null;
  const percent = (score / maxPoints) * 100;
  return [...bands]
    .sort((a, b) => b.minPercent - a.minPercent)
    .find((band) => percent >= band.minPercent)?.grade ?? null;
}

export function isLateSubmission(dueAt: number, submittedAt: number): boolean {
  return submittedAt > dueAt;
}
