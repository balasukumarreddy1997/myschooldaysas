import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetAcademicSubjectsQueryKey, getGetAcademicTeacherAssignmentsQueryKey, getGetLearningReportCardsQueryKey,
  getGetLearningReportCardQueryKey,
  useAddLearningReportCardRemark, useCreateAcademicSubject, useCreateAcademicTeacherAssignment,
  useDeleteAcademicSubject, useDeleteAcademicTeacherAssignment, useGetAcademicSubjects,
  useGetAcademicTeachers, useGetAcademicTeacherAssignments, useGetLearningReportCards,
  useGetLearningReportCard, useGetLearningTerms, usePrepareLearningReportCards,
  usePublishLearningReportCards, usePrintLearningReportCard, useUpdateAcademicSubject, useGetSections,
} from '@workspace/api-client-react';
import type { AcademicSubject, LearningReportCard } from '@workspace/api-client-react';
import { BookOpen, Check, CircleAlert, FileText, Printer, Plus, Save, ShieldCheck, UsersRound, X } from 'lucide-react';

type Props = { roles: string[] };
type PanelTab = 'catalog' | 'reports';
const admins = ['org_admin', 'campus_admin', 'super_admin'];
const learningStaff = [...admins, 'teacher', 'class_teacher', 'hod'];
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Please try again.';
const shortDate = (date?: string | null) => date ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(date)) : 'Not published';

