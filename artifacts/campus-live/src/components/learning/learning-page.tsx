import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCreateLearningAssignment, useCreateLearningExam, useCreateLearningTerm,
  useGetLearningAssignments, getGetLearningAssignmentsQueryKey, useGetMyLearningAssignments,
  getGetMyLearningAssignmentsQueryKey, useGetLearningExams, getGetLearningExamsQueryKey,
  useGetLearningSubmissions, getGetLearningSubmissionsQueryKey, useSubmitLearningAssignment,
  useGradeLearningSubmission, useUpdateLearningAssignment, useGetLearningExamMarks,
  getGetLearningExamMarksQueryKey, useUpdateLearningExamMarks, usePublishLearningExam,
  useGetLearningTerms, getGetLearningTermsQueryKey, useGetLearningGradeScale,
  getGetLearningGradeScaleQueryKey, useUpdateLearningGradeScale, useGetSections,
} from '@workspace/api-client-react';
import type { LearningAssignment, LearningExam, LearningMark, LearningSubmission } from '@workspace/api-client-react';
import {
  BookOpenCheck, CalendarDays, Check, ClipboardList, Clock3, FileText,
  GraduationCap, MessageSquareText, Plus, Save, Send, Settings2, UsersRound, X,
} from 'lucide-react';

type Props = { roles: string[] };
type Tab = 'assignments' | 'exams' | 'terms';
const canManage = (roles: string[]) => roles.some(role => ['teacher', 'class_teacher', 'hod', 'org_admin', 'campus_admin', 'super_admin'].includes(role));
const canAdminister = (roles: string[]) => roles.some(role => ['org_admin', 'campus_admin', 'super_admin'].includes(role));
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Please try again.';
const formatDate = (value?: string | null) => {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: value.includes('T') ? 'short' : undefined }).format(date);
};
const localValue = (value?: string) => value ? value.slice(0, 16) : '';
const toIsoDate = (value: string) => new Date(value).toISOString();
const statusStyle = (status: string) => status === 'published' ? 'bg-[hsl(var(--status-good-bg))] text-[hsl(var(--brand-mint-ink))]' : status === 'closed' ? 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]' : 'bg-[hsl(var(--accent)/.16)] text-[hsl(var(--foreground))]';

