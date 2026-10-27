import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarCheck,
  Clock3,
  CreditCard,
  GraduationCap,
  LayoutDashboard,
  Library,
  LogOut,
  Moon,
  Radio,
  ShieldCheck,
  Users,
  Video,
} from "lucide-react";
import "./_group.css";

const SCHOOL_NAME = "St Joseph's Public School";
const PLATFORM_NAME = "My School Day";

const data = {
  userName: "Ananya Rao",
  metrics: [
    { label: "Active students", value: "428", change: "8 new this term", tone: "positive" },
    { label: "Classes today", value: "24", change: "2 live right now", tone: "neutral" },
    { label: "Upcoming sessions", value: "6", change: "Next begins at 10:30", tone: "neutral" },
    { label: "Attendance today", value: "94%", change: "3% below last week", tone: "warning" },
  ],
  upcomingSessions: [
    {
      id: "session-1",
      title: "Mathematics · Fractions",
      teacherName: "Ms. Anita Rao",
      mode: "section",
      status: "live",
      startAt: "2026-10-27T10:30:00+05:30",
      sections: ["Grade 6 · A"],
    },
    {
      id: "session-2",
      title: "Science · Plant life",
      teacherName: "Mr. Joseph Mathew",
      mode: "section",
      status: "scheduled",
      startAt: "2026-10-27T11:15:00+05:30",
      sections: ["Grade 7 · B"],
    },
  ],
  recentActivity: [
    { id: "activity-1", label: "New announcement", description: "Annual sports day schedule is ready.", occurredAt: "2026-10-27T09:15:00+05:30" },
    { id: "activity-2", label: "Learning resource added", description: "A new mathematics worksheet is available.", occurredAt: "2026-10-27T08:40:00+05:30" },
    { id: "activity-3", label: "Attendance updated", description: "Grade 6 attendance has been recorded.", occurredAt: "2026-10-27T08:10:00+05:30" },
  ],
};

const navItems = [
  { label: "Overview", icon: LayoutDashboard, active: true },
  { label: "Classes", icon: BookOpen },
  { label: "Students", icon: Users },
  { label: "Live classes", icon: Video },
  { label: "Smartboards", icon: Library },
  { label: "Learning", icon: GraduationCap },
  { label: "Announcements", icon: Radio },
  { label: "Attendance", icon: CalendarCheck },
  { label: "Timetable", icon: CalendarCheck },
  { label: "Admissions", icon: BookOpen },
  { label: "Family access", icon: ShieldCheck },
  { label: "Fees", icon: CreditCard },
];

const formatDate = (iso: string) => `${iso.slice(0, 10)} · ${iso.slice(11, 16)}`;

