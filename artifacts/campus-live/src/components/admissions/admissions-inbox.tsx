"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAdmissionEnquiriesQueryKey,
  useGetAdmissionEnquiries,
  useUpdateAdmissionEnquiry,
} from "@workspace/api-client-react";
import type { AdmissionEnquiry, AdmissionEnquiryStatus, GetAdmissionEnquiriesParams } from "@workspace/api-client-react";
import { AlertCircle, CalendarDays, Check, ChevronRight, Clock3, Mail, MessageSquareText, Phone, RefreshCw, Search, UserRound } from "lucide-react";
import '../fees/school-work-pages.css';

const statuses: AdmissionEnquiryStatus[] = ["new", "contacted", "visit_scheduled", "application_issued", "closed", "lost"];
const statusLabel = (status: AdmissionEnquiryStatus) => status.replaceAll("_", " ");
const dateLabel = (value?: string | null) => value
  ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date(value))
  : "Not scheduled";
const dateTimeLabel = (value: string) =>
  new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please try again.";

export function AdmissionsInbox() {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<AdmissionEnquiryStatus | "all">("all");
  const [selectedId, setSelectedId] = useState("");
  const [editStatus, setEditStatus] = useState<AdmissionEnquiryStatus>("new");
  const [followUpOn, setFollowUpOn] = useState("");
  const [note, setNote] = useState("");
  const [saveNotice, setSaveNotice] = useState("");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const params = useMemo<GetAdmissionEnquiriesParams>(() => ({
    limit: 100,
    offset: 0,
    ...(status !== "all" ? { status } : {}),
    ...(search ? { search } : {}),
  }), [status, search]);
  const enquiries = useGetAdmissionEnquiries(params);
  const update = useUpdateAdmissionEnquiry();
  const items = enquiries.data?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? items[0];

  useEffect(() => {
    if (!selected) {
      setSelectedId("");
      return;
    }
    setSelectedId(selected.id);
    setEditStatus(selected.status);
    setFollowUpOn(selected.followUpOn?.slice(0, 10) ?? "");
    setNote("");
    setSaveNotice("");
    setSaveError("");
  }, [selected?.id]);

  function saveChanges() {
    if (!selected) return;
    setSaveNotice("");
    setSaveError("");
    update.mutate({
      enquiryId: selected.id,
      data: {
        status: editStatus,
        followUpOn: followUpOn || null,
        ...(note.trim() ? { note: note.trim() } : {}),
      },
    }, {
      onSuccess: async () => {
        setNote("");
        setSaveNotice("Changes saved.");
        await queryClient.invalidateQueries({ queryKey: getGetAdmissionEnquiriesQueryKey(params) });
      },
      onError: (error) => setSaveError(errorText(error)),
    });
  }

  const count = enquiries.data?.total ?? 0;

  return (
    <div className="admissions-page mx-auto max-w-[1500px] space-y-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[.2em] text-[hsl(var(--primary))]">Admissions workspace</p>
          <h1 className="display m-0 text-[32px] font-extrabold leading-tight tracking-[-.045em]">Enquiry inbox</h1>
          <p className="mb-0 mt-2 max-w-2xl text-sm text-[hsl(var(--muted-foreground))]">Keep every first conversation moving, with a clear owner for the next step.</p>
        </div>
        <div className="flex items-center gap-2 self-start rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3.5 py-2.5 text-xs">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-[hsl(var(--brand-mint))] text-[hsl(var(--brand-mint-ink))]"><UserRound size={15} /></span>
          <span><b className="block text-sm">{count}</b><span className="text-[hsl(var(--muted-foreground))]">total enquiries</span></span>
        </div>
      </header>

      <section className="surface overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-[hsl(var(--border))] p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
            <input className="field pl-9" type="search" aria-label="Search enquiries" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search child, guardian, phone or email" />
          </div>
          <label className="flex items-center gap-2 text-xs font-semibold text-[hsl(var(--muted-foreground))]">
            Status
            <select className="field min-w-[170px]" aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value as AdmissionEnquiryStatus | "all")}>
              <option value="all">All statuses</option>
              {statuses.map((item) => <option key={item} value={item}>{statusLabel(item)}</option>)}
            </select>
          </label>
        </div>

        {enquiries.isLoading ? <div className="grid min-h-[390px] md:grid-cols-[.82fr_1.18fr]">
          <div className="space-y-3 border-b border-[hsl(var(--border))] p-4 md:border-b-0 md:border-r">{[1, 2, 3, 4].map((row) => <div className="rounded-xl border border-[hsl(var(--border))] p-4" key={row}><div className="skeleton h-4 w-32" /><div className="skeleton mt-3 h-3 w-48" /><div className="skeleton mt-4 h-3 w-24" /></div>)}</div>
          <div className="hidden space-y-4 p-6 md:block"><div className="skeleton h-7 w-56" /><div className="skeleton h-20 w-full" /><div className="skeleton h-36 w-full" /></div>
        </div> : enquiries.isError ? <div className="flex min-h-[360px] flex-col items-center justify-center p-8 text-center">
          <span className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-[hsl(var(--destructive)/.08)] text-[hsl(var(--destructive))]"><AlertCircle size={22} /></span>
          <h2 className="display m-0 text-lg font-extrabold">Inbox unavailable</h2>
          <p className="mb-4 mt-2 max-w-sm text-sm text-[hsl(var(--muted-foreground))]">{errorText(enquiries.error)}</p>
          <button type="button" onClick={() => enquiries.refetch()} className="btn btn-muted"><RefreshCw size={15} />Try again</button>
        </div> : items.length === 0 ? <div className="flex min-h-[360px] flex-col items-center justify-center p-8 text-center">
          <span className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><MessageSquareText size={21} /></span>
          <h2 className="display m-0 text-lg font-extrabold">{search || status !== "all" ? "No matching enquiries" : "Your inbox is clear"}</h2>
          <p className="mb-0 mt-2 max-w-sm text-sm text-[hsl(var(--muted-foreground))]">{search || status !== "all" ? "Try changing your search or status filter." : "New family enquiries will appear here as soon as they arrive."}</p>
          {(searchInput || status !== "all") && <button type="button" className="btn btn-muted mt-4" onClick={() => { setSearchInput(""); setSearch(""); setStatus("all"); }}>Clear filters</button>}
        </div> : <div className="grid min-h-[570px] md:grid-cols-[.82fr_1.18fr]">
          <div className="max-h-[760px] overflow-y-auto border-b border-[hsl(var(--border))] md:border-b-0 md:border-r">
            <div className="flex items-center justify-between px-4 py-3 text-[10px] font-bold uppercase tracking-[.15em] text-[hsl(var(--muted-foreground))]">
              <span>Recent enquiries</span><span>{items.length} shown</span>
            </div>
            {items.map((item) => <EnquiryRow key={item.id} item={item} selected={selected?.id === item.id} onSelect={() => setSelectedId(item.id)} />)}
          </div>
          {selected && <EnquiryDetail
            item={selected}
            editStatus={editStatus}
            followUpOn={followUpOn}
            note={note}
            saving={update.isPending}
            saveNotice={saveNotice}
            saveError={saveError}
            onStatusChange={setEditStatus}
            onFollowUpChange={setFollowUpOn}
            onNoteChange={setNote}
            onSave={saveChanges}
          />}
        </div>}
      </section>
    </div>
  );
}

