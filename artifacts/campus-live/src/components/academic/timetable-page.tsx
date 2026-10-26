"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetTimetableQueryKey,
  useCreateTimetableSlot,
  useDeleteTimetableSlot,
  useGetAcademicTeacherAssignments,
  useGetTimetable,
} from "@workspace/api-client-react";
import { CalendarPlus, Trash2 } from "lucide-react";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const readableError = (error: unknown) => error instanceof Error ? error.message : "Something went wrong.";

export function TimetablePage({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const timetable = useGetTimetable();
  const assignments = useGetAcademicTeacherAssignments(undefined, { query: { enabled: canManage } });
  const create = useCreateTimetableSlot({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetTimetableQueryKey() }),
    },
  });
  const remove = useDeleteTimetableSlot({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetTimetableQueryKey() }),
    },
  });
  const [assignmentId, setAssignmentId] = useState("");
  const [weekday, setWeekday] = useState(1);
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("08:45");
  const [room, setRoom] = useState("");
  const assignment = useMemo(
    () => assignments.data?.items.find((item) => item.id === assignmentId),
    [assignments.data, assignmentId],
  );
  const sorted = [...(timetable.data?.items ?? [])].sort(
    (a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime),
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!assignment || endTime <= startTime) return;
    create.mutate({
      data: {
        sectionId: assignment.sectionId,
        subjectId: assignment.subjectId,
        teacherId: assignment.teacherId,
        weekday,
        startTime,
        endTime,
        room: room.trim() || null,
      },
    });
  }

  return (
    <div>
      <header className="mb-7">
        <div className="mb-2 text-[10px] font-bold uppercase tracking-[.2em] text-[hsl(var(--primary))]">Academic schedule</div>
        <h1 className="display m-0 text-[30px] font-extrabold leading-tight tracking-[-.045em] md:text-[36px]">Timetable</h1>
        <p className="mb-0 mt-2 max-w-2xl text-[13px] text-[hsl(var(--muted-foreground))]">View class schedules, assigned teachers, subjects, and rooms.</p>
      </header>

      {canManage && (
        <form onSubmit={submit} className="surface mb-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
          <label className="text-xs font-semibold lg:col-span-2">
            Teaching assignment
            <select
              className="field mt-1.5"
              value={assignmentId}
              onChange={(event) => setAssignmentId(event.target.value)}
              required
              aria-label="Teaching assignment"
            >
              <option value="">Choose class, subject, and teacher</option>
              {assignments.data?.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.sectionName} · {item.subjectName} · {item.teacherName}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold">
            Day
            <select className="field mt-1.5" value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>
              {weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold">
            Start
            <input className="field mt-1.5" type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} required />
          </label>
          <label className="text-xs font-semibold">
            End
            <input className="field mt-1.5" type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} required />
          </label>
          <label className="text-xs font-semibold">
            Room
            <input className="field mt-1.5" maxLength={80} value={room} onChange={(event) => setRoom(event.target.value)} placeholder="Optional" />
          </label>
          <button className="btn btn-primary sm:col-span-2 lg:col-span-6" disabled={!assignment || endTime <= startTime || create.isPending}>
            <CalendarPlus size={15} />{create.isPending ? "Adding…" : "Add timetable slot"}
          </button>
          {(create.isError || assignments.isError) && (
            <p role="alert" className="text-xs text-[hsl(var(--destructive))] sm:col-span-2 lg:col-span-6">
              {readableError(create.error ?? assignments.error)}
            </p>
          )}
        </form>
      )}

      {timetable.isLoading ? (
        <div className="skeleton h-40" aria-label="Loading timetable" />
      ) : timetable.isError ? (
        <div className="surface p-5 text-sm text-[hsl(var(--destructive))]" role="alert">
          {readableError(timetable.error)}
        </div>
      ) : sorted.length === 0 ? (
        <div className="surface p-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
          No timetable slots are available for your account yet.
        </div>
      ) : (
        <div className="surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left">
              <thead className="bg-[hsl(var(--muted))] text-[10px] uppercase tracking-[.12em] text-[hsl(var(--muted-foreground))]">
                <tr>
                  <th className="px-4 py-3">Day & time</th>
                  <th className="px-4 py-3">Class</th>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3">Teacher</th>
                  <th className="px-4 py-3">Room</th>
                  {canManage && <th className="px-4 py-3">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {sorted.map((slot) => (
                  <tr key={slot.id} className="border-t border-[hsl(var(--border))]">
                    <td className="px-4 py-3 text-xs font-semibold">{weekdays[slot.weekday]} · {slot.startTime}–{slot.endTime}</td>
                    <td className="px-4 py-3 text-xs">{slot.sectionName}</td>
                    <td className="px-4 py-3 text-xs">{slot.subjectName}</td>
                    <td className="px-4 py-3 text-xs">{slot.teacherName}</td>
                    <td className="px-4 py-3 text-xs">{slot.room || "—"}</td>
                    {canManage && (
                      <td className="px-4 py-3">
                        <button
                          className="btn btn-muted min-h-8 px-2 text-[11px]"
                          aria-label={`Delete ${slot.subjectName} timetable slot`}
                          disabled={remove.isPending}
                          onClick={() => {
                            if (window.confirm(`Remove the ${slot.subjectName} slot for ${weekdays[slot.weekday]}?`)) {
                              remove.mutate({ slotId: slot.id });
                            }
                          }}
                        >
                          <Trash2 size={14} />Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {remove.isError && <p role="alert" className="p-3 text-xs text-[hsl(var(--destructive))]">{readableError(remove.error)}</p>}
        </div>
      )}
    </div>
  );
}