export function LearningPage({ roles }: Props) {
  const manager = canManage(roles);
  const administrator = canAdminister(roles);
  const [tab, setTab] = useState<Tab>('assignments');
  const [sectionId, setSectionId] = useState('');
  const [activeAssignment, setActiveAssignment] = useState<LearningAssignment | null>(null);
  const [activeExam, setActiveExam] = useState<LearningExam | null>(null);
  const sections = useGetSections();
  const resolvedSection = sectionId || sections.data?.items[0]?.id || '';
  const params = useMemo(() => manager && resolvedSection ? { sectionId: resolvedSection } : undefined, [manager, resolvedSection]);
  const managedAssignments = useGetLearningAssignments(params, { query: { enabled: manager } });
  const myAssignments = useGetMyLearningAssignments({ query: { enabled: !manager } });
  const exams = useGetLearningExams(params, { query: { enabled: tab === 'exams' || tab === 'terms' } });
  const terms = useGetLearningTerms({ query: { enabled: tab === 'terms' && administrator } });
  const scale = useGetLearningGradeScale({ query: { enabled: tab === 'terms' && administrator } });
  const queryClient = useQueryClient();
  const assignments = manager ? managedAssignments.data?.items ?? [] : myAssignments.data?.items ?? [];
  const isLoading = manager ? managedAssignments.isLoading : myAssignments.isLoading;
  const loadError = manager ? managedAssignments.error : myAssignments.error;
  const invalidateAssignments = () => {
    queryClient.invalidateQueries({ queryKey: getGetLearningAssignmentsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetMyLearningAssignmentsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetLearningAssignmentsQueryKey(params) });
  };
  const addAssignment = useCreateLearningAssignment({ mutation: { onSuccess: invalidateAssignments } });
  const editAssignment = useUpdateLearningAssignment({ mutation: { onSuccess: invalidateAssignments } });
  const addExam = useCreateLearningExam({ mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetLearningExamsQueryKey() }) } });
  const addTerm = useCreateLearningTerm({ mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetLearningTermsQueryKey() }) } });
  const updateScale = useUpdateLearningGradeScale({ mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetLearningGradeScaleQueryKey() }) } });
  const busy = addAssignment.isPending || editAssignment.isPending || addExam.isPending || addTerm.isPending || updateScale.isPending;
  const [showAssignmentForm, setShowAssignmentForm] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState<LearningAssignment | null>(null);
  const [showExamForm, setShowExamForm] = useState(false);
  const [showTermForm, setShowTermForm] = useState(false);
  const [notice, setNotice] = useState('');
  const failure = addAssignment.error || editAssignment.error || addExam.error || addTerm.error || updateScale.error;

  return <div className="space-y-6">
    <header className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
      <div><div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.2em] text-[hsl(var(--primary))]"><span className="h-px w-7 bg-[hsl(var(--accent))]"/>Learning workspace</div>
        <h1 className="display m-0 text-[32px] font-extrabold tracking-[-.045em] md:text-[38px]">Work & results</h1>
        <p className="mb-0 mt-2 max-w-2xl text-[13px] text-[hsl(var(--muted-foreground))]">{manager ? 'Keep assignments, submissions and assessments in one dependable place.' : 'Your schoolwork, feedback and published results — all in one view.'}</p>
      </div>
      {manager && <div className="flex flex-wrap gap-2">
        <button onClick={() => setShowAssignmentForm(true)} className="btn btn-primary"><Plus size={16}/>Assignment</button>
        <button onClick={() => setShowExamForm(true)} className="btn btn-muted"><Plus size={16}/>Assessment</button>
      </div>}
    </header>
    <div className="surface flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
      <nav aria-label="Learning sections" className="flex gap-1 overflow-x-auto">
        {(['assignments', 'exams', ...(administrator ? ['terms'] : [])] as Tab[]).map(item => <button key={item} onClick={() => { setTab(item); setActiveAssignment(null); setActiveExam(null); }} aria-pressed={tab === item} className={`rounded-lg px-4 py-2.5 text-xs font-bold capitalize transition ${tab === item ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))]'}`}>{item === 'exams' ? 'Assessments & results' : item}</button>)}
      </nav>
      {manager && <label className="flex items-center gap-2 px-1 text-[11px] font-semibold text-[hsl(var(--muted-foreground))]"><UsersRound size={15}/><span className="sr-only">Filter by section</span><select className="field min-h-9 w-full py-1.5 text-xs sm:w-auto" value={sectionId} onChange={event => setSectionId(event.target.value)}><option value="">All assigned sections</option>{sections.data?.items.map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label>}
    </div>
    {notice && <div role="status" className="rounded-xl border border-[hsl(var(--status-good)/.3)] bg-[hsl(var(--status-good-bg))] px-4 py-3 text-sm text-[hsl(var(--brand-mint-ink))]">{notice}</div>}
    {failure && <div role="alert" className="rounded-xl border border-[hsl(var(--destructive)/.3)] bg-[hsl(var(--destructive)/.08)] px-4 py-3 text-sm text-[hsl(var(--destructive))]">{errorMessage(failure)}</div>}
    {showAssignmentForm && <AssignmentForm sections={sections.data?.items ?? []} saving={busy} onCancel={() => setShowAssignmentForm(false)} onSave={data => addAssignment.mutate({ data }, { onSuccess: () => { setShowAssignmentForm(false); setNotice('Assignment created.'); } })}/>}
    {editingAssignment && <AssignmentForm sections={sections.data?.items ?? []} initial={editingAssignment} saving={busy} onCancel={() => setEditingAssignment(null)} onSave={data => {
      const update = { title: data.title, instructions: data.instructions, dueAt: data.dueAt, maxPoints: data.maxPoints };
      editAssignment.mutate({ assignmentId: editingAssignment.id, data: update }, { onSuccess: () => { setEditingAssignment(null); invalidateAssignments(); setNotice('Assignment updated.'); } });
    }}/>}
    {showExamForm && <ExamForm sections={sections.data?.items ?? []} saving={busy} onCancel={() => setShowExamForm(false)} onSave={data => addExam.mutate({ data }, { onSuccess: () => { setShowExamForm(false); setNotice('Assessment created.'); } })}/>}
    {showTermForm && <TermForm saving={busy} onCancel={() => setShowTermForm(false)} onSave={data => addTerm.mutate({ data }, { onSuccess: () => { setShowTermForm(false); setNotice('Academic term created.'); } })}/>}
    {tab === 'assignments' && (activeAssignment
       ? <AssignmentDetail key={activeAssignment.id} assignment={activeAssignment} manager={manager} canSubmit={roles.includes('student')} onBack={() => setActiveAssignment(null)} onRefresh={invalidateAssignments} onNotice={setNotice}/>
      : <AssignmentList items={assignments} loading={isLoading} error={loadError} manager={manager} retry={() => manager ? managedAssignments.refetch() : myAssignments.refetch()} onSelect={setActiveAssignment} onEdit={setEditingAssignment} onStatus={(item, status) => editAssignment.mutate({ assignmentId: item.id, data: { status } }, { onSuccess: () => setNotice(`Assignment ${status}.`) })} saving={editAssignment.isPending}/> )}
    {tab === 'exams' && (activeExam
      ? <ExamDetail key={activeExam.id} exam={activeExam} manager={manager} onBack={() => setActiveExam(null)} onNotice={setNotice}/>
      : <ExamList exams={exams.data?.items ?? []} loading={exams.isLoading} error={exams.error} retry={() => exams.refetch()} manager={manager} onSelect={setActiveExam}/>)}
    {tab === 'terms' && administrator && <TermScalePanel terms={terms.data?.items ?? []} termsLoading={terms.isLoading} termsError={terms.error} retryTerms={() => terms.refetch()} bands={scale.data?.bands ?? []} scaleLoading={scale.isLoading} scaleError={scale.error} retryScale={() => scale.refetch()} onAddTerm={() => setShowTermForm(true)} onSaveScale={bands => updateScale.mutate({ data: { bands } }, { onSuccess: () => setNotice('Grade scale saved.') })} saving={updateScale.isPending}/>}
  </div>;
}