function EnquiryRow({ item, selected, onSelect }: { item: AdmissionEnquiry; selected: boolean; onSelect: () => void }) {
  return <button type="button" onClick={onSelect} aria-pressed={selected} className={`block w-full border-t border-[hsl(var(--border))] px-4 py-4 text-left transition-colors ${selected ? "bg-[hsl(var(--brand-mint)/.42)]" : "hover:bg-[hsl(var(--muted)/.55)]"}`}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-bold">{item.childName}</div>
        <div className="mt-1 truncate text-xs text-[hsl(var(--muted-foreground))]">{item.guardianName} <span aria-hidden="true">·</span> {item.classApplying}</div>
      </div>
      <ChevronRight size={16} className={`mt-1 shrink-0 ${selected ? "text-[hsl(var(--primary))]" : "text-[hsl(var(--muted-foreground))]"}`} />
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <StatusTag status={item.status} />
      <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{dateLabel(item.createdAt)}</span>
    </div>
    {item.followUpOn && <div className="mt-2 flex items-center gap-1.5 text-[10px] text-[hsl(var(--muted-foreground))]"><CalendarDays size={12} />Follow up {dateLabel(item.followUpOn)}</div>}
  </button>;
}

function EnquiryDetail({
  item, editStatus, followUpOn, note, saving, saveNotice, saveError,
  onStatusChange, onFollowUpChange, onNoteChange, onSave,
}: {
  item: AdmissionEnquiry;
  editStatus: AdmissionEnquiryStatus;
  followUpOn: string;
  note: string;
  saving: boolean;
  saveNotice: string;
  saveError: string;
  onStatusChange: (value: AdmissionEnquiryStatus) => void;
  onFollowUpChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onSave: () => void;
}) {
  return <article className="min-w-0 p-4 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[hsl(var(--border))] pb-5">
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-2"><StatusTag status={item.status} /><span className="text-[10px] capitalize text-[hsl(var(--muted-foreground))]">{item.source} enquiry</span></div>
        <h2 className="display m-0 text-2xl font-extrabold tracking-[-.035em]">{item.childName}</h2>
        <p className="mb-0 mt-1 text-sm text-[hsl(var(--muted-foreground))]">Applying for {item.classApplying}</p>
      </div>
      <div className="text-right text-[10px] leading-5 text-[hsl(var(--muted-foreground))]"><span className="block font-bold uppercase tracking-[.12em]">Received</span>{dateTimeLabel(item.createdAt)}</div>
    </div>

    <div className="grid gap-3 py-5 sm:grid-cols-2">
      <ContactCard icon={<UserRound size={15} />} label="Parent / guardian" value={item.guardianName} />
      <ContactCard icon={<Phone size={15} />} label="Phone" value={item.guardianPhone} href={`tel:${item.guardianPhone}`} />
      <ContactCard icon={<Mail size={15} />} label="Email" value={item.guardianEmail || "Not provided"} href={item.guardianEmail ? `mailto:${item.guardianEmail}` : undefined} />
      <ContactCard icon={<CalendarDays size={15} />} label="Child’s date of birth" value={item.dateOfBirth ? dateLabel(item.dateOfBirth) : "Not provided"} />
    </div>

    {item.notes && <div className="mb-5 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4">
      <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]"><MessageSquareText size={13} />Family note</div>
      <p className="m-0 whitespace-pre-wrap text-sm leading-6">{item.notes}</p>
    </div>}

    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4 sm:p-5">
      <div className="mb-4">
        <p className="mb-1 text-[10px] font-bold uppercase tracking-[.17em] text-[hsl(var(--primary))]">Keep it moving</p>
        <h3 className="display m-0 text-lg font-extrabold">Next step</h3>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold">Enquiry status
          <select className="field mt-1.5" value={editStatus} onChange={(event) => onStatusChange(event.target.value as AdmissionEnquiryStatus)}>
            {statuses.map((status) => <option value={status} key={status}>{statusLabel(status)}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold">Follow-up date <span className="font-normal text-[hsl(var(--muted-foreground))]">Optional</span>
          <input type="date" className="field mt-1.5" value={followUpOn} onChange={(event) => onFollowUpChange(event.target.value)} />
        </label>
      </div>
      <label className="mt-3 block text-xs font-semibold">Add a note <span className="font-normal text-[hsl(var(--muted-foreground))]">Optional</span>
        <textarea className="field mt-1.5 min-h-[76px] resize-y" maxLength={1000} value={note} onChange={(event) => onNoteChange(event.target.value)} placeholder="Record the conversation or the agreed next step…" />
      </label>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={saving} onClick={onSave}>{saving ? <><Clock3 size={15} />Saving…</> : <><Check size={15} />Save update</>}</button>
        {saveNotice && <span role="status" className="text-xs font-semibold text-[hsl(var(--brand-mint-ink))]">{saveNotice}</span>}
        {saveError && <span role="alert" className="text-xs text-[hsl(var(--destructive))]">{saveError}</span>}
      </div>
    </div>

    <section className="mt-6">
      <div className="mb-4 flex items-center justify-between">
        <div><p className="mb-1 text-[10px] font-bold uppercase tracking-[.17em] text-[hsl(var(--muted-foreground))]">A connected follow-up</p><h3 className="display m-0 text-base font-extrabold">Activity</h3></div>
        <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{item.activity.length} updates</span>
      </div>
      {item.activity.length ? <ol className="m-0 list-none space-y-0 p-0">
        {item.activity.map((activity, index) => <li key={activity.id} className="relative flex gap-3 pb-4 last:pb-0">
          <span className="relative mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]">{index === 0 ? <Check size={11} /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}{index < item.activity.length - 1 && <span className="absolute left-1/2 top-5 h-full w-px -translate-x-1/2 bg-[hsl(var(--border))]" />}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-1"><span className="text-xs font-bold">{activityLabel(activity.action, activity.previousStatus, activity.nextStatus, activity.previousFollowUpOn, activity.nextFollowUpOn)}</span><time className="text-[10px] text-[hsl(var(--muted-foreground))]">{dateTimeLabel(activity.createdAt)}</time></div>
            {activity.note && <p className="mb-0 mt-1 whitespace-pre-wrap text-xs leading-5 text-[hsl(var(--muted-foreground))]">{activity.note}</p>}
            {activity.actorName && <p className="mb-0 mt-1 text-[10px] text-[hsl(var(--muted-foreground))]">{activity.actorName}</p>}
          </div>
        </li>)}
      </ol> : <p className="text-xs text-[hsl(var(--muted-foreground))]">No activity recorded yet.</p>}
    </section>
  </article>;
}

function ContactCard({ icon, label, value, href }: { icon: React.ReactNode; label: string; value: string; href?: string }) {
  return <div className="flex min-w-0 gap-3 rounded-xl border border-[hsl(var(--border))] p-3">
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]">{icon}</span>
    <div className="min-w-0"><div className="text-[10px] font-semibold text-[hsl(var(--muted-foreground))]">{label}</div>{href ? <a className="mt-1 block truncate text-xs font-bold text-[hsl(var(--primary))] hover:underline" href={href}>{value}</a> : <div className="mt-1 truncate text-xs font-bold">{value}</div>}</div>
  </div>;
}

