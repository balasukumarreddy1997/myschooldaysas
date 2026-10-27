"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetStudentProfileQueryKey,
  useGetStudentProfile,
  useUpdateStudentProfile,
} from "@workspace/api-client-react";
import type { StudentProfileFields } from "@workspace/api-client-react";
import { Save, X } from "lucide-react";
import { StudentEnrollmentManager } from "./student-enrollment-manager";

const emptyProfile: StudentProfileFields = {
  dateOfBirth: null,
  gender: null,
  phone: null,
  address: null,
  bloodGroup: null,
  guardianName: null,
  guardianEmail: null,
  guardianPhone: null,
  guardianRelationship: null,
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Could not save the profile.";

export function StudentProfileEditor({
  studentId,
  onClose,
}: {
  studentId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const profileQuery = useGetStudentProfile(studentId, {
    query: { enabled: !!studentId },
  });
  const [draft, setDraft] = useState<StudentProfileFields>(emptyProfile);
  const [saved, setSaved] = useState(false);
  const update = useUpdateStudentProfile({
    mutation: {
      onSuccess: (result) => {
        setDraft(result.profile);
        setSaved(true);
        queryClient.setQueryData(getGetStudentProfileQueryKey(studentId), result);
      },
    },
  });

  useEffect(() => {
    if (profileQuery.data) {
      setDraft(profileQuery.data.profile);
      setSaved(false);
    }
  }, [profileQuery.data]);

  function setField<K extends keyof StudentProfileFields>(field: K, value: StudentProfileFields[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setSaved(false);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    update.mutate({ studentId, data: draft });
  }

  if (profileQuery.isLoading) {
    return <div className="surface mt-5 p-5 text-sm text-[hsl(var(--muted-foreground))]" role="status">Loading student profile…</div>;
  }
  if (profileQuery.isError || !profileQuery.data) {
    return <div className="surface mt-5 p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="m-0 text-sm text-[hsl(var(--destructive))]" role="alert">{errorMessage(profileQuery.error)}</p>
        <button type="button" className="btn btn-muted min-h-9 px-3" onClick={onClose} aria-label="Close student profile"><X size={16}/></button>
      </div>
    </div>;
  }

  const { data } = profileQuery;
  return (
    <section className="surface mt-5 p-4 md:p-5" aria-labelledby="student-profile-heading">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[hsl(var(--border))] pb-4">
        <div>
          <p className="mb-1 text-[10px] font-bold uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]">Student profile</p>
          <h2 id="student-profile-heading" className="display m-0 text-lg font-extrabold">{data.name}</h2>
          <p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">{data.email}</p>
          <p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">
            {data.currentEnrollment
              ? `${data.currentEnrollment.className} · ${data.currentEnrollment.sectionName} · ${data.currentEnrollment.admissionNo} · ${data.currentEnrollment.academicYear}`
              : "No active enrollment"}
          </p>
        </div>
        <button type="button" className="btn btn-muted min-h-9 px-3" onClick={onClose} aria-label="Close student profile"><X size={16}/><span className="ml-1">Close</span></button>
      </div>

      <div className="mt-4 border-b border-[hsl(var(--border))] pb-4">
        <h3 className="m-0 text-xs font-bold">Enrollment history</h3>
        {data.enrollmentHistory.length ? (
          <ul className="mb-0 mt-2 grid gap-2 sm:grid-cols-2">
            {data.enrollmentHistory.map((enrollment) => (
              <li key={enrollment.enrollmentId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[hsl(var(--background))] px-3 py-2 text-xs">
                <span className="font-semibold">{enrollment.className} · {enrollment.sectionName} · {enrollment.academicYear}</span>
                <span className="text-[hsl(var(--muted-foreground))]">{enrollment.admissionNo} · {enrollment.status}</span>
              </li>
            ))}
          </ul>
        ) : <p className="mb-0 mt-2 text-xs text-[hsl(var(--muted-foreground))]">No enrollment history.</p>}
      </div>

      <form onSubmit={submit} className="mt-4 grid gap-3 md:grid-cols-2">
        <h3 className="m-0 text-xs font-bold md:col-span-2">Student details</h3>
        <label className="text-xs font-semibold">Date of birth
          <input className="field mt-1.5" type="date" value={draft.dateOfBirth ?? ""} onChange={(event) => setField("dateOfBirth", event.target.value || null)} />
        </label>
        <label className="text-xs font-semibold">Gender
          <input className="field mt-1.5" maxLength={40} value={draft.gender ?? ""} onChange={(event) => setField("gender", event.target.value || null)} />
        </label>
        <label className="text-xs font-semibold">Student phone
          <input className="field mt-1.5" type="tel" maxLength={32} value={draft.phone ?? ""} onChange={(event) => setField("phone", event.target.value || null)} />
        </label>
        <label className="text-xs font-semibold">Blood group
          <input className="field mt-1.5" maxLength={8} value={draft.bloodGroup ?? ""} placeholder="e.g. O+" onChange={(event) => setField("bloodGroup", event.target.value || null)} />
        </label>
        <label className="text-xs font-semibold md:col-span-2">Address
          <textarea className="field mt-1.5 min-h-20" maxLength={500} value={draft.address ?? ""} onChange={(event) => setField("address", event.target.value || null)} />
        </label>

        <div className="mt-1 border-t border-[hsl(var(--border))] pt-3 md:col-span-2">
          <h3 className="m-0 text-xs font-bold">Guardian contact</h3>
          <p className="mb-3 mt-1 text-xs text-[hsl(var(--muted-foreground))]">These are contact details only; they do not create a guardian account or access link.</p>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-xs font-semibold">Guardian name
              <input className="field mt-1.5" maxLength={120} value={draft.guardianName ?? ""} onChange={(event) => setField("guardianName", event.target.value || null)} />
            </label>
            <label className="text-xs font-semibold">Relationship
              <input className="field mt-1.5" maxLength={40} value={draft.guardianRelationship ?? ""} onChange={(event) => setField("guardianRelationship", event.target.value || null)} />
            </label>
            <label className="text-xs font-semibold">Guardian email
              <input className="field mt-1.5" type="email" maxLength={254} value={draft.guardianEmail ?? ""} onChange={(event) => setField("guardianEmail", event.target.value || null)} />
            </label>
            <label className="text-xs font-semibold">Guardian phone
              <input className="field mt-1.5" type="tel" maxLength={32} value={draft.guardianPhone ?? ""} onChange={(event) => setField("guardianPhone", event.target.value || null)} />
            </label>
          </div>
        </div>

        {update.isError && <p role="alert" className="m-0 text-xs text-[hsl(var(--destructive))] md:col-span-2">{errorMessage(update.error)}</p>}
        {saved && <p role="status" className="m-0 text-xs text-[hsl(var(--primary))] md:col-span-2">Profile saved.</p>}
        <div className="flex justify-end md:col-span-2">
          <button className="btn btn-primary min-h-9 px-4" disabled={update.isPending}>
            <Save size={15}/>{update.isPending ? "Saving…" : "Save profile"}
          </button>
        </div>
      </form>
      <StudentEnrollmentManager studentId={studentId} currentEnrollment={data.currentEnrollment} />
    </section>
  );
}
