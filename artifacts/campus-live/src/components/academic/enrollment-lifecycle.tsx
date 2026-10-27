"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetSectionsQueryKey,
  getGetStudentsQueryKey,
  useCommitEnrollmentPromotion,
  useCommitEnrollmentTransfer,
  usePreviewEnrollmentPromotion,
  usePreviewEnrollmentTransfer,
} from "@workspace/api-client-react";
import type {
  ClassSummary,
  EnrollmentMovePreview,
  EnrollmentMoveResult,
  SectionSummary,
  StudentSummary,
} from "@workspace/api-client-react";
import { ArrowRightLeft, GraduationCap } from "lucide-react";

const message = (error: unknown) => error instanceof Error ? error.message : "The request could not be completed.";

export function EnrollmentLifecycle({
  sections,
  classes,
  students,
}: {
  sections: SectionSummary[];
  classes: ClassSummary[];
  students: StudentSummary[];
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"transfer" | "promotion">("transfer");
  const [studentId, setStudentId] = useState("");
  const [targetSectionId, setTargetSectionId] = useState("");
  const [targetYear, setTargetYear] = useState("");
  const [sourceYear, setSourceYear] = useState("");
  const [sourceClassId, setSourceClassId] = useState("");
  const [targetYearPromotion, setTargetYearPromotion] = useState("");
  const [sectionMap, setSectionMap] = useState<Record<string, string>>({});
  const [review, setReview] = useState<{ mode: "transfer" | "promotion"; body: any; result: EnrollmentMovePreview } | null>(null);
  const [outcome, setOutcome] = useState<EnrollmentMoveResult | null>(null);

  const selectedStudent = students.find((student) => student.id === studentId);
  const sourceSections = useMemo(
    () => sections.filter((section) => section.classId === sourceClassId),
    [sections, sourceClassId],
  );
  const sourceClass = classes.find((item) => item.id === sourceClassId);
  const validPromotionTargets = sections.filter((section) => {
    const destinationClass = classes.find((item) => item.id === section.classId);
    return !!destinationClass && !!sourceClass && destinationClass.gradeLevel > sourceClass.gradeLevel;
  });

  const refreshAcademicData = () => {
    queryClient.invalidateQueries({ queryKey: getGetStudentsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetSectionsQueryKey() });
  };
  const transferPreview = usePreviewEnrollmentTransfer({
    mutation: { onSuccess: (result, variables) => setReview({ mode: "transfer", body: variables.data, result }) },
  });
  const promotionPreview = usePreviewEnrollmentPromotion({
    mutation: { onSuccess: (result, variables) => setReview({ mode: "promotion", body: variables.data, result }) },
  });
  const transfer = useCommitEnrollmentTransfer({
    mutation: { onSuccess: (result) => { setOutcome(result); setReview(null); refreshAcademicData(); } },
  });
  const promotion = useCommitEnrollmentPromotion({
    mutation: { onSuccess: (result) => { setOutcome(result); setReview(null); refreshAcademicData(); } },
  });
  const pending = transferPreview.isPending || promotionPreview.isPending || transfer.isPending || promotion.isPending;
  const requestError = transferPreview.error || promotionPreview.error || transfer.error || promotion.error;

  function resetReview() {
    setReview(null);
    setOutcome(null);
    transferPreview.reset();
    promotionPreview.reset();
    transfer.reset();
    promotion.reset();
  }

  function previewTransfer() {
    if (!selectedStudent || !targetSectionId || !selectedStudent.academicYear || targetYear.trim().length < 4) return;
    setOutcome(null);
    transferPreview.mutate({
      data: {
        studentId: selectedStudent.id,
        sourceAcademicYear: selectedStudent.academicYear,
        targetSectionId,
        targetAcademicYear: targetYear.trim(),
      },
    });
  }

  function previewPromotion() {
    if (!sourceClassId || sourceYear.trim().length < 4 || targetYearPromotion.trim().length < 4 || !sourceSections.length) return;
    const mapping = sourceSections.map((section) => ({
      sourceSectionId: section.id,
      targetSectionId: sectionMap[section.id] ?? "",
    }));
    if (mapping.some((entry) => !entry.targetSectionId)) return;
    setOutcome(null);
    promotionPreview.mutate({
      data: {
        sourceClassId,
        sourceAcademicYear: sourceYear.trim(),
        targetAcademicYear: targetYearPromotion.trim(),
        sectionMap: mapping,
      },
    });
  }

  function confirmMove() {
    if (!review || !review.result.eligibleCount) return;
    if (review.mode === "transfer") transfer.mutate({ data: review.body });
    else promotion.mutate({ data: review.body });
  }

  return (
    <section className="surface mb-5 p-4" aria-labelledby="enrollment-lifecycle-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="enrollment-lifecycle-heading" className="m-0 text-sm font-bold">Transfer or promote students</h2>
          <p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">Review each move first. Previous enrollment records stay in the student history.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={`btn min-h-9 px-3 text-xs ${mode === "transfer" ? "btn-primary" : "btn-muted"}`} onClick={() => { setMode("transfer"); resetReview(); }}>
            <ArrowRightLeft size={14}/>Transfer one
          </button>
          <button type="button" className={`btn min-h-9 px-3 text-xs ${mode === "promotion" ? "btn-primary" : "btn-muted"}`} onClick={() => { setMode("promotion"); resetReview(); }}>
            <GraduationCap size={14}/>Promote class
          </button>
        </div>
      </div>

      {!review && mode === "transfer" && (
        <div className="mt-4 grid gap-3 border-t border-[hsl(var(--border))] pt-4 sm:grid-cols-2">
          <label className="text-xs font-semibold">Student in this roster
            <select className="field mt-1.5" value={studentId} onChange={(event) => {
              const selected = students.find((student) => student.id === event.target.value);
              setStudentId(event.target.value);
              setTargetYear(selected?.academicYear ?? "");
            }}>
              <option value="">Select student</option>
              {students.map((student) => <option key={student.id} value={student.id}>{student.name} · {student.academicYear}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold">Destination section
            <select className="field mt-1.5" value={targetSectionId} onChange={(event) => setTargetSectionId(event.target.value)}>
              <option value="">Select section</option>
              {sections.map((section) => <option key={section.id} value={section.id}>{section.className} · {section.name}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold sm:col-span-2">Destination academic year
            <input className="field mt-1.5" minLength={4} maxLength={24} value={targetYear} onChange={(event) => setTargetYear(event.target.value)} placeholder="e.g. 2026-27" />
          </label>
          <button type="button" className="btn btn-primary min-h-9 px-4 text-xs sm:col-span-2 sm:justify-self-end" disabled={!selectedStudent || !targetSectionId || targetYear.trim().length < 4 || pending} onClick={previewTransfer}>
            {transferPreview.isPending ? "Preparing review…" : "Review transfer"}
          </button>
        </div>
      )}

      {!review && mode === "promotion" && (
        <div className="mt-4 grid gap-3 border-t border-[hsl(var(--border))] pt-4 sm:grid-cols-2">
          <label className="text-xs font-semibold">Class to promote
            <select className="field mt-1.5" value={sourceClassId} onChange={(event) => { setSourceClassId(event.target.value); setSectionMap({}); }}>
              <option value="">Select source class</option>
              {classes.map((item) => <option key={item.id} value={item.id}>{item.name} · Grade {item.gradeLevel}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold">Current academic year
            <input className="field mt-1.5" minLength={4} maxLength={24} value={sourceYear} onChange={(event) => setSourceYear(event.target.value)} placeholder="e.g. 2025-26" />
          </label>
          <label className="text-xs font-semibold sm:col-span-2">Next academic year
            <input className="field mt-1.5" minLength={4} maxLength={24} value={targetYearPromotion} onChange={(event) => setTargetYearPromotion(event.target.value)} placeholder="e.g. 2026-27" />
          </label>
          {sourceSections.map((section) => (
            <label key={section.id} className="text-xs font-semibold">Move {section.name} to
              <select className="field mt-1.5" value={sectionMap[section.id] ?? ""} onChange={(event) => setSectionMap((current) => ({ ...current, [section.id]: event.target.value }))}>
                <option value="">Select next-grade section</option>
                {validPromotionTargets.map((target) => <option key={target.id} value={target.id}>{target.className} · {target.name}</option>)}
              </select>
            </label>
          ))}
          {!sourceSections.length && <p className="m-0 text-xs text-[hsl(var(--muted-foreground))] sm:col-span-2">Choose a class with sections to map its students.</p>}
          <button type="button" className="btn btn-primary min-h-9 px-4 text-xs sm:col-span-2 sm:justify-self-end" disabled={!sourceSections.length || sourceYear.trim().length < 4 || targetYearPromotion.trim().length < 4 || sourceSections.some((section) => !sectionMap[section.id]) || pending} onClick={previewPromotion}>
            {promotionPreview.isPending ? "Preparing review…" : "Review class promotion"}
          </button>
        </div>
      )}

      {requestError && <p role="alert" className="mb-0 mt-3 text-xs text-[hsl(var(--destructive))]">{message(requestError)}</p>}

      {review && (
        <div className="mt-4 border-t border-[hsl(var(--border))] pt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="m-0 text-xs font-bold">Review before saving</h3>
              <p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">{review.result.eligibleCount} ready · {review.result.conflictCount} conflict(s) · {review.result.total} student(s)</p>
            </div>
            <button type="button" className="btn btn-muted min-h-8 px-3 text-xs" disabled={pending} onClick={resetReview}>Edit move</button>
          </div>
          <div className="max-h-72 overflow-auto rounded-lg border border-[hsl(var(--border))]">
            <table className="w-full min-w-[620px] text-left text-xs">
              <thead className="bg-[hsl(var(--muted))] text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                <tr><th className="px-3 py-2">Student</th><th className="px-3 py-2">Current</th><th className="px-3 py-2">Destination</th><th className="px-3 py-2">Review</th></tr>
              </thead>
              <tbody>
                {review.result.items.map((item) => (
                  <tr key={`${item.studentId}:${item.sourceSectionId}`} className="border-t border-[hsl(var(--border))]">
                    <td className="px-3 py-2 font-semibold">{item.studentName}</td>
                    <td className="px-3 py-2">{item.sourceSectionName} · {item.sourceAcademicYear}</td>
                    <td className="px-3 py-2">{item.targetSectionName} · {item.targetAcademicYear}</td>
                    <td className={`px-3 py-2 ${item.eligible ? "text-[hsl(var(--primary))]" : "text-[hsl(var(--destructive))]"}`}>
                      {item.eligible ? "Ready" : item.conflicts.join(" ")}
                    </td>
                  </tr>
                ))}
                {!review.result.items.length && <tr><td className="px-3 py-3 text-[hsl(var(--muted-foreground))]" colSpan={4}>No active students were found for this class and year.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="m-0 text-xs text-[hsl(var(--muted-foreground))]">Only ready students will move. Conflicts are skipped and reported.</p>
            <button type="button" className="btn btn-primary min-h-9 px-4 text-xs" disabled={!review.result.eligibleCount || pending} onClick={confirmMove}>
              {pending ? "Saving…" : `Confirm ${review.result.eligibleCount} move${review.result.eligibleCount === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}

      {outcome && (
        <div className="mt-4 border-t border-[hsl(var(--border))] pt-4" role="status">
          <p className="m-0 text-xs font-bold">{outcome.succeeded} moved · {outcome.failed} failed</p>
          <ul className="mb-0 mt-2 space-y-1 pl-5 text-xs">
            {outcome.items.map((item) => <li key={item.studentId} className={item.succeeded ? "text-[hsl(var(--primary))]" : "text-[hsl(var(--destructive))]"}>{item.studentName}: {item.message}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
