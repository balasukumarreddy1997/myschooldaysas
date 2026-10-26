"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAvailableStudentsQueryKey,
  getGetSectionsQueryKey,
  getGetStudentsQueryKey,
  useCreateEnrollment,
  useGetAvailableStudents,
} from "@workspace/api-client-react";
import type { SectionSummary } from "@workspace/api-client-react";
import { Plus, X } from "lucide-react";

const readableError = (error: unknown) => error instanceof Error ? error.message : "Unable to enroll this student.";

export function EnrollmentForm({ sections }: { sections: SectionSummary[] }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [sectionId, setSectionId] = useState(sections[0]?.id ?? "");
  const [academicYear, setAcademicYear] = useState("");
  const [search, setSearch] = useState("");
  const [studentId, setStudentId] = useState("");
  const [admissionNo, setAdmissionNo] = useState("");
  const year = academicYear.trim();
  const effectiveSectionId = sectionId || sections[0]?.id || "";
  const params = useMemo(
    () => ({ academicYear: year, q: search.trim() || undefined, limit: 50, offset: 0 }),
    [year, search],
  );
  const available = useGetAvailableStudents(params, { query: { enabled: open && year.length >= 4 } });
  const create = useCreateEnrollment({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetStudentsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetSectionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAvailableStudentsQueryKey() });
        setStudentId("");
        setAdmissionNo("");
        setSearch("");
        setOpen(false);
      },
    },
  });
  const selectedSection = sections.find((section) => section.id === effectiveSectionId);
  const isFull = selectedSection?.capacity != null && selectedSection.studentCount >= selectedSection.capacity;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!studentId || !effectiveSectionId || year.length < 4 || !admissionNo.trim() || isFull) return;
    create.mutate({
      data: {
        studentId,
        sectionId: effectiveSectionId,
        admissionNo: admissionNo.trim(),
        academicYear: year,
      },
    });
  }

  return (
    <section className="surface mb-5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-sm font-bold">Enroll a student</h2>
          <p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">Choose an existing student account and section. The server checks capacity before saving.</p>
        </div>
        <button className="btn btn-primary min-h-9 px-3 text-xs" type="button" onClick={() => setOpen((value) => !value)}>
          {open ? <X size={15} /> : <Plus size={15} />}
          {open ? "Close" : "Enroll student"}
        </button>
      </div>

      {open && (
        <form className="mt-4 grid gap-3 border-t border-[hsl(var(--border))] pt-4 md:grid-cols-2" onSubmit={submit}>
          <label className="text-xs font-semibold">Section
            <select className="field mt-1.5" required value={effectiveSectionId} onChange={(event) => setSectionId(event.target.value)}>
              <option value="" disabled>Select section</option>
              {sections.map((section) => (
                <option key={section.id} value={section.id}>{section.className} · {section.name}</option>
              ))}
            </select>
            {selectedSection && <span className="mt-1 block font-normal text-[hsl(var(--muted-foreground))]">
              {selectedSection.studentCount} active enrollment(s) · {selectedSection.capacity == null ? "no capacity limit set" : `capacity ${selectedSection.capacity}`}
            </span>}
          </label>

          <label className="text-xs font-semibold">Academic year
            <input className="field mt-1.5" required minLength={4} maxLength={24} value={academicYear} onChange={(event) => { setAcademicYear(event.target.value); setStudentId(""); }} placeholder="e.g. 2026-27" />
          </label>

          <label className="text-xs font-semibold">Find student
            <input className="field mt-1.5" value={search} onChange={(event) => { setSearch(event.target.value); setStudentId(""); }} placeholder={year.length >= 4 ? "Search by student name or email" : "Enter an academic year first"} disabled={year.length < 4} />
          </label>

          <label className="text-xs font-semibold">Student
            <select className="field mt-1.5" required value={studentId} onChange={(event) => setStudentId(event.target.value)} disabled={year.length < 4 || available.isLoading}>
              <option value="">{year.length < 4 ? "Enter an academic year first" : available.isLoading ? "Loading students…" : "Select student"}</option>
              {available.data?.items.map((student) => <option key={student.id} value={student.id}>{student.name} · {student.email}</option>)}
            </select>
            {available.isError && <span role="alert" className="mt-1 block font-normal text-[hsl(var(--destructive))]">{readableError(available.error)}</span>}
            {year.length >= 4 && !available.isLoading && !available.isError && !available.data?.items.length && <span className="mt-1 block font-normal text-[hsl(var(--muted-foreground))]">No available students match this year and search.</span>}
          </label>

          <label className="text-xs font-semibold md:col-span-2">Admission number
            <input className="field mt-1.5" required maxLength={40} value={admissionNo} onChange={(event) => setAdmissionNo(event.target.value)} placeholder="Enter a unique admission number" />
          </label>

          {isFull && <div role="alert" className="rounded-lg bg-[hsl(var(--destructive)/.08)] px-3 py-2 text-xs text-[hsl(var(--destructive))] md:col-span-2">This section is at capacity. Increase its capacity or choose another section.</div>}
          {create.isError && <div role="alert" className="text-xs text-[hsl(var(--destructive))] md:col-span-2">{readableError(create.error)}</div>}
          <div className="flex justify-end md:col-span-2">
            <button className="btn btn-primary min-h-9 px-4 text-xs" disabled={!studentId || !effectiveSectionId || year.length < 4 || !admissionNo.trim() || isFull || create.isPending}>
              {create.isPending ? "Enrolling…" : "Save enrollment"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
