"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAnnouncementStatsQueryKey,
  getGetAnnouncementsQueryKey,
  getGetSectionsQueryKey,
  useCreateAnnouncement,
  useGetAnnouncementStats,
  useGetAnnouncements,
  useGetClasses,
  useGetSections,
  useMarkAnnouncementRead,
} from "@workspace/api-client-react";
import type { Announcement, AnnouncementInput, AnnouncementRole, AnnouncementStats } from "@workspace/api-client-react";
import {
  AlertCircle,
  Bell,
  Check,
  ChevronDown,
  Clock3,
  Megaphone,
  Plus,
  Radio,
  Send,
  ShieldAlert,
  Users,
} from "lucide-react";

type Props = { roles: string[]; userId?: string };

const staffRoles = ["super_admin", "org_admin", "campus_admin", "hod", "teacher", "class_teacher"];
const adminRoles = ["super_admin", "org_admin", "campus_admin"];
const audienceRoles: AnnouncementRole[] = ["student", "parent", "teacher", "class_teacher", "hod", "campus_admin", "org_admin", "super_admin"];
const readableRole = (role: string) => role.replaceAll("_", " ");
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Please try again.";
const dateTime = (value?: string | null) => {
  if (!value) return "Not set";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not set" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
};
const isForbidden = (error: unknown) => {
  const candidate = error as { status?: number; response?: { status?: number } } | null;
  return candidate?.status === 403 || candidate?.response?.status === 403;
};

