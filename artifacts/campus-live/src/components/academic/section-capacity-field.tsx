"use client";

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetSectionsQueryKey, useUpdateSection } from "@workspace/api-client-react";

export function SectionCapacityField({
  sectionId,
  sectionName,
  capacity,
}: {
  sectionId: string;
  sectionName: string;
  capacity: number | null;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(capacity === null ? "" : String(capacity));
  const update = useUpdateSection({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetSectionsQueryKey() }),
    },
  });
  const value = draft.trim() === "" ? null : Number(draft);
  const valid = value === null || (Number.isInteger(value) && value > 0);
  const changed = value !== capacity;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || !changed) return;
    update.mutate({ sectionId, data: { capacity: value } });
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <label className="text-[10px] font-semibold text-[hsl(var(--muted-foreground))]">
        Section capacity
        <input
          aria-label={`Capacity for ${sectionName}`}
          className="field mt-1 min-h-9 w-28"
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          placeholder="No limit"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <button className="btn btn-muted min-h-9 px-3 text-[11px]" disabled={!valid || !changed || update.isPending}>
        {update.isPending ? "Saving…" : "Save"}
      </button>
      {update.isError && <span role="alert" className="basis-full text-[11px] text-[hsl(var(--destructive))]">{update.error.message}</span>}
    </form>
  );
}
