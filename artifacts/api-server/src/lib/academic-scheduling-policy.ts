import type { CampusRole } from "./auth";

const academicAdminRoles = new Set<CampusRole>(["super_admin", "org_admin", "campus_admin"]);
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function canManageAcademicSetup(roles: readonly CampusRole[]): boolean {
  return roles.some((role) => academicAdminRoles.has(role));
}

export function isValidAcademicTimeRange(start: string, end: string): boolean {
  return timePattern.test(start) && timePattern.test(end) && start < end;
}

export function academicTimeRangesOverlap(
  firstStart: string,
  firstEnd: string,
  secondStart: string,
  secondEnd: string,
): boolean {
  return firstStart < secondEnd && firstEnd > secondStart;
}

export function canParentViewLiveClassroom(
  isParent: boolean,
  parentViewEnabled: boolean,
  hasLinkedStudent: boolean,
  guardianPolicyAndConsentEnabled: boolean,
): boolean {
  return isParent && parentViewEnabled && hasLinkedStudent && guardianPolicyAndConsentEnabled;
}
