import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetSchoolAttendanceQueryKey, useGetAcademicTeacherAssignments, useGetSchoolAttendance, useGetSections, useMarkSchoolAttendance } from '@workspace/api-client-react';
import type { SchoolAttendanceInput, SchoolAttendancePage, SchoolAttendanceStudent } from '@workspace/api-client-react';
import { CalendarDays, Check, CircleAlert, ClipboardCheck, RotateCcw, Save, UsersRound } from 'lucide-react';
import '../fees/school-work-pages.css';

type Props = { roles: string[] };
type Mark = { status: 'present' | 'absent' | 'late' | 'leave' | null; remark: string };
const allowedRoles = ['teacher', 'class_teacher', 'hod', 'org_admin', 'campus_admin', 'super_admin'];
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Please try again.';
const today = () => new Date().toLocaleDateString('en-CA');

export function AttendancePage({ roles }: Props) {
  const authorized = roles.some(role => allowedRoles.includes(role));
  const sections = useGetSections(undefined, { query: { enabled: authorized } });
  const assignments = useGetAcademicTeacherAssignments(undefined, { query: { enabled: authorized && !roles.some(role => ['org_admin', 'campus_admin', 'super_admin', 'hod'].includes(role)) } });
  const [sectionId, setSectionId] = useState('');
  const [date, setDate] = useState(today);
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Record<string, Mark>>({});
  const [notice, setNotice] = useState('');
  const isAdmin = roles.some(role => ['org_admin', 'campus_admin', 'super_admin', 'hod'].includes(role));
  const sectionOptions = useMemo(() => {
    const all = sections.data?.items ?? [];
    if (isAdmin) return all;
    const assigned = new Set((assignments.data?.items ?? []).map(row => row.sectionId));
    return all.filter(section => assigned.has(section.id));
  }, [sections.data, assignments.data, isAdmin]);
  const resolvedSection = sectionOptions.some(section => section.id === sectionId) ? sectionId : sectionOptions[0]?.id ?? '';
  const query = useGetSchoolAttendance({ sectionId: resolvedSection, date }, { query: { enabled: authorized && !!resolvedSection && !!date, queryKey: getGetSchoolAttendanceQueryKey({ sectionId: resolvedSection, date }) } });
  const save = useMarkSchoolAttendance({ mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetSchoolAttendanceQueryKey({ sectionId: resolvedSection, date }) }) } });
  const page = query.data as SchoolAttendancePage | undefined;
  const students = page?.items ?? [];
  const rowMark = (item: SchoolAttendanceStudent): Mark => edits[item.studentId] ?? { status: item.status, remark: item.remark ?? '' };
  const setMark = (studentId: string, patch: Partial<Mark>) => setEdits(old => ({ ...old, [studentId]: { ...(old[studentId] ?? { status: students.find(item => item.studentId === studentId)?.status ?? null, remark: students.find(item => item.studentId === studentId)?.remark ?? '' }), ...patch } }));
  const complete = students.length > 0 && students.every(item => rowMark(item).status !== null);
  const changed = Object.keys(edits).length > 0;
  const counts = students.reduce<Record<string, number>>((acc, item) => { const status = rowMark(item).status; if (status) acc[status] = (acc[status] ?? 0) + 1; return acc; }, {});
  const markAll = (status: Mark['status']) => setEdits(Object.fromEntries(students.map(item => [item.studentId, { status, remark: rowMark(item).remark }])));

  if (!authorized) return <section className="surface school-access-denied p-8 text-center"><CircleAlert className="mx-auto mb-3 text-[hsl(var(--accent))]"/><h1 className="display text-xl font-extrabold">Attendance is staff-only</h1><p className="mb-0 text-sm text-[hsl(var(--muted-foreground))]">Your account can view learning information, but cannot record attendance.</p></section>;
  const saveMarks = () => {
    if (!page || !complete) return;
    const data: SchoolAttendanceInput = { sectionId: page.sectionId, date: page.date, marks: students.map(item => ({ studentId: item.studentId, status: rowMark(item).status as 'present' | 'absent' | 'late' | 'leave', remark: rowMark(item).remark.trim() })) };
    save.mutate({ data }, { onSuccess: () => { setEdits({}); setNotice('Attendance saved for this section.'); } });
  };

  return <div className="attendance-page space-y-6">
    <header className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
      <div><div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.2em] text-[hsl(var(--primary))]"><span className="h-px w-7 bg-[hsl(var(--accent))]"/>Daily register</div><h1 className="display m-0 text-[32px] font-extrabold tracking-[-.045em] md:text-[38px]">Attendance</h1><p className="mb-0 mt-2 max-w-xl text-[13px] text-[hsl(var(--muted-foreground))]">A reliable record of who was here, and who needs a check-in.</p></div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="attendance-section">Section</label><select id="attendance-section" className="field min-h-[42px] sm:w-[210px]" value={resolvedSection} onChange={event => { setSectionId(event.target.value); setEdits({}); }}><option value="">Choose section</option>{sectionOptions.map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select>
        <label className="flex items-center gap-2 rounded-[10px] border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3"><CalendarDays size={16} className="text-[hsl(var(--primary))]"/><span className="sr-only">Attendance date</span><input className="min-h-[40px] bg-transparent text-sm outline-none" type="date" value={date} onChange={event => { setDate(event.target.value); setEdits({}); }}/></label>
      </div>
    </header>
    {!isAdmin && !assignments.isLoading && !sectionOptions.length && <div className="surface p-5 text-sm text-[hsl(var(--muted-foreground))]">No assigned sections are available for attendance.</div>}
    {notice && <div role="status" className="rounded-xl border border-[hsl(var(--status-good)/.3)] bg-[hsl(var(--status-good-bg))] px-4 py-3 text-sm text-[hsl(var(--brand-mint-ink))]">{notice}</div>}
    {(sections.isError || assignments.isError || query.isError || save.isError) && <div role="alert" className="surface flex items-center gap-3 p-4 text-sm text-[hsl(var(--destructive))]"><CircleAlert size={17}/>{errorText(sections.error || assignments.error || query.error || save.error)}<button className="btn btn-muted btn-sm ml-auto" onClick={() => { sections.refetch(); assignments.refetch(); query.refetch(); }}>Retry</button></div>}
    <section className="surface overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[hsl(var(--border))] p-4 md:p-5">
        <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><ClipboardCheck size={19}/></div><div><h2 className="display m-0 text-base font-extrabold">{page?.sectionName ?? sectionOptions.find(section => section.id === resolvedSection)?.name ?? 'Section register'}</h2><p className="mb-0 mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">{page?.total ?? 0} students · {date}</p></div></div>
        <div className="flex flex-wrap items-center gap-2">{(['present', 'absent', 'late', 'leave'] as const).map(status => <span key={status} className="tag capitalize">{status} <b className="ml-1">{counts[status] ?? 0}</b></span>)}</div>
      </div>
      {query.isLoading || sections.isLoading || (!isAdmin && assignments.isLoading) ? <div className="space-y-3 p-4"><div className="skeleton h-12 w-full"/><div className="skeleton h-12 w-full"/><div className="skeleton h-12 w-full"/></div>
      : !resolvedSection ? <div className="p-10 text-center"><UsersRound className="mx-auto mb-3 text-[hsl(var(--primary))]"/><b className="display">Choose a section</b><p className="mb-0 mt-2 text-sm text-[hsl(var(--muted-foreground))]">Select a section to open its attendance register.</p></div>
      : !students.length ? <div className="p-10 text-center"><div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><UsersRound size={19}/></div><b className="display">No attendance roster returned</b><p className="mb-0 mt-2 text-sm text-[hsl(var(--muted-foreground))]">No marks or students were returned for this date. Nothing has been filled in.</p></div>
      : <><div className="flex flex-wrap items-center justify-between gap-3 border-b border-[hsl(var(--border))] bg-[hsl(var(--background))] px-4 py-3"><span className="text-[11px] text-[hsl(var(--muted-foreground))]">Unmarked students remain visibly missing until a status is chosen.</span><div className="flex gap-2"><button className="btn btn-quiet btn-sm" onClick={() => markAll('present')}>Mark all present</button><button className="btn btn-quiet btn-sm" onClick={() => setEdits({})}><RotateCcw size={13}/>Reset changes</button></div></div>
        <div className="divide-y divide-[hsl(var(--border))]">{students.map((item, index) => { const mark = rowMark(item); return <div key={item.studentId} className="grid gap-3 p-4 md:grid-cols-[minmax(160px,1fr)_minmax(300px,1.2fr)_minmax(150px,.7fr)] md:items-center">
          <div className="flex min-w-0 items-center gap-3"><span className="w-6 text-[10px] tabular-nums text-[hsl(var(--muted-foreground))]">{String(index + 1).padStart(2, '0')}</span><div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[hsl(var(--brand-mint))] text-[11px] font-bold text-[hsl(var(--brand-mint-ink))]">{item.studentName.split(' ').map(name => name[0]).slice(0, 2).join('').toUpperCase()}</div><div className="min-w-0"><div className="truncate text-[13px] font-bold">{item.studentName}</div><div className="mt-0.5 text-[10px] text-[hsl(var(--muted-foreground))]">{item.admissionNo}</div></div></div>
          <div className="grid grid-cols-4 gap-1.5">{(['present', 'absent', 'late', 'leave'] as const).map(status => <button key={status} aria-pressed={mark.status === status} onClick={() => setMark(item.studentId, { status })} className={`min-h-9 rounded-lg border px-2 text-[10px] font-bold capitalize transition ${mark.status === status ? status === 'absent' ? 'border-[hsl(var(--destructive)/.35)] bg-[hsl(var(--destructive)/.1)] text-[hsl(var(--destructive))]' : 'border-[hsl(var(--primary)/.35)] bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]' : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--background))]'}`}>{status}</button>)}</div>
          <label><span className="sr-only">Remark for {item.studentName}</span><input className="field min-h-9 py-2 text-xs" maxLength={500} placeholder="Add a note" value={mark.remark} onChange={event => setMark(item.studentId, { remark: event.target.value })}/></label>
        </div>; })}</div>
        <div className="flex flex-col justify-between gap-3 border-t border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4 sm:flex-row sm:items-center"><span className="text-xs text-[hsl(var(--muted-foreground))]">{students.filter(item => rowMark(item).status === null).length ? `${students.filter(item => rowMark(item).status === null).length} students still need a status` : 'Every student has a status.'}</span><button disabled={save.isPending || !changed || !complete} className="btn btn-primary" onClick={saveMarks}><Save size={15}/>{save.isPending ? 'Saving register…' : 'Save attendance'}{!save.isPending && <Check size={15}/>}</button></div></>}
    </section>
  </div>;
}