function AssignmentList({ items, loading, error, manager, retry, onSelect, onEdit, onStatus, saving }: { items: LearningAssignment[]; loading: boolean; error: unknown; manager: boolean; retry: () => void; onSelect: (item: LearningAssignment) => void; onEdit: (item: LearningAssignment) => void; onStatus: (item: LearningAssignment, status: 'published' | 'closed') => void; saving: boolean }) {
  if (loading) return <div className="space-y-3" aria-label="Loading assignments"><div className="skeleton h-28 w-full"/><div className="skeleton h-28 w-full"/><div className="skeleton h-28 w-full"/></div>;
  if (error) return <ErrorPanel error={error} retry={retry}/>;
  if (!items.length) return <EmptyPanel title="No assignments yet" text="Assignments shared with your role will appear here." icon={<BookOpenCheck size={20}/>} />;
  return <section className="space-y-3" aria-label="Assignments">
    {items.map(item => <article key={item.id} className="surface overflow-hidden">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:p-5">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><FileText size={20}/></div>
        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="display m-0 text-base font-extrabold">{item.title}</h2><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold capitalize ${statusStyle(item.status)}`}>{item.status}</span></div>
          <p className="mb-0 mt-1.5 line-clamp-2 text-xs leading-5 text-[hsl(var(--muted-foreground))]">{item.instructions || 'No additional instructions.'}</p>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[11px] text-[hsl(var(--muted-foreground))]"><span className="flex items-center gap-1.5"><CalendarDays size={13}/>Due {formatDate(item.dueAt)}</span><span>{item.sectionName}</span><span>{item.maxPoints} points</span>{manager ? <span>{item.submissionCount} submissions</span> : item.studentName && <span>{item.studentName}</span>}</div>
          {!manager && item.mySubmission && <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[hsl(var(--status-good-bg))] px-2.5 py-1 text-[10px] font-bold text-[hsl(var(--brand-mint-ink))]"><Check size={12}/>{item.mySubmission.gradePoints !== null ? `${item.mySubmission.gradePoints}/${item.maxPoints} graded` : 'Submitted'}</div>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          <button className="btn btn-muted btn-sm" onClick={() => onSelect(item)}>{manager ? 'Submissions' : item.mySubmission ? 'View work' : 'Open assignment'}</button>
           {manager && <>{item.status === 'draft' && <><button className="btn btn-quiet btn-sm" onClick={() => onEdit(item)}>Edit</button><button className="btn btn-primary btn-sm" disabled={saving} onClick={() => onStatus(item, 'published')}>Publish</button></>}{item.status === 'published' && <button className="btn btn-quiet btn-sm" disabled={saving} onClick={() => onStatus(item, 'closed')}>Close</button>}</>}
        </div>
      </div>
    </article>)}
  </section>;
}

function AssignmentForm({ sections, saving, onCancel, onSave, initial }: { sections: { id: string; name: string }[]; saving: boolean; onCancel: () => void; onSave: (data: { sectionId: string; title: string; instructions: string; dueAt: string; maxPoints: number }) => void; initial?: LearningAssignment }) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [sectionId, setSectionId] = useState(initial?.sectionId ?? sections[0]?.id ?? '');
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [dueAt, setDueAt] = useState(localValue(initial?.dueAt));
  const [maxPoints, setMaxPoints] = useState(String(initial?.maxPoints ?? 100));
  return <form className="surface space-y-4 border-l-4 border-l-[hsl(var(--primary))] p-4 md:p-5" onSubmit={event => { event.preventDefault(); onSave({ sectionId, title: title.trim(), instructions: instructions.trim(), dueAt: toIsoDate(dueAt), maxPoints: Number(maxPoints) }); }}>
    <div className="flex items-center justify-between"><div><h2 className="display m-0 text-lg font-extrabold">{initial ? 'Edit assignment' : 'Create assignment'}</h2><p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">Set clear expectations and a due date.</p></div><button type="button" aria-label="Cancel assignment form" className="btn btn-quiet px-2" onClick={onCancel}><X size={18}/></button></div>
    <div className="grid gap-3 md:grid-cols-2">
      {!initial && <label className="text-xs font-bold">Section<select required className="field mt-1.5" value={sectionId} onChange={event => setSectionId(event.target.value)}><option value="">Choose section</option>{sections.map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label>}
      <label className="text-xs font-bold">Title<input required maxLength={180} className="field mt-1.5" value={title} onChange={event => setTitle(event.target.value)}/></label>
      <label className="text-xs font-bold">Due date and time<input required type="datetime-local" className="field mt-1.5" value={dueAt} onChange={event => setDueAt(event.target.value)}/></label>
      <label className="text-xs font-bold">Maximum points<input required type="number" min="1" max="100000" className="field mt-1.5" value={maxPoints} onChange={event => setMaxPoints(event.target.value)}/></label>
    </div>
    <label className="block text-xs font-bold">Instructions<textarea maxLength={12000} rows={3} className="field mt-1.5 resize-y" value={instructions} onChange={event => setInstructions(event.target.value)}/></label>
    <div className="flex justify-end gap-2"><button type="button" className="btn btn-muted" onClick={onCancel}>Cancel</button><button disabled={saving || !sectionId || !dueAt} className="btn btn-primary"><Save size={15}/>{saving ? 'Saving…' : initial ? 'Save changes' : 'Create assignment'}</button></div>
  </form>;
}

function AssignmentDetail({ assignment, manager, canSubmit, onBack, onRefresh, onNotice }: { assignment: LearningAssignment; manager: boolean; canSubmit: boolean; onBack: () => void; onRefresh: () => void; onNotice: (text: string) => void }) {
  const queryClient = useQueryClient();
  const submissions = useGetLearningSubmissions(assignment.id, { query: { enabled: manager, queryKey: getGetLearningSubmissionsQueryKey(assignment.id) } });
  const submit = useSubmitLearningAssignment({ mutation: { onSuccess: () => { onRefresh(); queryClient.invalidateQueries({ queryKey: getGetLearningSubmissionsQueryKey(assignment.id) }); } } });
  const grade = useGradeLearningSubmission({ mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetLearningSubmissionsQueryKey(assignment.id) }) } });
  const [content, setContent] = useState(assignment.mySubmission?.content ?? '');
  const [editing, setEditing] = useState(false);
  return <section className="surface overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[hsl(var(--border))] p-4 md:p-5"><div><button onClick={onBack} className="mb-2 flex items-center gap-1 text-xs font-bold text-[hsl(var(--primary))]">← All assignments</button><h2 className="display m-0 text-xl font-extrabold">{assignment.title}</h2><p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">{assignment.sectionName} · Due {formatDate(assignment.dueAt)} · {assignment.maxPoints} points</p></div><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold capitalize ${statusStyle(assignment.status)}`}>{assignment.status}</span></div>
     {!manager ? <div className="p-4 md:p-6">
       <div className="rounded-xl bg-[hsl(var(--background))] p-4 text-sm leading-6">{assignment.instructions || 'No additional instructions were provided.'}</div>
       {!canSubmit && assignment.mySubmission && <div className="mt-4 rounded-xl border border-[hsl(var(--border))] p-4"><h3 className="m-0 text-xs font-bold">Submitted work · {assignment.studentName}</h3><p className="mb-0 mt-2 whitespace-pre-wrap text-sm leading-6">{assignment.mySubmission.content}</p></div>}
       {assignment.mySubmission?.feedback && <div className="mt-4 rounded-xl border border-[hsl(var(--status-good)/.3)] bg-[hsl(var(--status-good-bg))] p-4"><div className="flex items-center gap-2 text-xs font-bold text-[hsl(var(--brand-mint-ink))]"><MessageSquareText size={15}/>Teacher feedback {assignment.mySubmission.gradePoints !== null && <span className="ml-auto">{assignment.mySubmission.gradePoints}/{assignment.maxPoints}</span>}</div><p className="mb-0 mt-2 text-sm leading-6">{assignment.mySubmission.feedback}</p></div>}
       {canSubmit && assignment.status === 'published' && <form className="mt-5 space-y-3" onSubmit={event => { event.preventDefault(); submit.mutate({ assignmentId: assignment.id, data: { content: content.trim() } }, { onSuccess: () => { setEditing(false); onNotice('Your work has been submitted.'); } }); }}>
         <label className="block text-xs font-bold">{assignment.mySubmission ? 'Your submission' : 'Write your response'}<textarea required maxLength={12000} rows={7} disabled={!!assignment.mySubmission && (!editing || assignment.mySubmission.gradePoints !== null)} className="field mt-1.5 resize-y" value={content} onChange={event => setContent(event.target.value)}/></label>
         <div className="flex flex-wrap justify-between gap-2"><span className="text-[11px] text-[hsl(var(--muted-foreground))]">{assignment.mySubmission ? `Submitted ${formatDate(assignment.mySubmission.submittedAt)}${assignment.mySubmission.isLate ? ' · Late' : ''}` : 'Your response is saved when submitted.'}</span><div className="flex gap-2">
           {assignment.mySubmission && assignment.mySubmission.gradePoints === null && !editing && <button type="button" className="btn btn-muted" onClick={() => setEditing(true)}>Edit response</button>}
           {(!assignment.mySubmission || editing) && <button disabled={submit.isPending || !content.trim() || Boolean(assignment.mySubmission && assignment.mySubmission.gradePoints !== null)} className="btn btn-primary"><Send size={15}/>{submit.isPending ? 'Submitting…' : 'Submit work'}</button>}
         </div></div>{submit.isError && <p role="alert" className="text-xs text-[hsl(var(--destructive))]">{errorMessage(submit.error)}</p>}
       </form>}
       {canSubmit && assignment.status !== 'published' && <p className="mt-4 text-xs text-[hsl(var(--muted-foreground))]">This assignment is not accepting submissions.</p>}
       {!canSubmit && !assignment.mySubmission && <p className="mt-4 text-xs text-[hsl(var(--muted-foreground))]">This linked student has not submitted work yet.</p>}
     </div> : <div className="p-4 md:p-6"><p className="mb-4 text-sm text-[hsl(var(--muted-foreground))]">{assignment.instructions || 'No instructions provided.'}</p>{submissions.isLoading ? <div className="space-y-2"><div className="skeleton h-20 w-full"/><div className="skeleton h-20 w-full"/></div> : submissions.error ? <ErrorPanel error={submissions.error} retry={() => submissions.refetch()}/> : !(submissions.data?.items.length) ? <EmptyPanel title="No submissions received" text="Student submissions will appear here as they come in." icon={<ClipboardList size={20}/>} /> : <div className="space-y-3">{submissions.data.items.map(item => <GradeSubmission key={item.studentId} assignment={assignment} submission={item} saving={grade.isPending} error={grade.error} onSave={(gradePoints, feedback) => grade.mutate({ assignmentId: assignment.id, studentId: item.studentId, data: { gradePoints, feedback } }, { onSuccess: () => onNotice(`Feedback saved for ${item.studentName}.`) })}/>)}</div>}</div>}
  </section>;
}

function GradeSubmission({ assignment, submission, saving, error, onSave }: { assignment: LearningAssignment; submission: LearningSubmission; saving: boolean; error: unknown; onSave: (points: number, feedback: string) => void }) {
  const [points, setPoints] = useState(String(submission.gradePoints ?? ''));
  const [feedback, setFeedback] = useState(submission.feedback ?? '');
  return <article className="rounded-xl border border-[hsl(var(--border))] p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="m-0 text-sm font-bold">{submission.studentName}</h3><p className="mb-0 mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">Submitted {formatDate(submission.submittedAt)}{submission.isLate ? ' · Late' : ''}</p></div>{submission.gradedAt && <span className="tag">Graded</span>}</div><p className="my-3 whitespace-pre-wrap rounded-lg bg-[hsl(var(--background))] p-3 text-sm leading-6">{submission.content}</p><div className="grid gap-3 sm:grid-cols-[130px_1fr]"><label className="text-xs font-bold">Score <span className="font-normal text-[hsl(var(--muted-foreground))]">/ {assignment.maxPoints}</span><input aria-label={`Score for ${submission.studentName}`} type="number" min="0" max={assignment.maxPoints} className="field mt-1.5" value={points} onChange={event => setPoints(event.target.value)}/></label><label className="text-xs font-bold">Feedback<textarea maxLength={4000} rows={2} className="field mt-1.5 resize-y" value={feedback} onChange={event => setFeedback(event.target.value)}/></label></div><div className="mt-3 flex justify-end"><button disabled={saving || points === '' || Number(points) > assignment.maxPoints} className="btn btn-primary btn-sm" onClick={() => onSave(Number(points), feedback)}><Save size={14}/>{saving ? 'Saving…' : 'Save feedback'}</button></div>{Boolean(error) && <p role="alert" className="mt-2 text-xs text-[hsl(var(--destructive))]">{errorMessage(error)}</p>}</article>;
}

function ExamList({ exams, loading, error, retry, manager, onSelect }: { exams: LearningExam[]; loading: boolean; error: unknown; retry: () => void; manager: boolean; onSelect: (exam: LearningExam) => void }) {
  if (loading) return <div className="space-y-3" aria-label="Loading assessments"><div className="skeleton h-24 w-full"/><div className="skeleton h-24 w-full"/></div>;
  if (error) return <ErrorPanel error={error} retry={retry}/>;
  if (!exams.length) return <EmptyPanel title="No assessments available" text="Assessments and results shared with your role will appear here." icon={<GraduationCap size={20}/>} />;
  return <div className="space-y-3">{exams.map(exam => <article key={exam.id} className="surface flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5"><div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><GraduationCap size={20}/></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="display m-0 text-base font-extrabold">{exam.title}</h2><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold capitalize ${statusStyle(exam.status)}`}>{exam.status}</span></div><p className="mb-0 mt-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">{exam.sectionName} · {exam.termName || 'Assessment'} · {formatDate(exam.examDate)} · {exam.maxPoints} points</p>{!manager && exam.results.length > 0 && <div className="mt-2 text-xs font-semibold text-[hsl(var(--brand-mint-ink))]">{exam.results.length === 1 ? `${exam.results[0].score ?? '—'} / ${exam.maxPoints} · ${exam.results[0].grade ?? 'Result'}` : `${exam.results.length} published results`}</div>}</div><button className="btn btn-muted btn-sm" onClick={() => onSelect(exam)}>{manager ? 'Enter marks' : 'View result'}</button></article>)}</div>;
}

function ExamForm({ sections, saving, onCancel, onSave }: { sections: { id: string; name: string }[]; saving: boolean; onCancel: () => void; onSave: (data: { sectionId: string; title: string; examDate: string; maxPoints: number; termId: string | null }) => void }) {
  const terms = useGetLearningTerms();
  const [sectionId, setSectionId] = useState(sections[0]?.id ?? '');
  const [termId, setTermId] = useState('');
  const [title, setTitle] = useState('');
  const [examDate, setExamDate] = useState('');
  const [maxPoints, setMaxPoints] = useState('100');
  return <form className="surface space-y-4 border-l-4 border-l-[hsl(var(--accent))] p-4 md:p-5" onSubmit={event => { event.preventDefault(); onSave({ sectionId, title: title.trim(), examDate: examDate.slice(0, 10), maxPoints: Number(maxPoints), termId: termId || null }); }}>
    <div className="flex items-center justify-between"><div><h2 className="display m-0 text-lg font-extrabold">Create assessment</h2><p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">Marks become visible according to the exam’s published state.</p></div><button aria-label="Cancel assessment form" type="button" onClick={onCancel} className="btn btn-quiet px-2"><X size={18}/></button></div>
    <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-bold">Section<select className="field mt-1.5" required value={sectionId} onChange={event => setSectionId(event.target.value)}><option value="">Choose section</option>{sections.map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label><label className="text-xs font-bold">Term<select className="field mt-1.5" value={termId} onChange={event => setTermId(event.target.value)}><option value="">No term</option>{terms.data?.items.map(term => <option key={term.id} value={term.id}>{term.name}</option>)}</select></label><label className="text-xs font-bold">Assessment title<input required maxLength={180} className="field mt-1.5" value={title} onChange={event => setTitle(event.target.value)}/></label><label className="text-xs font-bold">Assessment date<input required type="date" className="field mt-1.5" value={examDate} onChange={event => setExamDate(event.target.value)}/></label><label className="text-xs font-bold">Maximum points<input required type="number" min="1" max="100000" className="field mt-1.5" value={maxPoints} onChange={event => setMaxPoints(event.target.value)}/></label></div>
    <div className="flex justify-end gap-2"><button type="button" className="btn btn-muted" onClick={onCancel}>Cancel</button><button disabled={saving || !sectionId || !examDate} className="btn btn-primary"><Plus size={15}/>{saving ? 'Saving…' : 'Create assessment'}</button></div>
  </form>;
}

function ExamDetail({ exam, manager, onBack, onNotice }: { exam: LearningExam; manager: boolean; onBack: () => void; onNotice: (text: string) => void }) {
  const queryClient = useQueryClient();
  const marks = useGetLearningExamMarks(exam.id, { query: { queryKey: getGetLearningExamMarksQueryKey(exam.id) } });
  const [status, setStatus] = useState(exam.status);
  const locked = status === 'published';
  const update = useUpdateLearningExamMarks({ mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetLearningExamMarksQueryKey(exam.id) }) } });
  const publish = usePublishLearningExam({ mutation: { onSuccess: (updated) => {
    setStatus(updated.status);
    queryClient.invalidateQueries({ queryKey: getGetLearningExamsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetLearningExamsQueryKey({ sectionId: exam.sectionId }) });
    queryClient.invalidateQueries({ queryKey: getGetLearningExamMarksQueryKey(exam.id) });
  } } });
  const [edited, setEdited] = useState<Record<string, { score: string; feedback: string }>>({});
  const rows: LearningMark[] = marks.data?.items ?? [];
  const rowValue = (row: LearningMark) => edited[row.studentId] ?? { score: row.score === null ? '' : String(row.score), feedback: row.feedback ?? '' };
  return <section className="surface overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[hsl(var(--border))] p-4 md:p-5"><div><button onClick={onBack} className="mb-2 flex items-center gap-1 text-xs font-bold text-[hsl(var(--primary))]">← Assessments & results</button><h2 className="display m-0 text-xl font-extrabold">{exam.title}</h2><p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">{exam.sectionName} · {formatDate(exam.examDate)} · Out of {exam.maxPoints}</p></div><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold capitalize ${statusStyle(status)}`}>{status}</span></div>
    <div className="p-4 md:p-6">
      {marks.isLoading ? <div className="space-y-2"><div className="skeleton h-14 w-full"/><div className="skeleton h-14 w-full"/></div>
        : marks.error ? <ErrorPanel error={marks.error} retry={() => marks.refetch()}/>
        : !rows.length ? <EmptyPanel title={manager ? 'No marks to enter' : 'No result published'} text={manager ? 'There are no learner marks available for this assessment.' : 'When results are available to your role, they will appear here.'} icon={<ClipboardList size={20}/>} />
        : manager ? <>
          <div className="space-y-2">{rows.map(row => { const value = rowValue(row); return <div key={row.studentId} className="grid gap-2 rounded-xl border border-[hsl(var(--border))] p-3 sm:grid-cols-[1fr_130px_1.4fr] sm:items-center">
            <div className="text-sm font-bold">{row.studentName}</div>
            <label className="text-[10px] font-bold">Score<input aria-label={`Score for ${row.studentName}`} type="number" min="0" max={exam.maxPoints} disabled={locked} className="field mt-1 min-h-10" value={value.score} onChange={event => setEdited(old => ({ ...old, [row.studentId]: { ...value, score: event.target.value } }))}/></label>
            <label className="text-[10px] font-bold">Feedback<input aria-label={`Feedback for ${row.studentName}`} maxLength={4000} disabled={locked} className="field mt-1 min-h-10" value={value.feedback} onChange={event => setEdited(old => ({ ...old, [row.studentId]: { ...value, feedback: event.target.value } }))}/></label>
          </div>})}</div>
          <div className="flex flex-wrap justify-end gap-2 pt-3">
            {!locked && <button disabled={update.isPending} className="btn btn-muted" onClick={() => update.mutate({ examId: exam.id, data: { marks: rows.map(row => ({ studentId: row.studentId, score: rowValue(row).score === '' ? null : Number(rowValue(row).score), feedback: rowValue(row).feedback })) } }, { onSuccess: () => { setEdited({}); onNotice('Assessment marks saved.'); } })}><Save size={15}/>{update.isPending ? 'Saving…' : 'Save marks'}</button>}
            <button disabled={publish.isPending} className="btn btn-primary" onClick={() => publish.mutate({ examId: exam.id, data: { published: !locked } }, { onSuccess: () => onNotice(locked ? 'Results unpublished.' : 'Results published.') })}>{locked ? <X size={15}/> : <Check size={15}/>} {publish.isPending ? 'Updating…' : locked ? 'Unpublish results' : 'Publish results'}</button>
          </div>
          {(update.error || publish.error) && <p role="alert" className="mt-2 text-xs text-[hsl(var(--destructive))]">{errorMessage(update.error || publish.error)}</p>}
        </> : <div className="space-y-2">{rows.map(row => <article key={row.studentId} className="rounded-xl border border-[hsl(var(--border))] p-4"><div className="flex items-center justify-between gap-3"><h3 className="m-0 text-sm font-bold">{row.studentName}</h3><div className="display text-lg font-extrabold">{row.score ?? '—'} <span className="text-xs font-medium text-[hsl(var(--muted-foreground))]">/ {exam.maxPoints}</span></div></div>{(row.grade || row.feedback) && <div className="mt-3 border-t border-[hsl(var(--border))] pt-3 text-sm"><div className="font-bold text-[hsl(var(--primary))]">{row.grade || 'Result'}</div>{row.feedback && <p className="mb-0 mt-1 text-[hsl(var(--muted-foreground))]">{row.feedback}</p>}</div>}</article>)}</div>}
    </div>
  </section>;
}

function TermScalePanel({ terms, termsLoading, termsError, retryTerms, bands, scaleLoading, scaleError, retryScale, onAddTerm, onSaveScale, saving }: { terms: { id: string; name: string; startsOn: string; endsOn: string; isCurrent: boolean }[]; termsLoading: boolean; termsError: unknown; retryTerms: () => void; bands: { grade: string; minPercent: number }[]; scaleLoading: boolean; scaleError: unknown; retryScale: () => void; onAddTerm: () => void; onSaveScale: (bands: { grade: string; minPercent: number }[]) => void; saving: boolean }) {
  const [localBands, setLocalBands] = useState<{ grade: string; minPercent: number }[] | null>(null);
  const shownBands = localBands ?? bands;
  return <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
    <section className="surface p-4 md:p-5"><div className="mb-4 flex items-center justify-between gap-2"><div><div className="flex items-center gap-2"><CalendarDays size={17} className="text-[hsl(var(--primary))]"/><h2 className="display m-0 text-lg font-extrabold">Academic terms</h2></div><p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">Term dates used across assessments.</p></div><button className="btn btn-muted btn-sm" onClick={onAddTerm}><Plus size={14}/>Add term</button></div>
      {termsLoading ? <div className="skeleton h-16 w-full"/> : termsError ? <ErrorPanel error={termsError} retry={retryTerms}/> : terms.length ? <div className="divide-y divide-[hsl(var(--border))]">{terms.map(term => <div key={term.id} className="flex items-center justify-between gap-3 py-3"><div><div className="text-sm font-bold">{term.name} {term.isCurrent && <span className="tag ml-1">Current</span>}</div><div className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">{formatDate(term.startsOn)} – {formatDate(term.endsOn)}</div></div><Clock3 size={16} className="text-[hsl(var(--muted-foreground))]"/></div>)}</div> : <EmptyPanel title="No terms set" text="Add an academic term when your school is ready." icon={<CalendarDays size={19}/>} />}
    </section>
    <section className="surface p-4 md:p-5"><div className="mb-4 flex items-center gap-2"><Settings2 size={17} className="text-[hsl(var(--primary))]"/><h2 className="display m-0 text-lg font-extrabold">Grade scale</h2></div><p className="mb-4 text-xs text-[hsl(var(--muted-foreground))]">Minimum percentage required for each grade band.</p>
      {scaleLoading ? <div className="skeleton h-16 w-full"/> : scaleError ? <ErrorPanel error={scaleError} retry={retryScale}/> : <><div className="space-y-2">{shownBands.map((band, index) => <div key={`${index}-${band.grade}`} className="grid grid-cols-[1fr_130px_38px] items-end gap-2"><label className="text-[10px] font-bold">Grade<input className="field mt-1 min-h-10" maxLength={8} value={band.grade} onChange={event => setLocalBands(prev => (prev ?? bands).map((row, i) => i === index ? { ...row, grade: event.target.value } : row))}/></label><label className="text-[10px] font-bold">Minimum %<input className="field mt-1 min-h-10" type="number" min="0" max="100" value={band.minPercent} onChange={event => setLocalBands(prev => (prev ?? bands).map((row, i) => i === index ? { ...row, minPercent: Number(event.target.value) } : row))}/></label><button aria-label={`Remove grade band ${band.grade}`} className="btn btn-quiet min-h-10 px-2" disabled={shownBands.length <= 2} onClick={() => setLocalBands(prev => (prev ?? bands).filter((_, i) => i !== index))}><X size={15}/></button></div>)}</div><div className="mt-4 flex flex-wrap justify-between gap-2"><button disabled={shownBands.length >= 12} className="btn btn-muted btn-sm" onClick={() => setLocalBands([...(localBands ?? bands), { grade: '', minPercent: 0 }])}><Plus size={14}/>Add grade band</button><button disabled={saving || shownBands.length < 2 || shownBands.some(band => !band.grade.trim())} className="btn btn-primary btn-sm" onClick={() => onSaveScale(shownBands.map(band => ({ ...band, grade: band.grade.trim() })))}><Save size={14}/>{saving ? 'Saving…' : 'Save grade scale'}</button></div></>}
    </section>
  </div>;
}

function TermForm({ saving, onCancel, onSave }: { saving: boolean; onCancel: () => void; onSave: (data: { name: string; startsOn: string; endsOn: string; isCurrent: boolean }) => void }) {
  const [name, setName] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [isCurrent, setIsCurrent] = useState(false);
  return <form className="surface space-y-3 border-l-4 border-l-[hsl(var(--primary))] p-4" onSubmit={event => { event.preventDefault(); onSave({ name: name.trim(), startsOn, endsOn, isCurrent }); }}><div className="flex items-center justify-between"><h2 className="display m-0 text-lg font-extrabold">Add academic term</h2><button aria-label="Cancel term form" type="button" className="btn btn-quiet px-2" onClick={onCancel}><X size={18}/></button></div><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-bold">Term name<input required maxLength={100} className="field mt-1.5" value={name} onChange={event => setName(event.target.value)}/></label><label className="text-xs font-bold">Starts on<input required type="date" className="field mt-1.5" value={startsOn} onChange={event => setStartsOn(event.target.value)}/></label><label className="text-xs font-bold">Ends on<input required type="date" className="field mt-1.5" value={endsOn} onChange={event => setEndsOn(event.target.value)}/></label><label className="flex items-center gap-2 self-end pb-3 text-xs font-semibold"><input type="checkbox" checked={isCurrent} onChange={event => setIsCurrent(event.target.checked)}/>Set as current term</label></div><div className="flex justify-end gap-2"><button type="button" className="btn btn-muted" onClick={onCancel}>Cancel</button><button disabled={saving} className="btn btn-primary"><Save size={14}/>{saving ? 'Saving…' : 'Save term'}</button></div></form>;
}

function ErrorPanel({ error, retry }: { error: unknown; retry: () => void }) {
  return <div className="surface flex flex-col items-center p-7 text-center"><div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-[hsl(var(--destructive)/.1)] text-[hsl(var(--destructive))]"><X size={19}/></div><h2 className="display m-0 text-base font-extrabold">We couldn’t load this yet</h2><p role="alert" className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{errorMessage(error)}</p><button className="btn btn-muted btn-sm" onClick={retry}>Retry</button></div>;
}
function EmptyPanel({ title, text, icon }: { title: string; text: string; icon: React.ReactNode }) {
  return <div className="surface flex flex-col items-center p-9 text-center"><div className="mb-3 grid h-11 w-11 place-items-center rounded-2xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]">{icon}</div><h2 className="display m-0 text-base font-extrabold">{title}</h2><p className="mb-0 mt-2 max-w-sm text-xs leading-5 text-[hsl(var(--muted-foreground))]">{text}</p></div>;
}
