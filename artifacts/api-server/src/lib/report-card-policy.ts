export function attendancePercent(attendedDays: number, countedDays: number): number | null {
  if (!Number.isFinite(attendedDays) || !Number.isFinite(countedDays) || countedDays <= 0) return null;
  return Math.round((attendedDays / countedDays) * 10000) / 100;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
