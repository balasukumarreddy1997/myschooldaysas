"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetStudentsQueryKey, useUpdateEnrollmentYear } from "@workspace/api-client-react";

export function EnrollmentYearField({
  enrollmentId,
  academicYear,
}: {
  enrollmentId: string;
  academicYear: string;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(academicYear);
  const update = useUpdateEnrollmentYear({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetStudentsQueryKey() }),
    },
  });

  useEffect(() => setDraft(academicYear), [academicYear]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = draft.trim();
    if (value.length < 4 || value.length > 24 || value === academicYear) return;
    update.mutate({ enrollmentId, data: { academicYear: value } });
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <input
        aria-label="Academic year"
        className="field min-h-9 w-28"
        value={draft}
        minLength={4}
        maxLength={24}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        className="btn btn-muted min-h-9 px-3 text-[11px]"
        disabled={draft.trim().length < 4 || draft.trim().length > 24 || draft.trim() === academicYear || update.isPending}
      >
        {update.isPending ? "Saving…" : "Save"}
      </button>
      {update.isError && <span role="alert" className="sr-only">{update.error.message}</span>}
    </form>
  );
}
