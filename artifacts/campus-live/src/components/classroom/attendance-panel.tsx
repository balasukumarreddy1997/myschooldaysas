"use client";
import { useCallback, useEffect, useState } from "react";
import { getAccessToken } from "../../auth-token";

type Attendance = { studentId: string; name: string; status: string; source: string; seconds: number };

export function AttendancePanel({ sessionId, canManage, ended }: { sessionId: string; canManage: boolean; ended: boolean }) {
  const [items, setItems] = useState<Attendance[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/live/sessions/${encodeURIComponent(sessionId)}/attendance`, {
        headers: { Authorization: `Bearer ${getAccessToken() ?? ""}` },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Attendance could not be loaded.");
      setItems(body.items);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Attendance unavailable."); }
    finally { setLoading(false); }
  }, [sessionId]);
  useEffect(() => { void load(); }, [load, ended]);
  const override = async (studentId: string, status: string) => {
    setError("");
    try {
      const response = await fetch(`/api/live/sessions/${encodeURIComponent(sessionId)}/attendance`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${getAccessToken() ?? ""}` },
        body: JSON.stringify({ studentId, status }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Override failed.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Override failed."); }
  };
  return <details className="rounded-2xl border border-[hsl(var(--classroom-border))] bg-[hsl(var(--classroom-panel))] p-3">
    <summary className="cursor-pointer text-xs font-bold">Attendance</summary>
    <p className="text-[11px] text-[hsl(var(--classroom-muted))]">{ended ? "Attendance has been finalized from verified media joins." : "Automatic attendance is finalized when the teacher ends the class. Board-only use does not count as media attendance."}</p>
    <button disabled={loading} className="text-xs underline" onClick={() => void load()}>{loading ? "Loading…" : "Refresh attendance"}</button>
    {error && <p role="alert" className="text-xs text-[hsl(var(--classroom-danger))]">{error}</p>}
    <ul className="m-0 mt-2 max-h-72 list-none space-y-3 overflow-y-auto p-0">{items.map(item => <li key={item.studentId} className="text-xs">
      <div className="flex items-center justify-between gap-2"><strong className="truncate">{item.name}</strong><span>{Math.floor(item.seconds / 60)} min · {item.status}</span></div>
      {canManage && <label className="mt-1 flex items-center gap-2 text-[11px]">Manual override<select aria-label={`Attendance for ${item.name}`} value={["present", "late", "absent"].includes(item.status) ? item.status : ""} onChange={event => void override(item.studentId, event.target.value)} className="min-h-9 rounded border border-[hsl(var(--classroom-border))] bg-[hsl(var(--classroom-bg))] px-2">
        <option value="" disabled>Not finalized</option><option value="present">Present</option><option value="late">Late</option><option value="absent">Absent</option>
      </select><span>{item.source === "manual" ? "Manual" : ""}</span></label>}
    </li>)}</ul>
    {!items.length && !loading && <p className="text-xs text-[hsl(var(--classroom-muted))]">No attendance records yet.</p>}
  </details>;
}