export function Current() {
  return (
    <div className="min-h-screen bg-[hsl(var(--background))] md:flex">
      <aside className="hidden w-[260px] shrink-0 flex-col bg-[hsl(var(--sidebar))] px-4 py-5 text-[hsl(var(--sidebar-foreground))] md:flex">
        <div className="mb-9 flex items-center gap-3 px-2">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-[hsl(var(--primary))] text-white"><GraduationCap size={22} /></div>
          <div className="min-w-0"><div className="display text-[14px] font-extrabold leading-tight tracking-tight">{SCHOOL_NAME}</div><div className="mt-1 text-[9px] uppercase tracking-[.14em] opacity-60">Powered by {PLATFORM_NAME}</div></div>
        </div>
        <div className="mb-3 px-3 text-[10px] font-bold uppercase tracking-[.17em] text-white/40">Workspace</div>
        <nav className="space-y-1" aria-label="Main navigation">
          {navItems.map(({ label, icon: Icon, active }) => (
            <a key={label} href="#" onClick={event => event.preventDefault()} className={`flex h-11 items-center gap-3 rounded-xl px-3 text-[13px] font-semibold transition ${active ? "bg-white/10 text-white" : "text-white/65 hover:bg-white/5 hover:text-white"}`}>
              <Icon size={17} strokeWidth={1.8} />{label}{active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))]" />}
            </a>
          ))}
        </nav>
        <div className="mt-auto">
          <div className="mb-4 rounded-xl border border-white/10 bg-white/[.04] p-3">
            <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-white/80"><ShieldCheck size={14} className="text-[hsl(var(--accent))]" />A trusted classroom</div>
            <p className="m-0 text-[11px] leading-relaxed text-white/45">Your school’s learning space, all in one place.</p>
          </div>
          <div className="flex items-center gap-3 border-t border-white/10 px-2 pt-4">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[hsl(var(--brand-mint))] text-xs font-bold text-[hsl(var(--brand-mint-ink))]">AR</div>
            <div className="min-w-0 flex-1"><div className="truncate text-[12px] font-bold">{data.userName}</div><div className="truncate text-[10px] capitalize text-white/50">Campus admin</div></div>
            <button title="Switch theme" className="grid h-8 w-8 place-items-center rounded-lg text-white/60 hover:bg-white/10"><Moon size={16} /></button>
            <button title="Sign out" className="grid h-8 w-8 place-items-center rounded-lg text-white/60 hover:bg-white/10"><LogOut size={16} /></button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex h-[68px] items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--background)/.94)] px-4 backdrop-blur-md md:px-9">
          <div className="text-[11px] text-[hsl(var(--muted-foreground))]">Workspace / <span className="font-semibold text-[hsl(var(--foreground))]">Overview</span></div>
          <div className="flex items-center gap-3 text-[11px] text-[hsl(var(--muted-foreground))]"><span className="max-w-[118px] truncate sm:max-w-none"><span className="mr-2 inline-block h-2 w-2 rounded-full bg-[hsl(var(--status-good))]" />{SCHOOL_NAME}</span><div className="grid h-8 w-8 place-items-center rounded-full bg-[hsl(var(--secondary))] font-bold text-[hsl(var(--secondary-foreground))]">A</div></div>
        </header>
        <div className="mx-auto w-full max-w-[1450px] px-4 py-7 md:px-9 md:py-9">
          <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div><div className="mb-2 text-[10px] font-bold uppercase tracking-[.2em] text-[hsl(var(--primary))]">Your school, at a glance</div><h1 className="display m-0 text-[30px] font-extrabold leading-tight tracking-[-.045em] md:text-[36px]">Good to see you, {data.userName.split(" ")[0]}.</h1><p className="mb-0 mt-2 max-w-2xl text-[13px] text-[hsl(var(--muted-foreground))]">A clear view of what’s happening across your learning day.</p></div>
            <a href="#" onClick={event => event.preventDefault()} className="btn btn-primary">Explore live classes <ArrowRight size={15} /></a>
          </div>
          <div className="space-y-6">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {data.metrics.map((metric, i) => {
                const Icon = [Users, BookOpen, Video, Activity][i];
                return <div key={metric.label} className="surface relative overflow-hidden p-5">
                  <div className="mb-5 flex items-start justify-between"><span className="text-[12px] font-semibold text-[hsl(var(--muted-foreground))]">{metric.label}</span><div className={`grid h-8 w-8 place-items-center rounded-lg ${i === 0 ? "bg-[hsl(var(--status-good-bg))] text-[hsl(var(--brand-mint-ink))]" : "bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"}`}><Icon size={16} /></div></div>
                  <div className="display text-[27px] font-extrabold tracking-tight">{metric.value}</div>
                  <div className="mt-2 flex items-center gap-1 text-[10px] text-[hsl(var(--muted-foreground))]">{metric.tone === "positive" ? <ArrowUpRight size={13} className="text-[hsl(var(--status-good))]" /> : metric.tone === "warning" ? <ArrowDown size={13} className="text-[hsl(var(--accent))]" /> : null}<span>{metric.change}</span></div>
                </div>;
              })}
            </div>
            <div className="grid gap-5 xl:grid-cols-[1.35fr_.85fr]">
              <section className="surface p-5 md:p-6">
                <div className="mb-5 flex items-center justify-between"><div><h2 className="display m-0 text-lg font-extrabold">Coming up</h2><p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">Your next scheduled learning sessions</p></div><a href="#" onClick={event => event.preventDefault()} className="text-xs font-bold text-[hsl(var(--primary))]">All sessions <ArrowRight className="ml-1 inline" size={13} /></a></div>
                <div className="space-y-2">{data.upcomingSessions.map(session => <div key={session.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-[hsl(var(--border))] p-3.5">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><Video size={18} /></div>
                  <div className="min-w-[150px] flex-1"><div className="text-[13px] font-bold">{session.title}</div><div className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">{session.teacherName} · {session.sections.join(", ")}</div></div>
                  <div className="text-right"><div className="flex items-center justify-end gap-1 text-[11px] font-semibold"><Clock3 size={12} />{formatDate(session.startAt)}</div><div className="mt-1"><span className={`tag ${session.status === "live" ? "tag-live" : ""}`}>{session.status}</span></div></div>
                </div>)}</div>
              </section>
              <section className="surface p-5 md:p-6">
                <div className="mb-5 flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><Activity size={17} /></div><div><h2 className="display m-0 text-lg font-extrabold">Recent activity</h2><p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">Latest updates from your school</p></div></div>
                <div className="space-y-4">{data.recentActivity.map(item => <div key={item.id} className="flex gap-3 border-l border-[hsl(var(--border))] pl-4"><span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[hsl(var(--primary))]" /><div><div className="text-[12px] font-bold">{item.label}</div><div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{item.description}</div><div className="mt-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">{formatDate(item.occurredAt)}</div></div></div>)}</div>
              </section>
            </div>
            <div className="surface flex flex-col justify-between gap-4 overflow-hidden bg-[hsl(var(--brand-forest))] p-6 text-[hsl(var(--brand-inverse))] sm:flex-row sm:items-center md:px-8">
              <div><div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.18em] text-[hsl(var(--classroom-ready))]"><span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--brand-accent))]" />Learning in sync</div><h3 className="display m-0 text-xl font-extrabold">One school day. Many ways to connect.</h3><p className="mb-0 mt-2 max-w-xl text-xs leading-5 text-white/60">Find live classes and classroom resources shared with your role.</p></div>
              <a href="#" onClick={event => event.preventDefault()} className="btn shrink-0 bg-[hsl(var(--brand-accent))] text-[hsl(var(--brand-ink))]">Browse smartboards <ArrowRight size={15} /></a>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
