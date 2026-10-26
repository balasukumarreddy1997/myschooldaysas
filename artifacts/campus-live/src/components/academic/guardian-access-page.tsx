"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetGuardianLinksQueryKey,
  useGetGuardianLinks,
  useUpdateGuardianLinkFlags,
} from "@workspace/api-client-react";
import type { GuardianLink } from "@workspace/api-client-react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";

const pageSize = 50;
const readableError = (error: unknown) => error instanceof Error ? error.message : "Something went wrong.";

export function GuardianAccessPage() {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const params = useMemo(
    () => ({ limit: pageSize, offset: page * pageSize, q: search.trim() || undefined }),
    [page, search],
  );
  const links = useGetGuardianLinks(params);

  return (
    <div>
      <header className="mb-7">
        <div className="mb-2 text-[10px] font-bold uppercase tracking-[.2em] text-[hsl(var(--primary))]">Family access</div>
        <h1 className="display m-0 text-[30px] font-extrabold leading-tight tracking-[-.045em] md:text-[36px]">Guardian permissions</h1>
        <p className="mb-0 mt-2 max-w-2xl text-[13px] text-[hsl(var(--muted-foreground))]">Manage whether linked guardians can view live classes or pay fees for each student.</p>
      </header>

      <label className="field mb-4 flex items-center gap-2">
        <Search size={15} className="shrink-0 text-[hsl(var(--muted-foreground))]" />
        <span className="sr-only">Search students and guardians</span>
        <input
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          value={search}
          maxLength={120}
          placeholder="Search student, guardian, or email"
          onChange={(event) => { setPage(0); setSearch(event.target.value); }}
        />
      </label>

      {links.isLoading ? (
        <div className="skeleton h-40" aria-label="Loading guardian permissions" />
      ) : links.isError ? (
        <div className="surface p-5 text-sm text-[hsl(var(--destructive))]" role="alert">{readableError(links.error)}</div>
      ) : !links.data?.items.length ? (
        <div className="surface p-8 text-center text-sm text-[hsl(var(--muted-foreground))]">No guardian links match this search.</div>
      ) : (
        <div className="surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left">
              <thead className="bg-[hsl(var(--muted))] text-[10px] uppercase tracking-[.12em] text-[hsl(var(--muted-foreground))]">
                <tr>
                  <th className="px-4 py-3">Student</th>
                  <th className="px-4 py-3">Guardian</th>
                  <th className="px-4 py-3">Relationship</th>
                  <th className="px-4 py-3">Live view</th>
                  <th className="px-4 py-3">Fee payment</th>
                </tr>
              </thead>
              <tbody>
                {links.data.items.map((link) => <GuardianAccessRow key={`${link.studentId}:${link.guardianId}`} link={link} />)}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-[hsl(var(--border))] p-3">
            <span className="text-xs text-[hsl(var(--muted-foreground))]">
              {links.data.total === 0 ? 0 : page * pageSize + 1}–{Math.min((page + 1) * pageSize, links.data.total)} of {links.data.total}
            </span>
            <div className="flex gap-2">
              <button className="btn btn-muted min-h-8 px-2" disabled={page === 0} onClick={() => setPage((current) => current - 1)} aria-label="Previous guardian links"><ChevronLeft size={16} /></button>
              <button className="btn btn-muted min-h-8 px-2" disabled={(page + 1) * pageSize >= links.data.total} onClick={() => setPage((current) => current + 1)} aria-label="Next guardian links"><ChevronRight size={16} /></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GuardianAccessRow({ link }: { link: GuardianLink }) {
  const queryClient = useQueryClient();
  const update = useUpdateGuardianLinkFlags({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetGuardianLinksQueryKey() }),
    },
  });

  function setFlag(flag: "canViewLive" | "canPayFees", value: boolean) {
    update.mutate({
      studentId: link.studentId,
      guardianId: link.guardianId,
      data: {
        canViewLive: flag === "canViewLive" ? value : link.canViewLive,
        canPayFees: flag === "canPayFees" ? value : link.canPayFees,
      },
    });
  }

  return (
    <tr className="border-t border-[hsl(var(--border))]">
      <td className="px-4 py-3"><div className="text-xs font-semibold">{link.studentName}</div></td>
      <td className="px-4 py-3"><div className="text-xs font-semibold">{link.guardianName}</div><div className="mt-1 text-[10px] text-[hsl(var(--muted-foreground))]">{link.guardianEmail}</div></td>
      <td className="px-4 py-3 text-xs capitalize">{link.relationship.replaceAll("_", " ")}</td>
      <td className="px-4 py-3"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={link.canViewLive} disabled={update.isPending} onChange={(event) => setFlag("canViewLive", event.target.checked)} />Allowed</label></td>
      <td className="px-4 py-3"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={link.canPayFees} disabled={update.isPending} onChange={(event) => setFlag("canPayFees", event.target.checked)} />Allowed</label>{update.isError && <div role="alert" className="mt-1 text-[10px] text-[hsl(var(--destructive))]">{readableError(update.error)}</div>}</td>
    </tr>
  );
}
