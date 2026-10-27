"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetSectionsQueryKey,
  getGetStudentEnrollmentHistoryQueryKey,
  getGetStudentProfileQueryKey,
  getGetStudentsQueryKey,
  useGetSections,
  useGetStudentEnrollmentHistory,
  useTransferStudentEnrollment,
} from "@workspace/api-client-react";
import { ArrowRightLeft } from "lucide-react";

type CurrentEnrollment = {
  enrollmentId: string;
  sectionId: string;
  className: string;
  sectionName: string;
  academicYear: string;
};

const readableError = (error: unknown) => error instanceof Error ? error.message : "Unable to update the enrollment.";

export function StudentEnrollmentManager({
  studentId,
  currentEnrollment,
}: {
  studentId: string;
  currentEnrollment: CurrentEnrollment | null;
}) {
  const queryClient = useQueryClient();
  const sections = useGetSections();
  const history = useGetStudentEnrollmentHistory(studentId);
  const [targetSectionId, setTargetSectionId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");

  useEffect(() => {
    const destinations = (sections.data?.items ?? []).filter((section) => section.id !== currentEnrollment?.sectionId);
    if (!destinations.some((section) => section.id === targetSectionId)) {
      setTargetSectionId(destinations[0]?.id ?? "");
    }
  }, [sections.data, currentEnrollment?.sectionId, targetSectionId]);

  const transfer = useTransferStudentEnrollment({
    mutation: {
      onSuccess: (result) => {
        setConfirmed(false);
        setSuccessMessage(`Moved to ${result.sectionName}. The previous enrollment remains in history.`);
        queryClient.invalidateQueries({ queryKey: getGetStudentProfileQueryKey(studentId) });
        queryClient.invalidateQueries({ queryKey: getGetStudentEnrollmentHistoryQueryKey(studentId) });
        queryClient.invalidateQueries({ queryKey: getGetStudentsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetSectionsQueryKey() });
      },
    },
  });

  function submitTransfer() {
    if (!currentEnrollment || !targetSectionId || !confirmed) return;
    setSuccessMessage("");
    transfer.mutate({
      data: {
        enrollmentId: currentEnrollment.enrollmentId,
        targetSectionId,
      },
    });
  }

  const selectedTarget = sections.data?.items.find((section) => section.id === targetSectionId);

  return (
    <section className="mt-5 border-t border-[hsl(var(--border))] pt-4" aria-labelledby="student-enrollment-history-heading">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]">
          <ArrowRightLeft size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 id="student-enrollment-history-heading" className="m-0 text-sm font-bold">Enrollment history</h3>
          <p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">
            Previous class and section records stay available when a student moves.
          </p>
        </div>
      </div>

      {currentEnrollment && (
        <div className="mt-4 grid gap-3 rounded-lg bg-[hsl(var(--background))] p-3 md:grid-cols-[1fr_auto] md:items-end">
          <label className="text-xs font-semibold">Transfer to section
            <select
              className="field mt-1.5"
              value={targetSectionId}
              onChange={(event) => {
                setTargetSectionId(event.target.value);
                setConfirmed(false);
                setSuccessMessage("");
              }}
              disabled={sections.isLoading || (sections.data?.items.length ?? 0) < 2 || transfer.isPending}
            >
              <option value="">Select a destination</option>
              {sections.data?.items
                .filter((section) => section.id !== currentEnrollment.sectionId)
                .map((section) => (
                  <option key={section.id} value={section.id}>{section.className} · {section.name}</option>
                ))}
            </select>
            {selectedTarget && <span className="mt-1 block font-normal text-[hsl(var(--muted-foreground))]">
              {selectedTarget.studentCount} active · {selectedTarget.capacity == null ? "no capacity limit" : `capacity ${selectedTarget.capacity}`}
            </span>}
          </label>
          <button
            type="button"
            className="btn btn-muted min-h-9 px-3 text-xs"
            onClick={submitTransfer}
            disabled={!confirmed || !targetSectionId || transfer.isPending}
          >
            {transfer.isPending ? "Moving…" : "Transfer student"}
          </button>
          <label className="flex items-start gap-2 text-xs font-normal text-[hsl(var(--muted-foreground))] md:col-span-2">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={transfer.isPending}
            />
            <span>Confirm this move. The current enrollment will close and a new enrollment will be created.</span>
          </label>
        </div>
      )}

      {sections.isError && <p role="alert" className="mt-2 text-xs text-[hsl(var(--destructive))]">{readableError(sections.error)}</p>}
      {transfer.isError && <p role="alert" className="mt-2 text-xs text-[hsl(var(--destructive))]">{readableError(transfer.error)}</p>}
      {history.isError && <p role="alert" className="mt-2 text-xs text-[hsl(var(--destructive))]">{readableError(history.error)}</p>}
      {successMessage && <p role="status" className="mt-2 text-xs text-[hsl(var(--primary))]">{successMessage}</p>}
      {!currentEnrollment && <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">This student has no active enrollment to transfer.</p>}

      {history.data && (
        <div className="mt-4 overflow-x-auto rounded-lg border border-[hsl(var(--border))]">
          <table className="w-full min-w-[560px] text-left text-xs">
            <thead className="bg-[hsl(var(--muted))] text-[10px] uppercase tracking-[.1em] text-[hsl(var(--muted-foreground))]">
              <tr>
                <th className="px-3 py-2">Academic year</th>
                <th className="px-3 py-2">Class · section</th>
                <th className="px-3 py-2">Admission no.</th>
                <th className="px-3 py-2">Record</th>
              </tr>
            </thead>
            <tbody>
              {history.data.items.map((item) => (
                <tr key={item.id} className="border-t border-[hsl(var(--border))]">
                  <td className="px-3 py-2">{item.academicYear}</td>
                  <td className="px-3 py-2">{item.className} · {item.sectionName}</td>
                  <td className="px-3 py-2">{item.admissionNo}</td>
                  <td className="px-3 py-2">
                    {item.endedReason ? item.endedReason === "transferred" ? "Transferred" : "Promoted" : item.status === "active" ? "Current" : "Inactive"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!history.data.items.length && <p className="px-3 py-4 text-xs text-[hsl(var(--muted-foreground))]">No enrollment records found.</p>}
        </div>
      )}
    </section>
  );
}
