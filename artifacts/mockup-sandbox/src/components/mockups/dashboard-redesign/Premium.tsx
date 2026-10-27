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
import "./premium.css";

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

export function Premium() {
  return (
    <div className="premium-dashboard">
      <aside className="premium-dash-sidebar">
        <div className="premium-dash-brand">
          <div className="premium-dash-crest" aria-hidden="true"><GraduationCap size={23} strokeWidth={1.7} /></div>
          <div className="premium-dash-brand-copy">
            <div className="premium-dash-school">{SCHOOL_NAME}</div>
            <div className="premium-dash-platform">Powered by {PLATFORM_NAME}</div>
          </div>
        </div>
        <div className="premium-dash-section-label">Workspace</div>
        <nav className="premium-dash-nav" aria-label="Main navigation">
          {navItems.map(({ label, icon: Icon, active }) => (
            <a
              key={label}
              href="#"
              onClick={event => event.preventDefault()}
              aria-current={active ? "page" : undefined}
              className={`premium-dash-nav-item${active ? " is-active" : ""}`}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {active && <span className="premium-dash-nav-mark" aria-hidden="true" />}
            </a>
          ))}
        </nav>
        <div className="premium-dash-sidebar-bottom">
          <div className="premium-dash-trust">
            <div className="premium-dash-trust-title"><ShieldCheck size={15} /> A trusted classroom</div>
            <p>Your school’s learning space, all in one place.</p>
          </div>
          <div className="premium-dash-profile">
            <div className="premium-dash-avatar" aria-hidden="true">AR</div>
            <div className="premium-dash-profile-copy">
              <div className="premium-dash-profile-name">{data.userName}</div>
              <div className="premium-dash-profile-role">Campus admin</div>
            </div>
            <button type="button" title="Switch theme" aria-label="Switch theme" className="premium-dash-icon-button"><Moon size={16} /></button>
            <button type="button" title="Sign out" aria-label="Sign out" className="premium-dash-icon-button"><LogOut size={16} /></button>
          </div>
        </div>
      </aside>

      <main className="premium-dash-main">
        <header className="premium-dash-header">
          <div className="premium-dash-breadcrumb">Workspace <span>/</span> <strong>Overview</strong></div>
          <div className="premium-dash-school-status">
            <span className="premium-dash-live-dot" aria-hidden="true" />
            <span>{SCHOOL_NAME}</span>
            <div className="premium-dash-header-avatar" aria-hidden="true">A</div>
          </div>
        </header>

        <div className="premium-dash-content">
          <section className="premium-dash-welcome" aria-labelledby="premium-dash-title">
            <div className="premium-dash-welcome-copy">
              <div className="premium-dash-eyebrow"><span /> Your school, at a glance</div>
              <h1 id="premium-dash-title">Good to see you, <em>{data.userName.split(" ")[0]}.</em></h1>
              <p>A clear view of what’s happening across your learning day.</p>
            </div>
            <a href="#" onClick={event => event.preventDefault()} className="premium-dash-primary-link">
              Explore live classes <ArrowRight size={16} />
            </a>
          </section>

          <section className="premium-dash-metrics" aria-label="School overview metrics">
            {data.metrics.map((metric, i) => {
              const Icon = [Users, BookOpen, Video, Activity][i];
              return (
                <article key={metric.label} className={`premium-dash-metric premium-dash-metric-${metric.tone}`}>
                  <div className="premium-dash-metric-top">
                    <span>{metric.label}</span>
                    <div className="premium-dash-metric-icon"><Icon size={17} strokeWidth={1.8} /></div>
                  </div>
                  <div className="premium-dash-metric-value">{metric.value}</div>
                  <div className="premium-dash-metric-change">
                    {metric.tone === "positive" ? <ArrowUpRight size={13} /> : metric.tone === "warning" ? <ArrowDown size={13} /> : null}
                    <span>{metric.change}</span>
                  </div>
                </article>
              );
            })}
          </section>

          <div className="premium-dash-lower-grid">
            <section className="premium-dash-panel premium-dash-sessions" aria-labelledby="premium-dash-sessions-heading">
              <div className="premium-dash-panel-heading">
                <div>
                  <div className="premium-dash-panel-kicker">ON THE TIMETABLE</div>
                  <h2 id="premium-dash-sessions-heading">Coming up</h2>
                  <p>Your next scheduled learning sessions</p>
                </div>
                <a href="#" onClick={event => event.preventDefault()} className="premium-dash-text-link">All sessions <ArrowRight size={14} /></a>
              </div>
              <div className="premium-dash-session-list">
                {data.upcomingSessions.map(session => (
                  <article key={session.id} className="premium-dash-session">
                    <div className="premium-dash-session-icon"><Video size={18} strokeWidth={1.8} /></div>
                    <div className="premium-dash-session-copy">
                      <div className="premium-dash-session-title">{session.title}</div>
                      <div className="premium-dash-session-meta">{session.teacherName} <span>·</span> {session.sections.join(", ")}</div>
                    </div>
                    <div className="premium-dash-session-time">
                      <div><Clock3 size={13} /> {formatDate(session.startAt)}</div>
                      <span className={`premium-dash-tag${session.status === "live" ? " is-live" : ""}`}>{session.status}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="premium-dash-panel premium-dash-activity" aria-labelledby="premium-dash-activity-heading">
              <div className="premium-dash-panel-heading premium-dash-activity-heading">
                <div className="premium-dash-activity-emblem"><Activity size={18} /></div>
                <div>
                  <div className="premium-dash-panel-kicker">ACROSS THE SCHOOL</div>
                  <h2 id="premium-dash-activity-heading">Recent activity</h2>
                  <p>Latest updates from your school</p>
                </div>
              </div>
              <div className="premium-dash-activity-list">
                {data.recentActivity.map((item, index) => (
                  <article key={item.id} className="premium-dash-activity-item">
                    <span className={`premium-dash-activity-node node-${index + 1}`} aria-hidden="true" />
                    <div>
                      <div className="premium-dash-activity-label">{item.label}</div>
                      <div className="premium-dash-activity-description">{item.description}</div>
                      <div className="premium-dash-activity-time">{formatDate(item.occurredAt)}</div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>

          <section className="premium-dash-community">
            <div className="premium-dash-community-ornament" aria-hidden="true"><span /><span /><span /></div>
            <div className="premium-dash-community-copy">
              <div className="premium-dash-community-kicker"><span /> Learning in sync</div>
              <h2>One school day. Many ways to connect.</h2>
              <p>Find live classes and classroom resources shared with your role.</p>
            </div>
            <a href="#" onClick={event => event.preventDefault()} className="premium-dash-community-link">Browse smartboards <ArrowRight size={15} /></a>
          </section>
          <footer className="premium-dash-footer"><BookOpen size={14} /><span>Learning, belonging, becoming.</span><span className="premium-dash-footer-rule" /><span>ST JOSEPH'S PUBLIC SCHOOL</span></footer>
        </div>
      </main>
    </div>
  );
}