function StatusTag({ status }: { status: AdmissionEnquiryStatus }) {
  const tone = status === "new" ? "bg-[hsl(var(--brand-accent)/.18)] text-[hsl(var(--foreground))]"
    : status === "contacted" || status === "visit_scheduled" ? "bg-[hsl(var(--brand-mint))] text-[hsl(var(--brand-mint-ink))]"
      : status === "application_issued" ? "bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]"
        : "bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]";
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold capitalize ${tone}`}>{statusLabel(status)}</span>;
}

function activityLabel(action: string, previousStatus: AdmissionEnquiryStatus | null, nextStatus: AdmissionEnquiryStatus | null, previousFollowUpOn: string | null, nextFollowUpOn: string | null) {
  if (action === "submitted") return "Enquiry received";
  if (action === "status_changed") return `Status changed${previousStatus && nextStatus ? ` · ${statusLabel(previousStatus)} to ${statusLabel(nextStatus)}` : ""}`;
  if (action === "follow_up_changed") return `Follow-up date updated${previousFollowUpOn || nextFollowUpOn ? ` · ${previousFollowUpOn ? dateLabel(previousFollowUpOn) : "none"} to ${nextFollowUpOn ? dateLabel(nextFollowUpOn) : "none"}` : ""}`;
  if (action === "note_added") return "Note added";
  return action.replaceAll("_", " ");
}
