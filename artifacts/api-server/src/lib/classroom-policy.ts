export type ClassroomRole = "teacher" | "student" | "viewer" | "observer";

export function mediaGrants(role: ClassroomRole, chatEnabled: boolean) {
  return {
    canPublish: role === "teacher",
    canPublishData: role === "teacher" || (role === "student" && chatEnabled),
    canSubscribe: true,
    roomAdmin: role === "teacher",
  };
}

export function attendanceSeconds(
  start: number,
  end: number,
  intervals: { joinedAt: number; leftAt: number | null }[],
): number {
  if (end <= start) return 0;
  const sorted = intervals
    .map(({ joinedAt, leftAt }) => [Math.max(joinedAt, start), Math.min(leftAt ?? end, end)] as const)
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let previousEnd = start;
  for (const [from, to] of sorted) {
    total += Math.max(0, to - Math.max(from, previousEnd));
    previousEnd = Math.max(previousEnd, to);
  }
  return Math.min(Math.floor(total / 1000), Math.floor((end - start) / 1000));
}