export function AnnouncementsPage({ roles, userId }: Props) {
  const queryClient = useQueryClient();
  const canPublish = roles.some((role) => staffRoles.includes(role));
  const isAdmin = roles.some((role) => adminRoles.includes(role));
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [operationError, setOperationError] = useState("");

  const params = useMemo(() => unreadOnly ? { unread: true } : undefined, [unreadOnly]);
  const feed = useGetAnnouncements(params, { query: { queryKey: getGetAnnouncementsQueryKey(params) } });
  const classes = useGetClasses({ query: { enabled: canPublish } });
  const [classId, setClassId] = useState("");
  const sectionsParams = useMemo(() => classId ? { classId } : undefined, [classId]);
  const sections = useGetSections(sectionsParams, { query: { enabled: canPublish, queryKey: getGetSectionsQueryKey(sectionsParams) } });

  const createAnnouncement = useCreateAnnouncement();
  const markRead = useMarkAnnouncementRead();
  const items = feed.data?.items ?? [];
  const unreadCount = items.filter((announcement) => !announcement.readAt).length;

  function onPublish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    setOperationError("");
    const form = new FormData(event.currentTarget);
    const audience = String(form.get("audience")) as AnnouncementInput["audience"];
    const targetId = String(form.get("targetId") ?? "");
    const rolesSelected = form.getAll("roles").map(String) as AnnouncementRole[];
    const input: AnnouncementInput = {
      title: String(form.get("title") ?? "").trim(),
      body: String(form.get("body") ?? "").trim(),
      audience,
      priority: form.get("priority") === "urgent" ? "urgent" : "normal",
      ...(audience === "class" || audience === "section" ? { audienceId: targetId } : {}),
      ...(audience === "role" ? { roles: rolesSelected } : {}),
      ...(form.get("expiresAt") ? { expiresAt: new Date(String(form.get("expiresAt"))).toISOString() } : {}),
    };
    createAnnouncement.mutate({ data: input }, {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getGetAnnouncementsQueryKey() });
        setComposerOpen(false);
        setNotice("Announcement published to its selected audience.");
      },
      onError: (error) => setOperationError(errorMessage(error)),
    });
  }

  function onMarkRead(announcement: Announcement) {
    setOperationError("");
    markRead.mutate({ announcementId: announcement.id }, {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getGetAnnouncementsQueryKey() });
      },
      onError: (error) => setOperationError(errorMessage(error)),
    });
  }

  return <div className="space-y-6">
    <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
      <div>
        <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.2em] text-[hsl(var(--primary))]"><span className="h-px w-7 bg-[hsl(var(--accent))]" />School community</div>
        <h1 className="display m-0 text-[32px] font-extrabold leading-tight tracking-[-.045em] md:text-[38px]">Announcements</h1>
        <p className="mb-0 mt-2 max-w-2xl text-[13px] text-[hsl(var(--muted-foreground))]">Important updates, shared with the people who need them.</p>
      </div>
      {canPublish && <button type="button" className="btn btn-primary self-start sm:self-auto" onClick={() => { setComposerOpen((open) => !open); setNotice(""); }} aria-expanded={composerOpen}>
        {composerOpen ? <ChevronDown size={16} /> : <Plus size={16} />}{composerOpen ? "Close composer" : "New announcement"}
      </button>}
    </header>

    {notice && <div role="status" className="flex items-center gap-2 rounded-xl border border-[hsl(var(--status-good)/.3)] bg-[hsl(var(--status-good-bg))] px-4 py-3 text-sm font-semibold text-[hsl(var(--brand-mint-ink))]"><Check size={16} />{notice}</div>}
    {operationError && <div role="alert" className="flex items-start gap-2 rounded-xl border border-[hsl(var(--destructive)/.25)] bg-[hsl(var(--destructive)/.07)] px-4 py-3 text-sm text-[hsl(var(--destructive))]"><AlertCircle className="mt-0.5 shrink-0" size={16} />{operationError}</div>}

    {composerOpen && canPublish && <ComposeForm
      roles={roles}
      isAdmin={isAdmin}
      classes={classes.data?.items ?? []}
      sections={sections.data?.items ?? []}
      classId={classId}
      onClassChange={setClassId}
      classLoading={classes.isLoading}
      sectionLoading={sections.isLoading}
      loadingError={classes.isError || sections.isError ? errorMessage(classes.error || sections.error) : ""}
      onRetry={() => { classes.refetch(); sections.refetch(); }}
      pending={createAnnouncement.isPending}
      onSubmit={onPublish}
    />}

    <section className="surface overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><Bell size={18} /></span>
          <div><h2 className="display m-0 text-base font-extrabold">Your school feed</h2><p className="mb-0 mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">{feed.data?.total ?? "—"} updates · {unreadCount} unread shown</p></div>
        </div>
        <label className="flex min-h-10 cursor-pointer items-center gap-2 self-start rounded-lg border border-[hsl(var(--border))] px-3 text-xs font-semibold sm:self-auto">
          <input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} className="h-4 w-4 accent-[hsl(var(--primary))]" />
          Show unread only
        </label>
      </div>

      {feed.isLoading ? <div aria-label="Loading announcements" className="space-y-3 p-4 sm:p-5">{[1, 2, 3].map((item) => <div key={item} className="rounded-xl border border-[hsl(var(--border))] p-4"><div className="skeleton h-4 w-2/5" /><div className="skeleton mt-3 h-3 w-full" /><div className="skeleton mt-2 h-3 w-4/5" /><div className="skeleton mt-4 h-3 w-1/4" /></div>)}</div>
        : feed.isError ? <div className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
          <span className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-[hsl(var(--destructive)/.08)] text-[hsl(var(--destructive))]"><AlertCircle size={20} /></span><h3 className="display m-0 text-lg font-extrabold">Feed unavailable</h3><p className="mb-4 mt-2 max-w-sm text-sm text-[hsl(var(--muted-foreground))]">{errorMessage(feed.error)}</p><button className="btn btn-muted" onClick={() => feed.refetch()}>Try again</button>
        </div>
          : !items.length ? <div className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
            <span className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><Megaphone size={21} /></span>
            <h3 className="display m-0 text-lg font-extrabold">{unreadOnly ? "You’re all caught up" : "A quiet moment"}</h3>
            <p className="mb-0 mt-2 max-w-sm text-sm leading-6 text-[hsl(var(--muted-foreground))]">{unreadOnly ? "There are no unread announcements right now." : "Announcements shared with your account will appear here."}</p>
            {unreadOnly && <button className="btn btn-muted mt-4" onClick={() => setUnreadOnly(false)}>View all updates</button>}
          </div>
            : <div className="divide-y divide-[hsl(var(--border))]">{items.map((item) => <AnnouncementCard key={item.id} announcement={item} canViewStats={isAdmin || (!!userId && item.createdBy === userId)} onRead={() => onMarkRead(item)} readPending={markRead.isPending && markRead.variables?.announcementId === item.id} />)}</div>}
    </section>
  </div>;
}