export function LearningOperations({ roles }: Props) {
  const canAdmin = roles.some(role => admins.includes(role));
  const canStaff = roles.some(role => learningStaff.includes(role));
  const familyView = roles.some(role => ['parent', 'student'].includes(role)) && !canStaff;
  const [tab, setTab] = useState<PanelTab>(canAdmin ? 'catalog' : 'reports');
  const [sectionId, setSectionId] = useState('');
  const [termId, setTermId] = useState('');
  const [selected, setSelected] = useState('');
  const [printId, setPrintId] = useState('');
  const printWindow = useRef<Window | null>(null);
  const [notice, setNotice] = useState('');
  const client = useQueryClient();
  const sections = useGetSections(undefined, { query: { enabled: canStaff } });
  const teacherSections = useGetAcademicTeacherAssignments(undefined, { query: { enabled: canStaff && !canAdmin } });
  const subjects = useGetAcademicSubjects({ query: { enabled: tab === 'catalog' && canAdmin } });
  const teachers = useGetAcademicTeachers({ query: { enabled: tab === 'catalog' && canAdmin } });
  const assignments = useGetAcademicTeacherAssignments({ sectionId: sectionId || undefined }, { query: { enabled: tab === 'catalog' && canAdmin } });
  const terms = useGetLearningTerms({ query: { enabled: tab === 'reports' && canStaff } });
  const reportCards = useGetLearningReportCards({ sectionId: canStaff ? sectionId || undefined : undefined, termId: termId || undefined }, { query: { enabled: tab === 'reports' && (!canStaff || Boolean(sectionId && termId)) } });
  const detail = useGetLearningReportCard(selected, { query: { enabled: !!selected, queryKey: getGetLearningReportCardQueryKey(selected) } });
  const print = usePrintLearningReportCard(printId, { query: { enabled: !!printId } });
  const assignmentsForSection = useMemo(() => assignments.data?.items ?? [], [assignments.data]);
  const allowedSections = useMemo(() => {
    const items = sections.data?.items ?? [];
    if (canAdmin) return items;
    const ids = new Set((teacherSections.data?.items ?? []).map(item => item.sectionId));
    return items.filter(section => ids.has(section.id));
  }, [sections.data, teacherSections.data, canAdmin]);
  const refreshSubjects = () => client.invalidateQueries({ queryKey: getGetAcademicSubjectsQueryKey() });
  const refreshAssignments = () => client.invalidateQueries({ queryKey: getGetAcademicTeacherAssignmentsQueryKey() });
  const refreshCards = () => client.invalidateQueries({ queryKey: getGetLearningReportCardsQueryKey() });
  const createSubject = useCreateAcademicSubject({ mutation: { onSuccess: refreshSubjects } });
  const updateSubject = useUpdateAcademicSubject({ mutation: { onSuccess: refreshSubjects } });
  const deleteSubject = useDeleteAcademicSubject({ mutation: { onSuccess: refreshSubjects } });
  const assignTeacher = useCreateAcademicTeacherAssignment({ mutation: { onSuccess: refreshAssignments } });
  const unassignTeacher = useDeleteAcademicTeacherAssignment({ mutation: { onSuccess: refreshAssignments } });
  const prepare = usePrepareLearningReportCards({ mutation: { onSuccess: refreshCards } });
  const publish = usePublishLearningReportCards({ mutation: { onSuccess: refreshCards } });
  const remark = useAddLearningReportCardRemark({ mutation: { onSuccess: card => { client.setQueryData(getGetLearningReportCardQueryKey(card.id), card); refreshCards(); } } });
  const cards = (reportCards.data?.items ?? []).filter(card => !familyView || card.published);
  const mutationError = createSubject.error || updateSubject.error || deleteSubject.error || assignTeacher.error || unassignTeacher.error || prepare.error || publish.error || remark.error;

  useEffect(() => {
    if (print.isError && printId) {
      printWindow.current?.close();
      printWindow.current = null;
      setPrintId('');
      return;
    }
    if (!print.data || !printId) return;
    const target = printWindow.current;
    if (target) {
      target.document.open();
      target.document.write(print.data);
      target.document.close();
      target.focus();
      window.setTimeout(() => target.print(), 300);
    }
    printWindow.current = null;
    setPrintId('');
  }, [print.data, printId, print.isError]);

  if (!canStaff && !roles.includes('student') && !roles.includes('parent')) return <div className="surface p-8 text-center"><ShieldCheck className="mx-auto mb-3 text-[hsl(var(--primary))]"/><b className="display">Learning access is restricted</b><p className="mb-0 mt-2 text-sm text-[hsl(var(--muted-foreground))]">This workspace is available to school staff and linked families.</p></div>;
  const openCard = (card: LearningReportCard) => setSelected(card.id);

  return <div className="space-y-5">
    <div className="surface flex flex-col justify-between gap-3 p-3 sm:flex-row sm:items-center">
      <div className="flex gap-1 overflow-x-auto" aria-label="Learning tools">
        {canAdmin && <button aria-pressed={tab === 'catalog'} onClick={() => { setTab('catalog'); setSelected(''); }} className={`rounded-lg px-4 py-2.5 text-xs font-bold transition ${tab === 'catalog' ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'hover:bg-[hsl(var(--secondary))]'}`}>Subjects & teachers</button>}
        <button aria-pressed={tab === 'reports'} onClick={() => { setTab('reports'); setSelected(''); }} className={`rounded-lg px-4 py-2.5 text-xs font-bold transition ${tab === 'reports' ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'hover:bg-[hsl(var(--secondary))]'}`}>{familyView ? 'Published report cards' : 'Report cards'}</button>
      </div>
      {canStaff && <label className="flex items-center gap-2 text-xs font-semibold text-[hsl(var(--muted-foreground))]"><UsersRound size={15}/><span className="sr-only">Filter by section</span><select className="field min-h-9 py-1.5 text-xs sm:w-[210px]" value={sectionId} onChange={event => setSectionId(event.target.value)}><option value="">All assigned sections</option>{(canAdmin ? sections.data?.items ?? [] : allowedSections).map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label>}
    </div>
    {notice && <div role="status" className="rounded-xl border border-[hsl(var(--status-good)/.3)] bg-[hsl(var(--status-good-bg))] px-4 py-3 text-sm text-[hsl(var(--brand-mint-ink))]">{notice}</div>}
    {mutationError && <div role="alert" className="rounded-xl border border-[hsl(var(--destructive)/.3)] bg-[hsl(var(--destructive)/.08)] px-4 py-3 text-sm text-[hsl(var(--destructive))]">{errorText(mutationError)}</div>}
    {tab === 'catalog' && canAdmin && <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
      <SubjectCatalog subjects={subjects.data?.items ?? []} loading={subjects.isLoading} error={subjects.error} retry={() => subjects.refetch()} create={(name, code) => createSubject.mutate({ data: { name, code: code || null } }, { onSuccess: () => setNotice('Subject added to the catalog.') })} update={(subject, data) => updateSubject.mutate({ subjectId: subject.id, data }, { onSuccess: () => setNotice('Subject details updated.') })} remove={subject => { if (window.confirm(`Remove ${subject.name} from the catalog?`)) deleteSubject.mutate({ subjectId: subject.id }, { onSuccess: () => setNotice('Subject removed.') }); }} busy={createSubject.isPending || updateSubject.isPending || deleteSubject.isPending}/>
      <section className="surface overflow-hidden">
        <div className="border-b border-[hsl(var(--border))] p-5"><div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><UsersRound size={17}/></div><div><h2 className="display m-0 text-lg font-extrabold">Teacher assignments</h2><p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">Pair each subject with its section and teacher.</p></div></div></div>
        <form className="grid gap-2 border-b border-[hsl(var(--border))] p-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); assignTeacher.mutate({ data: { sectionId: String(data.get('sectionId')), subjectId: String(data.get('subjectId')), teacherId: String(data.get('teacherId')), isClassTeacher: data.get('classTeacher') === 'on' } }, { onSuccess: () => { setNotice('Teacher assignment saved.'); form.reset(); } }); }}>
          <select required name="sectionId" className="field min-h-10 text-xs"><option value="">Choose section</option>{sections.data?.items.map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select>
          <select required name="subjectId" className="field min-h-10 text-xs"><option value="">Choose subject</option>{subjects.data?.items.filter(item => item.isActive).map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select>
          <select required name="teacherId" className="field min-h-10 text-xs"><option value="">Choose teacher</option>{teachers.data?.items.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}</select>
          <label className="flex items-center gap-2 px-2 text-xs font-semibold"><input type="checkbox" name="classTeacher" className="accent-[hsl(var(--primary))]"/> Class teacher</label>
          <button disabled={assignTeacher.isPending} className="btn btn-primary sm:col-span-2"><Plus size={15}/>{assignTeacher.isPending ? 'Assigning…' : 'Add assignment'}</button>
        </form>
        <div className="max-h-[440px] divide-y divide-[hsl(var(--border))] overflow-y-auto">{assignments.isLoading ? <div className="space-y-3 p-4"><div className="skeleton h-12"/><div className="skeleton h-12"/></div> : assignments.isError ? <LoadError message={errorText(assignments.error)} retry={() => assignments.refetch()}/> : assignmentsForSection.length === 0 ? <Empty text="No teaching assignments yet."/> : assignmentsForSection.map(item => <div key={item.id} className="flex items-center gap-3 p-4"><div className="min-w-0 flex-1"><div className="text-sm font-bold">{item.subjectName}</div><div className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">{item.sectionName} · {item.teacherName}{item.isClassTeacher ? ' · Class teacher' : ''}</div></div><button aria-label={`Remove ${item.teacherName} assignment`} disabled={unassignTeacher.isPending} className="btn btn-quiet btn-sm" onClick={() => { if (window.confirm(`Remove ${item.teacherName} from ${item.subjectName}?`)) unassignTeacher.mutate({ assignmentId: item.id }, { onSuccess: () => setNotice('Teacher assignment removed.') }); }}><X size={15}/></button></div>)}</div>
      </section>
    </div>}
    {tab === 'reports' && (selected ? <ReportDetail id={selected} familyView={familyView} card={detail.data} loading={detail.isLoading} error={detail.error} retry={() => detail.refetch()} printBusy={print.isFetching} onBack={() => setSelected('')} onPrint={() => { printWindow.current = window.open('', '_blank'); if (printWindow.current) setPrintId(selected); }} onRemark={(subjectId, text) => remark.mutate({ reportCardId: selected, data: { subjectId, remark: text } }, { onSuccess: () => setNotice('Remark saved to the draft report card.') })} remarkBusy={remark.isPending}/>
      : <div className="space-y-4">
        <section className="surface flex flex-col gap-4 p-4 md:flex-row md:items-end md:justify-between md:p-5"><div><h2 className="display m-0 text-lg font-extrabold">{familyView ? 'Results shared with your family' : 'Report card cycle'}</h2><p className="mb-0 mt-1 max-w-xl text-xs leading-5 text-[hsl(var(--muted-foreground))]">{familyView ? 'Only cards published by your school are shown here.' : 'Prepare cards from term marks, review remarks, then publish for families.'}</p></div><div className="flex flex-col gap-2 sm:flex-row">{!familyView && <select className="field min-h-10 text-xs sm:w-[190px]" value={termId} onChange={event => setTermId(event.target.value)}><option value="">All terms</option>{terms.data?.items.map(term => <option key={term.id} value={term.id}>{term.name}{term.isCurrent ? ' · Current' : ''}</option>)}</select>}{canStaff && <button disabled={!sectionId || !termId || prepare.isPending} className="btn btn-primary" onClick={() => prepare.mutate({ data: { sectionId, termId } }, { onSuccess: () => setNotice('Report cards prepared from available marks.') })}><FileText size={15}/>{prepare.isPending ? 'Preparing…' : 'Prepare cards'}</button>}</div></section>
        {!familyView && canStaff && <div className="flex flex-col justify-between gap-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--secondary)/.55)] p-4 sm:flex-row sm:items-center"><div><b className="text-xs">Publishing</b><p className="mb-0 mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">Publishing a section and term makes its cards visible to linked families. Withdrawal returns them to staff-only drafts.</p></div><div className="flex gap-2"><button disabled={!sectionId || !termId || publish.isPending} className="btn btn-primary btn-sm" onClick={() => { if (window.confirm('Publish report cards for this section and term?')) publish.mutate({ data: { sectionId, termId, published: true } }, { onSuccess: () => setNotice('Report cards published to families.') }); }}><Check size={14}/>Publish</button><button disabled={!sectionId || !termId || publish.isPending} className="btn btn-muted btn-sm" onClick={() => { if (window.confirm('Withdraw published report cards for this section and term?')) publish.mutate({ data: { sectionId, termId, published: false } }, { onSuccess: () => setNotice('Report cards withdrawn from family view.') }); }}>Withdraw</button></div></div>}
        {reportCards.isLoading || terms.isLoading ? <div className="space-y-3"><div className="skeleton h-20 w-full"/><div className="skeleton h-20 w-full"/></div> : reportCards.isError || terms.isError ? <LoadError message={errorText(reportCards.error || terms.error)} retry={() => { reportCards.refetch(); terms.refetch(); }}/> : cards.length === 0 ? <Empty text={familyView ? 'No published report cards are available yet.' : 'No report cards found for these filters. Choose a section and term to prepare cards.'}/> : <div className="surface overflow-hidden"><div className="hidden grid-cols-[1.4fr_1fr_.7fr_.6fr_auto] gap-4 border-b border-[hsl(var(--border))] bg-[hsl(var(--background))] px-5 py-3 text-[10px] font-bold uppercase tracking-[.12em] text-[hsl(var(--muted-foreground))] md:grid"><span>Learner</span><span>Section · term</span><span>Overall</span><span>Publication</span><span/></div><div className="divide-y divide-[hsl(var(--border))]">{cards.map(card => <button key={card.id} onClick={() => openCard(card)} className="grid w-full gap-2 px-4 py-4 text-left transition hover:bg-[hsl(var(--background))] md:grid-cols-[1.4fr_1fr_.7fr_.6fr_auto] md:items-center md:gap-4 md:px-5"><span><b className="block text-sm">{card.studentName}</b><small className="mt-1 block text-[10px] text-[hsl(var(--muted-foreground))]">{card.admissionNo}</small></span><span className="text-xs">{card.sectionName}<small className="mt-1 block text-[10px] text-[hsl(var(--muted-foreground))]">{card.termName}</small></span><span className="text-xs font-semibold">{card.overallPercent === null ? 'Marks missing' : `${card.overallPercent.toFixed(1)}% · ${card.overallGrade ?? '—'}`}</span><span className={`tag w-fit ${card.published ? 'tag-live' : ''}`}>{card.published ? `Published · ${shortDate(card.publishedAt)}` : 'Draft'}</span><span className="text-xs font-bold text-[hsl(var(--primary))]">Open</span></button>)}</div></div>}
      </div>)}
    {print.isError && <div role="alert" className="text-xs text-[hsl(var(--destructive))]">Could not prepare the printable report card. Try again.</div>}
  </div>;
}

function SubjectCatalog({ subjects, loading, error, retry, create, update, remove, busy }: { subjects: AcademicSubject[]; loading: boolean; error: unknown; retry: () => void; create: (name: string, code: string) => void; update: (subject: AcademicSubject, data: { name?: string; code?: string | null; isActive?: boolean }) => void; remove: (subject: AcademicSubject) => void; busy: boolean }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<AcademicSubject | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const resetForm = () => { setShowForm(false); setEditing(null); setName(''); setCode(''); };
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (editing) update(editing, { name: name.trim(), code: code.trim() || null }); else create(name.trim(), code.trim()); resetForm(); };
  return <section className="surface overflow-hidden">
    <header className="flex items-center justify-between gap-3 border-b border-[hsl(var(--border))] p-5"><div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><BookOpen size={17}/></div><div><h2 className="display m-0 text-lg font-extrabold">Subject catalog</h2><p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">The subjects taught across your school.</p></div></div><button className="btn btn-primary btn-sm" onClick={() => { setEditing(null); setName(''); setCode(''); setShowForm(true); }}><Plus size={14}/>Add subject</button></header>
    {(showForm || editing) && <form onSubmit={submit} className="grid gap-2 border-b border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4 sm:grid-cols-[1fr_120px_auto_auto]"><input required maxLength={100} aria-label="Subject name" className="field min-h-10 text-xs" placeholder="Subject name" value={name} onChange={event => setName(event.target.value)}/><input maxLength={24} aria-label="Subject code" className="field min-h-10 text-xs" placeholder="Code" value={code} onChange={event => setCode(event.target.value)}/><button disabled={busy} className="btn btn-primary btn-sm"><Save size={14}/>{editing ? 'Save' : 'Add'}</button><button type="button" onClick={resetForm} className="btn btn-muted btn-sm">Cancel</button></form>}
    {loading ? <div className="space-y-3 p-4"><div className="skeleton h-12"/><div className="skeleton h-12"/></div> : error ? <LoadError message={errorText(error)} retry={retry}/> : !subjects.length ? <Empty text="No subjects have been added to the catalog."/> : <div className="divide-y divide-[hsl(var(--border))]">{subjects.map(subject => <div key={subject.id} className="flex items-center gap-3 p-4"><span className="grid h-9 w-9 place-items-center rounded-lg bg-[hsl(var(--background))] text-[10px] font-extrabold text-[hsl(var(--primary))]">{subject.code || subject.name.slice(0, 2).toUpperCase()}</span><div className="min-w-0 flex-1"><div className="truncate text-sm font-bold">{subject.name}</div><div className="mt-1 text-[10px] text-[hsl(var(--muted-foreground))]">{subject.code || 'No code'} · {subject.isActive ? 'Active' : 'Inactive'}</div></div><button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => { setEditing(subject); setName(subject.name); setCode(subject.code ?? ''); setShowForm(false); }}>Edit</button><button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => update(subject, { isActive: !subject.isActive })}>{subject.isActive ? 'Deactivate' : 'Activate'}</button><button aria-label={`Delete ${subject.name}`} className="btn btn-quiet btn-sm text-[hsl(var(--destructive))]" disabled={busy} onClick={() => remove(subject)}><X size={15}/></button></div>)}</div>}
  </section>;
}

function ReportDetail({ id, familyView, card, loading, error, retry, printBusy, onBack, onPrint, onRemark, remarkBusy }: { id: string; familyView: boolean; card?: LearningReportCard; loading: boolean; error: unknown; retry: () => void; printBusy: boolean; onBack: () => void; onPrint: () => void; onRemark: (subjectId: string | null, text: string) => void; remarkBusy: boolean }) {
  const [subjectId, setSubjectId] = useState('');
  const [text, setText] = useState('');
  if (loading) return <div className="space-y-3"><div className="skeleton h-28 w-full"/><div className="skeleton h-52 w-full"/></div>;
  if (error || !card) return <LoadError message={errorText(error)} retry={retry}/>;
  return <article className="surface overflow-hidden">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[hsl(var(--border))] p-4 md:p-6"><div><button onClick={onBack} className="mb-2 text-xs font-bold text-[hsl(var(--primary))]">← All report cards</button><div className="flex flex-wrap items-center gap-2"><h2 className="display m-0 text-2xl font-extrabold">{card.studentName}</h2><span className={`tag ${card.published ? 'tag-live' : ''}`}>{card.published ? 'Published' : 'Draft'}</span></div><p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">{card.admissionNo} · {card.sectionName} · {card.termName}</p></div><button disabled={printBusy} onClick={onPrint} className="btn btn-muted"><Printer size={15}/>{printBusy ? 'Preparing print…' : 'Print report card'}</button></header>
    <div className="grid gap-3 bg-[hsl(var(--background))] p-4 sm:grid-cols-4 md:p-5">{[['Overall', card.overallPercent === null ? 'Not available' : `${card.overallPercent.toFixed(1)}%`], ['Grade', card.overallGrade ?? 'Not available'], ['Rank', card.rank === null ? 'Not available' : `${card.rank} of ${card.totalStudents}`], ['Attendance', card.attendancePercent === null ? 'Not available' : `${card.attendancePercent.toFixed(1)}%`]].map(([label, value]) => <div key={label} className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3"><div className="text-[10px] font-bold uppercase tracking-[.12em] text-[hsl(var(--muted-foreground))]">{label}</div><div className="display mt-2 text-lg font-extrabold">{value}</div></div>)}</div>
    <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left"><thead className="bg-[hsl(var(--background))] text-[10px] uppercase tracking-[.12em] text-[hsl(var(--muted-foreground))]"><tr><th className="px-5 py-3">Subject</th><th className="px-4 py-3">Score</th><th className="px-4 py-3">Result</th><th className="px-4 py-3">Remark</th></tr></thead><tbody className="divide-y divide-[hsl(var(--border))]">{card.subjects.length ? card.subjects.map(subject => <tr key={subject.subjectId}><td className="px-5 py-4 text-sm font-semibold">{subject.subjectName}</td><td className="px-4 py-4 text-xs">{subject.score} / {subject.maxPoints}</td><td className="px-4 py-4 text-xs font-semibold">{subject.percent.toFixed(1)}% · {subject.grade}</td><td className="px-4 py-4 text-xs text-[hsl(var(--muted-foreground))]">{subject.remark || 'No remark'}</td></tr>) : <tr><td colSpan={4} className="p-8 text-center text-sm text-[hsl(var(--muted-foreground))]">No subject mark data is available.</td></tr>}</tbody></table></div>
    <div className="border-t border-[hsl(var(--border))] p-4 md:p-5"><div className="text-xs font-bold">General remark</div><p className="mb-0 mt-2 text-sm leading-6 text-[hsl(var(--muted-foreground))]">{card.generalRemark || 'No general remark has been added.'}</p></div>
    {!familyView && !card.published && <form className="grid gap-2 border-t border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4 sm:grid-cols-[200px_1fr_auto] md:p-5" onSubmit={event => { event.preventDefault(); if (!text.trim()) return; onRemark(subjectId || null, text.trim()); setText(''); }}><select className="field text-xs" value={subjectId} onChange={event => setSubjectId(event.target.value)}><option value="">General remark</option>{card.subjects.map(subject => <option key={subject.subjectId} value={subject.subjectId}>{subject.subjectName}</option>)}</select><input required maxLength={2000} className="field text-xs" placeholder="Write a considered note for this learner" value={text} onChange={event => setText(event.target.value)}/><button disabled={remarkBusy || !text.trim()} className="btn btn-primary"><Save size={14}/>{remarkBusy ? 'Saving…' : 'Save remark'}</button></form>}
    {card.published && <div className="border-t border-[hsl(var(--border))] px-5 py-3 text-[11px] text-[hsl(var(--muted-foreground))]">Published {shortDate(card.publishedAt)} · Family view is read-only.</div>}
  </article>;
}

function Empty({ text }: { text: string }) { return <div className="p-9 text-center text-sm text-[hsl(var(--muted-foreground))]">{text}</div>; }
function LoadError({ message, retry }: { message: string; retry: () => void }) { return <div className="surface flex flex-col items-center gap-2 p-8 text-center"><CircleAlert className="text-[hsl(var(--destructive))]"/><b>We couldn’t load this yet</b><p className="m-0 text-xs text-[hsl(var(--muted-foreground))]">{message}</p><button onClick={retry} className="btn btn-muted btn-sm">Retry</button></div>; }