function ComposeForm({
  roles, isAdmin, classes, sections, classId, onClassChange, classLoading, sectionLoading, loadingError, onRetry, pending, onSubmit,
}: {
  roles: string[]; isAdmin: boolean;
  classes: { id: string; name: string }[];
  sections: { id: string; name: string; classId: string; className: string }[];
  classId: string; onClassChange: (id: string) => void;
  classLoading: boolean; sectionLoading: boolean; loadingError: string; onRetry: () => void;
  pending: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const canTargetBroadly = isAdmin;
  const [audience, setAudience] = useState<AnnouncementInput["audience"]>(canTargetBroadly ? "school" : "section");
  const [chosenClassId, setChosenClassId] = useState(classId);
  const targets = audience === "class" ? classes : sections;
  const targetLoading = audience === "class" ? classLoading : sectionLoading;
  const staffCanSeeSection = roles.some((role) => ["hod", "teacher", "class_teacher"].includes(role));

  return <form onSubmit={onSubmit} className="surface space-y-4 border-l-4 border-l-[hsl(var(--accent))] p-4 sm:p-5">
    <div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[hsl(var(--brand-mint))] text-[hsl(var(--brand-mint-ink))]"><Send size={16} /></span><div><h2 className="display m-0 text-lg font-extrabold">Publish an update</h2><p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">Publishing sends this announcement immediately. It cannot be saved as a draft.</p></div></div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs font-semibold">Announcement title<input name="title" required minLength={3} maxLength={160} className="field mt-1.5" placeholder="A clear, useful headline" /></label>
      <label className="text-xs font-semibold">Audience
        <select name="audience" className="field mt-1.5" value={audience} onChange={(event) => setAudience(event.target.value as AnnouncementInput["audience"])}>
          {canTargetBroadly && <><option value="school">Everyone at school</option><option value="class">A class</option><option value="role">By role</option></>}
          <option value="section">A section</option>
        </select>
      </label>
    </div>
    {(audience === "class" || audience === "section") && <div className="grid gap-3 sm:grid-cols-2">
      {audience === "section" && <label className="text-xs font-semibold">Class
        <select className="field mt-1.5" value={chosenClassId} onChange={(event) => { setChosenClassId(event.target.value); onClassChange(event.target.value); }}>
          <option value="">All available classes</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>}
      <label className="text-xs font-semibold">{audience === "class" ? "Choose class" : "Choose section"}
        <select name="targetId" required className="field mt-1.5" disabled={targetLoading}>
          <option value="">{targetLoading ? "Loading options…" : `Select ${audience}`}</option>
          {targets.map((item) => <option key={item.id} value={item.id}>{item.name}{audience === "section" && "className" in item ? ` · ${item.className}` : ""}</option>)}
        </select>
        {audience === "section" && staffCanSeeSection && <span className="mt-1 block text-[10px] font-normal text-[hsl(var(--muted-foreground))]">Your school checks that you can publish to this section.</span>}
      </label>
    </div>}
    {audience === "role" && <fieldset className="rounded-xl border border-[hsl(var(--border))] p-3">
      <legend className="px-1 text-xs font-semibold">Select one or more roles</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{audienceRoles.map((role) => <label key={role} className="flex items-center gap-2 text-xs capitalize"><input type="checkbox" name="roles" value={role} className="h-4 w-4 accent-[hsl(var(--primary))]" />{readableRole(role)}</label>)}</div>
    </fieldset>}
    <label className="block text-xs font-semibold">Message<textarea name="body" required maxLength={10000} rows={5} className="field mt-1.5 min-h-32 resize-y leading-6" placeholder="Share the details the community needs to know." /></label>
    <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <label className="text-xs font-semibold">Priority
        <select name="priority" className="field mt-1.5"><option value="normal">Standard update</option><option value="urgent">Urgent announcement</option></select>
      </label>
      <label className="text-xs font-semibold">Expiry <span className="font-normal text-[hsl(var(--muted-foreground))]">Optional</span><input name="expiresAt" type="datetime-local" className="field mt-1.5" /></label>
      <button disabled={pending || classLoading || (audience === "section" && sectionLoading)} className="btn btn-primary"><Send size={15} />{pending ? "Publishing…" : "Publish now"}</button>
    </div>
    {loadingError && <div role="alert" className="flex items-center gap-2 text-xs text-[hsl(var(--destructive))]"><AlertCircle size={14} />{loadingError}<button type="button" className="ml-auto font-bold underline" onClick={onRetry}>Retry options</button></div>}
  </form>;
}

function AnnouncementCard({ announcement, canViewStats, onRead, readPending }: { announcement: Announcement; canViewStats: boolean; onRead: () => void; readPending: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const stats = useGetAnnouncementStats(announcement.id, {
    query: { enabled: canViewStats && showStats, queryKey: getGetAnnouncementStatsQueryKey(announcement.id), retry: false },
  });
  const audienceLabel = announcement.audience === "role"
    ? `For ${announcement.roles.map(readableRole).join(", ")}`
    : announcement.audience === "school" ? "Whole school"
      : `${announcement.audienceName || announcement.audience} audience`;

  return <article className={`relative p-4 sm:p-5 ${!announcement.readAt ? "bg-[hsl(var(--brand-mint)/.12)]" : ""}`}>
    {!announcement.readAt && <span className="absolute bottom-0 left-0 top-0 w-1 bg-[hsl(var(--primary))]" aria-label="Unread" />}
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {announcement.priority === "urgent" ? <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--destructive)/.1)] px-2.5 py-1 text-[10px] font-bold text-[hsl(var(--destructive))]"><ShieldAlert size={12} />Urgent</span> : <span className="tag">{audienceLabel}</span>}
          {announcement.priority === "urgent" && <span className="tag">{audienceLabel}</span>}
          {!announcement.readAt && <span className="rounded-full bg-[hsl(var(--brand-mint))] px-2 py-1 text-[10px] font-bold text-[hsl(var(--brand-mint-ink))]">Unread</span>}
        </div>
        <h3 className="display m-0 text-[17px] font-extrabold leading-snug tracking-[-.02em]">{announcement.title}</h3>
        <p className={`mb-0 mt-2 whitespace-pre-wrap text-[13px] leading-6 text-[hsl(var(--muted-foreground))] ${expanded ? "" : "line-clamp-3"}`}>{announcement.body}</p>
        {announcement.body.length > 210 && <button type="button" className="mt-2 text-xs font-bold text-[hsl(var(--primary))] hover:underline" onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : "Read full announcement"}</button>}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[hsl(var(--muted-foreground))]">
          <span className="inline-flex items-center gap-1"><Radio size={12} />{announcement.authorName}</span>
          <time dateTime={announcement.publishedAt}>{dateTime(announcement.publishedAt)}</time>
          {announcement.expiresAt && <span className="inline-flex items-center gap-1"><Clock3 size={12} />Expires {dateTime(announcement.expiresAt)}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:flex-col sm:items-end">
        {announcement.readAt ? <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[hsl(var(--status-good))]"><Check size={13} />Read</span> : <button type="button" className="btn btn-muted min-h-9 px-3 text-xs" disabled={readPending} onClick={onRead}>{readPending ? "Saving…" : "Mark as read"}</button>}
        {canViewStats && <button type="button" className="btn btn-quiet min-h-8 px-2 text-[10px]" aria-expanded={showStats} onClick={() => setShowStats((value) => !value)}><Users size={13} />Read stats</button>}
      </div>
    </div>
    {canViewStats && showStats && <StatsLine stats={stats} />}
  </article>;
}

function StatsLine({ stats }: { stats: { data?: AnnouncementStats; isLoading: boolean; isError: boolean; error: unknown; refetch: () => Promise<unknown> } }) {
  if (stats.isLoading) return <div className="mt-4 h-8 max-w-xs skeleton" aria-label="Loading read statistics" />;
  if (stats.isError) return <div role="status" className="mt-3 rounded-lg bg-[hsl(var(--muted))] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]">{isForbidden(stats.error) ? "Read statistics are not available for this announcement." : "Read statistics could not be loaded."} <button className="ml-1 font-bold underline" onClick={() => stats.refetch()}>Retry</button></div>;
  return <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-[hsl(var(--secondary))] px-3 py-2 text-xs"><Users size={14} className="text-[hsl(var(--primary))}" /><b>{stats.data?.total ?? 0}</b><span className="text-[hsl(var(--muted-foreground))]">read receipts</span></div>;
}
