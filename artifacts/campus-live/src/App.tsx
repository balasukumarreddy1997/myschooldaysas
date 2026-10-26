"use client";

import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation, useParams } from 'wouter';
import {
  useLogin, useGetMe, getGetMeQueryKey, useGetDashboardOverview, getGetDashboardOverviewQueryKey,
  useGetClasses, useGetSections,
  useGetStudents, getGetStudentsQueryKey, useGetSessions, getGetSessionsQueryKey,
  useCreateSession, useStartSession, useEndSession, useGetSessionToken,
  useGetBoardTemplates, getGetBoardTemplatesQueryKey, useCreateBoardTemplate, useUpdateBoardTemplate,
  useChangePassword, useGetConsents, getGetConsentsQueryKey, useGrantConsent, useRevokeConsent,
  getGetConsentReviewStatusQueryKey, useCompleteConsentReview, useGetConsentReviewStatus,
} from '@workspace/api-client-react';
import type { BoardConfig, BoardTemplate, BoardTemplateInput, LiveSession, LiveSessionInput, SectionSummary } from '@workspace/api-client-react';
import {
  Activity, ArrowDown, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown,
  ChevronLeft, ChevronRight, CircleAlert, Clock3, DoorOpen, GraduationCap, LayoutDashboard,
  Library, LoaderCircle, LogOut, Menu, Moon, Plus, Radio, Search, Settings2, ShieldCheck,
  Sun, Users, Video, X, CalendarCheck,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import NotFound from '@/components/not-found';
import { setAccessToken } from './auth-token';
import { ClassroomScreen } from '@/components/classroom/classroom-screen';
import { LearningPage } from '@/components/learning/learning-page';
import { AttendancePage } from '@/components/attendance/attendance-page';
import { TimetablePage } from '@/components/academic/timetable-page';
import { SectionCapacityField } from '@/components/academic/section-capacity-field';
import { EnrollmentYearField } from '@/components/academic/enrollment-year-field';
import { GuardianAccessPage } from '@/components/academic/guardian-access-page';

const queryClient = new QueryClient();
const fmtDate = (iso?: string) => iso ? `${iso.slice(0, 10)} · ${iso.slice(11, 16)}` : 'Time not set';
const roleName = (role?: string) => role?.replaceAll('_', ' ') ?? 'Member';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const initialBoardConfig: BoardConfig = {
  background: { type: 'ruled', color: '#fffdf8', lineColor: '#dce5e2', spacing: 32 },
  canvas: { mode: 'fixed', aspect: '16:9', maxPages: 20 },
  tools: ['select', 'pen', 'highlighter', 'eraser', 'line', 'arrow', 'rect', 'ellipse', 'text', 'sticky'],
  defaultTool: 'pen', palette: ['#173e38', '#2e8b70', '#dc8b43', '#b94f47', '#596f9c'],
  penSizes: [2, 4, 8, 14], toolbar: { position: 'left', size: 'regular', autoHide: false },
  participants: { studentsCanView: true, studentsCanDraw: false, allowDrawGrants: true, studentTools: ['pen'], followTeacherPage: true },
  features: { pressureSensitivity: false, palmRejection: true, shapeRecognition: true, undoRedo: true, snapshotIntervalSec: 30, exportFormats: ['png', 'pdf'] },
};

function App() {
  return <QueryClientProvider client={queryClient}><Switch>
    <Route path="/login" component={LoginPage} />
    <Route><ProtectedApp /></Route>
  </Switch></QueryClientProvider>;
}

function ProtectedApp() {
  const [path, setPath] = useLocation();
  const me = useGetMe({ query: { retry: false } });
  const consentReview = useGetConsentReviewStatus({
    query: { enabled: me.data?.roles?.includes('parent') ?? false, retry: false },
  });
  if (me.isLoading) return <LoadingScreen />;
  if (!me.data) return <LoginGate error={me.error} retry={() => me.refetch()} />;
  const user = me.data;
  if (!Array.isArray(user.roles)) return <LoginGate error={new Error('Your sign-in details are incomplete. Please sign in again.')} retry={() => me.refetch()} />;
  if (user.mustChangePassword) return <PasswordChangePage email={user.email} />;
  const logout = () => { setAccessToken(null); queryClient.clear(); setPath('/login'); };
  if (user.roles.includes('parent')) {
    if (consentReview.isLoading) return <LoadingScreen />;
    if (consentReview.isError) return <div className="shell grain grid min-h-screen place-items-center p-5"><div className="surface max-w-md p-6 text-center"><h1 className="display text-xl font-extrabold">Privacy choices unavailable</h1><p className="my-3 text-sm text-[hsl(var(--muted-foreground))]">We could not load your consent review status.</p><button className="btn btn-primary" onClick={() => consentReview.refetch()}>Try again</button></div></div>;
    if (consentReview.data?.required && !consentReview.data.reviewedAt) {
      return <div className="shell grain min-h-screen"><main className="mx-auto w-full max-w-5xl p-4 pt-8 md:p-8"><div className="mb-7 flex items-center justify-between"><div className="flex items-center gap-2 font-bold"><ShieldCheck size={18} className="text-[hsl(var(--primary))]"/>Campus Live</div><button className="btn btn-muted" onClick={logout}><LogOut size={15}/>Sign out</button></div><ConsentsPage firstLogin /></main></div>;
    }
  }
  if (path.startsWith('/classroom/')) return <ErrorBoundary resetKey={path}><ClassroomPage roles={user.roles}/></ErrorBoundary>;
  return <div className="shell grain"><AppShell user={user} path={path} onLogout={logout}>
    <ErrorBoundary resetKey={path}>
      <Switch>
        <Route path="/" component={() => <DashboardPage />} />
        <Route path="/dashboard" component={() => <DashboardPage />} />
        <Route path="/admin/classes" component={() => <ClassesPage roles={user.roles} />} />
        <Route path="/admin/students" component={() => <StudentsPage roles={user.roles} />} />
        <Route path="/admin/guardians" component={() => user.roles.some(role => ['super_admin','org_admin','campus_admin'].includes(role)) ? <GuardianAccessPage/> : <NotFound/>} />
        <Route path="/live/sessions" component={() => <SessionsPage userRoles={user.roles} />} />
        <Route path="/boards/templates" component={() => <TemplatesPage roles={user.roles} />} />
        <Route path="/learning" component={() => <LearningPage roles={user.roles} />} />
        <Route path="/attendance" component={() => <AttendancePage roles={user.roles} />} />
        <Route path="/timetable" component={() => <TimetablePage canManage={user.roles.some(role => ['super_admin', 'org_admin', 'campus_admin'].includes(role))} />} />
        <Route path="/family/consents" component={() => user.roles.includes('parent') ? <ConsentsPage/> : <NotFound/>} />
        <Route path="/classroom/:sessionId" component={() => <ClassroomPage roles={user.roles} />} />
        <Route component={NotFound} />
      </Switch>
    </ErrorBoundary>
  </AppShell></div>;
}

function AppShell({ user, path, onLogout, children }: { user: { name: string; email: string; roles: string[] }; path: string; onLogout: () => void; children: ReactNode }) {
  const [mobileNav, setMobileNav] = useState(false);
  const [dark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
  const toggleTheme = () => { document.documentElement.classList.toggle('dark'); setDark(!dark); };
  const nav = [
    { label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
    { label: 'Classes', href: '/admin/classes', icon: BookOpen },
    { label: 'Students', href: '/admin/students', icon: Users },
    { label: 'Live classes', href: '/live/sessions', icon: Video },
    { label: 'Smartboards', href: '/boards/templates', icon: Library },
    { label: 'Learning', href: '/learning', icon: GraduationCap },
    { label: 'Attendance', href: '/attendance', icon: CalendarCheck },
    { label: 'Timetable', href: '/timetable', icon: CalendarCheck },
  ];
  if (user.roles.some(role => ['super_admin','org_admin','campus_admin'].includes(role))) {
    nav.push({ label: 'Family access', href: '/admin/guardians', icon: ShieldCheck });
  }
  if (user.roles.includes('parent')) nav.push({ label: 'Privacy & consent', href: '/family/consents', icon: ShieldCheck });
  return <div className="min-h-[100dvh] md:flex">
    <aside className={`fixed inset-y-0 left-0 z-40 flex w-[260px] flex-col bg-[hsl(var(--sidebar))] px-4 py-5 text-[hsl(var(--sidebar-foreground))] transition-transform md:translate-x-0 ${mobileNav ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="mb-9 flex items-center gap-3 px-2">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-[hsl(var(--primary))] text-white"><GraduationCap size={22}/></div>
        <div><div className="display text-[17px] font-extrabold tracking-tight">Campus Live</div><div className="mt-0.5 text-[10px] uppercase tracking-[.18em] opacity-60">School, connected</div></div>
        <button aria-label="Close navigation" className="ml-auto text-white/60 md:hidden" onClick={() => setMobileNav(false)}><X size={18}/></button>
      </div>
      <div className="mb-3 px-3 text-[10px] font-bold uppercase tracking-[.17em] text-white/40">Workspace</div>
      <nav className="space-y-1">
        {nav.map(item => {
          const Icon = item.icon; const active = path === item.href || (item.href !== '/dashboard' && path.startsWith(item.href));
          return <Link key={item.href} href={item.href} onClick={() => setMobileNav(false)} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`} className={`flex h-11 items-center gap-3 rounded-xl px-3 text-[13px] font-semibold transition ${active ? 'bg-white/10 text-white' : 'text-white/65 hover:bg-white/5 hover:text-white'}`}>
            <Icon size={17} strokeWidth={1.8}/>{item.label}{active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))]"/>}
          </Link>;
        })}
      </nav>
      <div className="mt-auto">
        <div className="mb-4 rounded-xl border border-white/10 bg-white/[.04] p-3">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-white/80"><ShieldCheck size={14} className="text-[hsl(var(--accent))]"/> A trusted classroom</div>
          <p className="m-0 text-[11px] leading-relaxed text-white/45">Your school’s learning space, all in one place.</p>
        </div>
        <div className="flex items-center gap-3 border-t border-white/10 px-2 pt-4">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[hsl(var(--brand-mint))] text-xs font-bold text-[hsl(var(--brand-mint-ink))]">{user.name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()}</div>
          <div className="min-w-0 flex-1"><div data-testid="text-username" className="truncate text-[12px] font-bold">{user.name}</div><div className="truncate text-[10px] capitalize text-white/50">{roleName(user.roles[0])}</div></div>
          <button title={dark ? 'Switch to light theme' : 'Switch to dark theme'} data-testid="button-theme" onClick={toggleTheme} className="grid h-8 w-8 place-items-center rounded-lg text-white/60 hover:bg-white/10">{dark ? <Sun size={16}/> : <Moon size={16}/>}</button>
          <button title="Sign out" data-testid="button-sign-out" onClick={onLogout} className="grid h-8 w-8 place-items-center rounded-lg text-white/60 hover:bg-white/10"><LogOut size={16}/></button>
        </div>
      </div>
    </aside>
    {mobileNav && <button aria-label="Close menu overlay" onClick={() => setMobileNav(false)} className="fixed inset-0 z-30 bg-black/40 md:hidden"/>}
    <main className="min-w-0 flex-1 md:ml-[260px]">
      <header className="sticky top-0 z-20 flex h-[68px] items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--background)/.94)] px-4 backdrop-blur-md md:px-9">
        <div className="flex items-center gap-3">
          <button aria-label="Open navigation" data-testid="button-open-navigation" onClick={() => setMobileNav(true)} className="grid h-9 w-9 place-items-center rounded-lg border border-[hsl(var(--border))] md:hidden"><Menu size={18}/></button>
          <div className="text-[11px] text-[hsl(var(--muted-foreground))]">Campus / <span className="font-semibold capitalize text-[hsl(var(--foreground))]">{nav.find(item => path.startsWith(item.href))?.label ?? 'Classroom'}</span></div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-[hsl(var(--muted-foreground))]"><span className="hidden items-center gap-2 sm:flex"><span className="h-2 w-2 rounded-full bg-[hsl(var(--status-good))]"/>School workspace</span><div className="grid h-8 w-8 place-items-center rounded-full bg-[hsl(var(--secondary))] font-bold text-[hsl(var(--secondary-foreground))]">{user.name.slice(0, 1).toUpperCase()}</div></div>
      </header>
      <div className="page-enter mx-auto w-full max-w-[1450px] px-4 py-7 md:px-9 md:py-9">{children}</div>
    </main>
  </div>;
}

function LoginGate({ error, retry }: { error: unknown; retry: () => void }) {
  return <div className="grid min-h-[100dvh] place-items-center p-6"><div className="surface max-w-md p-7 text-center">
    <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><ShieldCheck size={24}/></div>
    <h1 className="display text-xl font-extrabold">Your school space awaits</h1>
    <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">{error ? 'We could not confirm your sign-in. Please try again or sign in.' : 'You are not signed in yet.'}</p>
    <div className="mt-5 flex justify-center gap-2"><button className="btn btn-muted" onClick={retry}>Try again</button><Link className="btn btn-primary" href="/login">Sign in <ArrowRight size={15}/></Link></div>
  </div></div>;
}

function LoginPage() {
  const [orgSlug, setOrgSlug] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [, setLocation] = useLocation(); const login = useLogin({ mutation: { onSuccess: result => { setAccessToken(result.accessToken); queryClient.setQueryData(getGetMeQueryKey(), result.user); setLocation('/dashboard'); } } });
  return <div className="grid min-h-[100dvh] md:grid-cols-[1.05fr_.95fr]">
    <section className="relative hidden overflow-hidden bg-[hsl(var(--brand-forest))] p-12 text-[hsl(var(--brand-inverse))] md:flex md:flex-col md:justify-between">
      <div className="absolute -right-24 -top-24 h-[440px] w-[440px] rounded-full border border-white/10"/><div className="absolute -right-5 top-[-70px] h-[300px] w-[300px] rounded-full border border-white/10"/>
      <div className="relative flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[hsl(var(--brand-accent))] text-[hsl(var(--brand-ink))]"><GraduationCap/></div><span className="display text-lg font-extrabold">Campus Live</span></div>
      <div className="relative max-w-xl pb-12"><div className="mb-6 flex items-center gap-2 text-xs font-bold uppercase tracking-[.18em] text-[hsl(var(--classroom-ready))]"><span className="h-px w-8 bg-[hsl(var(--brand-accent))]"/>A closer school community</div><h1 className="display text-5xl font-extrabold leading-[1.08] tracking-[-.04em]">Learning moves<br/>better <span className="text-[hsl(var(--brand-accent))]">together.</span></h1><p className="mt-6 max-w-md text-[15px] leading-7 text-white/65">Classes, teachers and families — connected in one dependable space built around your school.</p></div>
      <div className="relative flex justify-between border-t border-white/15 pt-5 text-[10px] uppercase tracking-[.16em] text-white/45"><span>Campus Live</span><span>For every learner</span></div>
    </section>
    <section className="flex min-h-[100dvh] items-center justify-center px-5 py-10">
      <div className="w-full max-w-[410px]">
        <div className="mb-9 md:hidden"><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[hsl(var(--primary))] text-white"><GraduationCap/></div><span className="display text-lg font-extrabold">Campus Live</span></div></div>
        <div className="mb-8"><span className="tag mb-4">School sign-in</span><h2 className="display mb-2 text-[30px] font-extrabold tracking-[-.04em]">Welcome back</h2><p className="m-0 text-sm text-[hsl(var(--muted-foreground))]">Sign in with your school account to continue.</p></div>
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); login.mutate({ data: { orgSlug, email, password } }); }}>
           <label className="block text-xs font-bold">Organization<div className="mt-1.5"><input required autoComplete="organization" data-testid="input-organization" className="field" placeholder="Your school’s organization" value={orgSlug} onChange={e => setOrgSlug(e.target.value)}/></div></label>
           <label className="block text-xs font-bold">Email address<div className="mt-1.5"><input required type="email" autoComplete="username" data-testid="input-email" className="field" placeholder="name@school.edu.in" value={email} onChange={e => setEmail(e.target.value)}/></div></label>
           <label className="block text-xs font-bold">Password<div className="mt-1.5"><input required type="password" autoComplete="current-password" data-testid="input-password" className="field" placeholder="Enter your password" value={password} onChange={e => setPassword(e.target.value)}/></div></label>
          {login.isError && <div role="alert" data-testid="status-login-error" className="rounded-lg border border-[hsl(var(--destructive)/.25)] bg-[hsl(var(--destructive)/.08)] p-3 text-xs text-[hsl(var(--destructive))]">{errorText(login.error)}</div>}
          <button disabled={login.isPending} data-testid="button-submit-login" className="btn btn-primary mt-2 w-full">{login.isPending ? <LoaderCircle className="animate-spin" size={17}/> : null}{login.isPending ? 'Signing in…' : 'Sign in'}<ArrowRight size={16}/></button>
        </form>
        <div className="mt-7 flex items-center gap-2 border-t border-[hsl(var(--border))] pt-5 text-[11px] text-[hsl(var(--muted-foreground))]"><ShieldCheck size={15} className="text-[hsl(var(--primary))]"/>Your school credentials stay protected.</div>
      </div>
    </section>
  </div>;
}

function PasswordChangePage({ email }: { email: string }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [, setLocation] = useLocation();
  const change = useChangePassword({ mutation: { onSuccess: result => {
    setAccessToken(result.accessToken);
    queryClient.setQueryData(getGetMeQueryKey(), result.user);
    setLocation('/dashboard');
  } } });
  const confirmError = confirmPassword && newPassword !== confirmPassword ? 'Passwords do not match.' : null;

  return <div className="grid min-h-[100dvh] place-items-center p-5">
    <section className="surface w-full max-w-md p-7 sm:p-9">
      <div className="mb-5 grid h-12 w-12 place-items-center rounded-2xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><ShieldCheck size={24}/></div>
      <span className="tag">Account security</span>
      <h1 className="display mb-2 mt-3 text-2xl font-extrabold">Change your temporary password</h1>
      <p className="mb-6 text-sm text-[hsl(var(--muted-foreground))]">Choose a new password before continuing. Signed in as {email}.</p>
      <form className="space-y-4" onSubmit={event => {
        event.preventDefault();
        if (!confirmError) change.mutate({ data: { currentPassword, newPassword } });
      }}>
        <label className="block text-xs font-bold">Current password<div className="mt-1.5"><input required type="password" autoComplete="current-password" className="field" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)}/></div></label>
        <label className="block text-xs font-bold">New password<div className="mt-1.5"><input required minLength={12} maxLength={256} type="password" autoComplete="new-password" className="field" value={newPassword} onChange={event => setNewPassword(event.target.value)}/></div><span className="mt-1 block text-[11px] font-normal text-[hsl(var(--muted-foreground))]">Use at least 12 characters.</span></label>
        <label className="block text-xs font-bold">Confirm new password<div className="mt-1.5"><input required minLength={12} maxLength={256} type="password" autoComplete="new-password" className="field" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)}/></div></label>
        {(confirmError || change.isError) && <p role="alert" className="text-xs text-[hsl(var(--destructive))]">{confirmError ?? errorText(change.error)}</p>}
        <button disabled={change.isPending || !!confirmError} className="btn btn-primary w-full">{change.isPending ? 'Updating…' : 'Set new password'}<ArrowRight size={15}/></button>
      </form>
    </section>
  </div>;
}

function ConsentsPage({ firstLogin = false }: { firstLogin?: boolean }) {
  const consents = useGetConsents();
  const queryClient = useQueryClient();
  const grant = useGrantConsent({ mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetConsentsQueryKey() }) } });
  const revoke = useRevokeConsent({ mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetConsentsQueryKey() }) } });
  const review = useCompleteConsentReview({ mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetConsentReviewStatusQueryKey() }) } });
  const items = consents.data?.items ?? [];

  return <div>
    <PageHeading eyebrow={firstLogin ? "Before you continue" : "Family privacy"} title="Privacy & consent" description="Review and change consent for each linked student."/>
    <div className="surface mb-5 border-l-4 border-l-[hsl(var(--accent))] p-4 text-xs leading-5 text-[hsl(var(--muted-foreground))]">
      Live viewing requires an active live-view choice. Recording and photo features are not enabled; they cannot be granted here. Reviewing this page does not grant any consent.
    </div>
    {firstLogin && <div className="surface mb-5 p-4 text-xs leading-5 text-[hsl(var(--muted-foreground))]">Please review the choices for each linked student. You can grant or revoke available choices below, and change them later from Privacy &amp; consent.</div>}
    <QueryState loading={consents.isLoading} error={consents.error} empty={!items.length} retry={() => consents.refetch()}>
      <div className="surface overflow-hidden">
        <div className="divide-y divide-[hsl(var(--border))]">
          {items.map(item => {
            const busy = grant.isPending || revoke.isPending;
            const label = item.purpose.replaceAll('_', ' ');
            const unavailable = item.purpose === 'recording' || item.purpose === 'photo';
            return <div key={`${item.studentId}:${item.purpose}`} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{item.studentName}</div>
                <div className="mt-1 text-xs capitalize text-[hsl(var(--muted-foreground))]">{label}</div>
              </div>
              <span className={`text-xs font-semibold ${item.granted ? 'text-[hsl(var(--status-good))]' : 'text-[hsl(var(--muted-foreground))]'}`}>{item.granted ? 'Granted' : 'Not granted'}</span>
              {item.granted
                ? <button disabled={busy} className="btn btn-muted btn-sm" onClick={() => revoke.mutate({ studentId: item.studentId, purpose: item.purpose })}>Revoke</button>
                : unavailable
                  ? <span className="text-xs text-[hsl(var(--muted-foreground))]">Feature not enabled</span>
                  : <button disabled={busy} className="btn btn-primary btn-sm" onClick={() => grant.mutate({ data: { studentId: item.studentId, purpose: item.purpose } })}>Grant</button>}
            </div>;
          })}
        </div>
      </div>
    </QueryState>
    {(grant.isError || revoke.isError || review.isError) && <p role="alert" className="mt-3 text-xs text-[hsl(var(--destructive))]">{errorText(grant.error || revoke.error || review.error)}</p>}
    {firstLogin && <div className="surface mt-5 flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><p className="m-0 text-xs leading-5 text-[hsl(var(--muted-foreground))]">This records that you reviewed the choices. It does not grant a permission.</p><button className="btn btn-primary" disabled={consents.isLoading || consents.isError || review.isPending} onClick={() => review.mutate(undefined)}>{review.isPending ? 'Saving…' : 'I reviewed these choices and continue'}<ArrowRight size={15}/></button></div>}
  </div>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><div className="mb-2 text-[10px] font-bold uppercase tracking-[.2em] text-[hsl(var(--primary))]">{eyebrow}</div><h1 className="display m-0 text-[30px] font-extrabold leading-tight tracking-[-.045em] md:text-[36px]">{title}</h1><p className="mb-0 mt-2 max-w-2xl text-[13px] text-[hsl(var(--muted-foreground))]">{description}</p></div>{action}</div>;
}
function LoadingScreen() { return <div className="grid min-h-[100dvh] place-items-center p-6"><div className="w-full max-w-sm space-y-3"><div className="skeleton h-5 w-36"/><div className="skeleton h-10 w-64"/><div className="skeleton h-24 w-full"/></div></div>; }
function QueryState({ loading, error, empty, retry, children }: { loading: boolean; error?: unknown; empty: boolean; retry: () => void; children: ReactNode }) {
  if (loading) return <div className="space-y-3" aria-label="Loading"><div className="skeleton h-14 w-full"/><div className="skeleton h-14 w-full"/><div className="skeleton h-14 w-full"/></div>;
  if (error) return <div className="surface flex flex-col items-center p-8 text-center"><CircleAlert className="mb-3 text-[hsl(var(--destructive))]" size={24}/><b>We couldn’t load this yet</b><p className="text-sm text-[hsl(var(--muted-foreground))]">{errorText(error)}</p><button className="btn btn-muted" onClick={retry}>Retry</button></div>;
  if (empty) return <div className="surface flex flex-col items-center p-10 text-center"><div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><BookOpen size={21}/></div><b>Nothing here just yet</b><p className="mb-0 mt-2 text-sm text-[hsl(var(--muted-foreground))]">When your school adds this information, it will appear here.</p></div>;
  return <>{children}</>;
}

function DashboardPage() {
  const overview = useGetDashboardOverview();
  const data = overview.data;
  return <><PageHeading eyebrow="Your school, at a glance" title={`Good to see you${data?.userName ? `, ${data.userName.split(' ')[0]}` : ''}.`} description="A clear view of what’s happening across your learning day." action={<Link href="/live/sessions" className="btn btn-primary">Explore live classes <ArrowRight size={15}/></Link>}/>
    <QueryState loading={overview.isLoading} error={overview.error} empty={!data} retry={() => overview.refetch()}>
      {data && <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{data.metrics.map((metric, i) => <div key={metric.label} className="surface relative overflow-hidden p-5"><div className="mb-5 flex items-start justify-between"><span className="text-[12px] font-semibold text-[hsl(var(--muted-foreground))]">{metric.label}</span><div className={`grid h-8 w-8 place-items-center rounded-lg ${i === 0 ? 'bg-[hsl(var(--status-good-bg))] text-[hsl(var(--brand-mint-ink))]' : 'bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]'}`}>{i === 0 ? <Users size={16}/> : i === 1 ? <BookOpen size={16}/> : i === 2 ? <Video size={16}/> : <Activity size={16}/>}</div></div><div data-testid={`metric-value-${i}`} className="display text-[27px] font-extrabold tracking-tight">{metric.value}</div><div className="mt-2 flex items-center gap-1 text-[10px] text-[hsl(var(--muted-foreground))]">{metric.tone === 'positive' ? <ArrowUpRight size={13} className="text-[hsl(var(--status-good))]"/> : metric.tone === 'warning' ? <ArrowDown size={13} className="text-[hsl(var(--accent))]"/> : null}<span>{metric.change}</span></div></div>)}</div>
        <div className="grid gap-5 xl:grid-cols-[1.35fr_.85fr]">
          <section className="surface p-5 md:p-6"><div className="mb-5 flex items-center justify-between"><div><h2 className="display m-0 text-lg font-extrabold">Coming up</h2><p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">Your next scheduled learning sessions</p></div><Link href="/live/sessions" className="text-xs font-bold text-[hsl(var(--primary))]">All sessions <ArrowRight className="ml-1 inline" size={13}/></Link></div>
            {data.upcomingSessions.length ? <div className="space-y-2">{data.upcomingSessions.map(session => <SessionRow key={session.id} session={session}/>)}</div> : <InlineEmpty text="No upcoming sessions have been scheduled."/>}
          </section>
          <section className="surface p-5 md:p-6"><div className="mb-5 flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><Activity size={17}/></div><div><h2 className="display m-0 text-lg font-extrabold">Recent activity</h2><p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">Latest updates from your school</p></div></div>
            {data.recentActivity.length ? <div className="space-y-4">{data.recentActivity.map(item => <div key={item.id} data-testid={`activity-${item.id}`} className="flex gap-3 border-l border-[hsl(var(--border))] pl-4"><span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[hsl(var(--primary))]"/><div><div className="text-[12px] font-bold">{item.label}</div><div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{item.description}</div><div className="mt-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">{fmtDate(item.occurredAt)}</div></div></div>)}</div> : <InlineEmpty text="No recent updates to show."/>}
          </section>
        </div>
        <div className="surface flex flex-col justify-between gap-4 overflow-hidden bg-[hsl(var(--brand-forest))] p-6 text-[hsl(var(--brand-inverse))] sm:flex-row sm:items-center md:px-8"><div><div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.18em] text-[hsl(var(--classroom-ready))]"><span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--brand-accent))]"/>Learning in sync</div><h3 className="display m-0 text-xl font-extrabold">One school day. Many ways to connect.</h3><p className="mb-0 mt-2 max-w-xl text-xs leading-5 text-white/60">Find live classes and classroom resources shared with your role.</p></div><Link href="/boards/templates" className="btn shrink-0 bg-[hsl(var(--brand-accent))] text-[hsl(var(--brand-ink))]">Browse smartboards <ArrowRight size={15}/></Link></div>
      </div>}
    </QueryState>
  </>;
}
function InlineEmpty({ text }: { text: string }) { return <div className="rounded-xl border border-dashed border-[hsl(var(--border))] p-5 text-center text-xs text-[hsl(var(--muted-foreground))]">{text}</div>; }
function SessionRow({ session, action }: { session: LiveSession; action?: React.ReactNode }) {
  return <div data-testid={`session-row-${session.id}`} className="flex flex-wrap items-center gap-3 rounded-xl border border-[hsl(var(--border))] p-3.5">
    <div className="grid h-10 w-10 place-items-center rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><Video size={18}/></div>
    <div className="min-w-[150px] flex-1"><div className="text-[13px] font-bold">{session.title}</div><div className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">{session.teacherName} · {session.sections.join(', ') || (session.mode === 'class' ? 'Whole class' : 'Section')}</div></div>
    <div className="flex items-center gap-3"><div className="text-right"><div className="flex items-center justify-end gap-1 text-[11px] font-semibold"><Clock3 size={12}/>{fmtDate(session.startAt)}</div><div className="mt-1"><StatusTag status={session.status}/></div></div>{action}</div>
  </div>;
}
function StatusTag({ status }: { status: string }) { return <span className={`tag ${status === 'live' ? 'tag-live' : ''}`}>{status}</span>; }

function ClassesPage({ roles }: { roles: string[] }) {
  const canManage = roles.some(role => ['super_admin', 'org_admin', 'campus_admin'].includes(role));
  const classes = useGetClasses(); const sections = useGetSections();
  const byClass = useMemo(() => (sections.data?.items ?? []).reduce<Record<string, SectionSummary[]>>((acc, section) => { (acc[section.classId] ??= []).push(section); return acc; }, {}), [sections.data]);
  const err = classes.error || sections.error;
  return <><PageHeading eyebrow="Academic directory" title="Classes & sections" description="A clear view of the classes and sections in your school."/>
    <QueryState loading={classes.isLoading || sections.isLoading} error={err} empty={!classes.data?.items.length} retry={() => { classes.refetch(); sections.refetch(); }}>
      {classes.data && <div className="space-y-3">{classes.data.items.map(item => <details key={item.id} className="surface group overflow-hidden" open><summary data-testid={`class-summary-${item.id}`} className="flex cursor-pointer list-none flex-wrap items-center gap-4 p-4 md:p-5"><div className="grid h-11 w-11 place-items-center rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><BookOpen size={19}/></div><div className="min-w-[150px] flex-1"><div className="display text-[15px] font-extrabold">{item.name}</div><div className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">Grade {item.gradeLevel}</div></div><div className="flex gap-5 text-center"><div><div className="display font-bold">{item.sectionCount}</div><div className="text-[10px] text-[hsl(var(--muted-foreground))]">Sections</div></div><div><div className="display font-bold">{item.studentCount}</div><div className="text-[10px] text-[hsl(var(--muted-foreground))]">Students</div></div></div><ChevronDown className="ml-2 text-[hsl(var(--muted-foreground))] transition group-open:rotate-180" size={17}/></summary><div className="border-t border-[hsl(var(--border))] px-4 py-3 md:px-5">{byClass[item.id]?.length ? <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{byClass[item.id].map(section => <div key={section.id} data-testid={`section-card-${section.id}`} className="space-y-3 rounded-lg bg-[hsl(var(--background))] p-3"><div className="flex items-center justify-between"><div><div className="text-xs font-bold">{section.name}</div><div className="mt-1 text-[10px] text-[hsl(var(--muted-foreground))]">{section.studentCount} students · capacity {section.capacity ?? 'not set'}</div></div><Users size={15} className="text-[hsl(var(--primary))]"/></div>{canManage && <SectionCapacityField sectionId={section.id} sectionName={section.name} capacity={section.capacity}/>}</div>)}</div> : <p className="text-xs text-[hsl(var(--muted-foreground))]">No sections have been assigned to this class.</p>}</div></details>)}</div>}
    </QueryState>
  </>;
}

function StudentsPage({ roles }: { roles: string[] }) {
  const canManage = roles.some(role => ['super_admin', 'org_admin', 'campus_admin'].includes(role));
  const sections = useGetSections();
  const [sectionId, setSectionId] = useState('');
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const params = useMemo(() => ({ sectionId: sectionId || sections.data?.items[0]?.id || '', limit: 20, offset: page * 20, ...(search.trim() ? { q: search.trim() } : {}) }), [sectionId, sections.data?.items, page, search]);
  const students = useGetStudents(params, { query: { enabled: !!params.sectionId, queryKey: getGetStudentsQueryKey(params) } });
  const effectiveSection = sectionId || sections.data?.items[0]?.id || '';
  return <><PageHeading eyebrow="Academic directory" title="Student roster" description="Find a student and review their current section."/>
    <div className="surface mb-5 flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="relative flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" size={16}/><input aria-label="Search students" data-testid="input-search-students" className="field pl-9" placeholder="Search by name or admission number" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }}/></div>
      <label className="flex items-center gap-2 text-xs font-semibold"><span>Section</span><select data-testid="select-student-section" className="field min-w-[150px]" value={effectiveSection} onChange={e => { setSectionId(e.target.value); setPage(0); }}><option value="">Choose section</option>{sections.data?.items.map(s => <option key={s.id} value={s.id}>{s.className} · {s.name}</option>)}</select></label>
    </div>
    {sections.isLoading ? <div className="skeleton h-48"/> : sections.error ? <QueryState loading={false} error={sections.error} empty={false} retry={() => sections.refetch()}><></></QueryState> :
      !effectiveSection ? <InlineEmpty text="No sections are available to display students."/> :
      <QueryState loading={students.isLoading} error={students.error} empty={!students.data?.items.length} retry={() => students.refetch()}>
        {students.data && <div className="surface overflow-hidden">
          <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-4"><div className="text-xs font-bold">{students.data.total} students</div><div className="text-[11px] text-[hsl(var(--muted-foreground))">Section roster</div></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left"><thead className="bg-[hsl(var(--muted))] text-[10px] uppercase tracking-[.12em] text-[hsl(var(--muted-foreground))]"><tr><th className="px-4 py-3">Student</th><th className="px-4 py-3">Admission no.</th><th className="px-4 py-3">Section</th><th className="px-4 py-3">Academic year</th><th className="px-4 py-3">Status</th></tr></thead><tbody>{students.data.items.map(student => <tr key={student.enrollmentId} data-testid={`student-row-${student.id}`} className="border-t border-[hsl(var(--border))]"><td className="px-4 py-3"><div className="flex items-center gap-3"><div className="grid h-8 w-8 place-items-center rounded-full bg-[hsl(var(--secondary))] text-xs font-bold text-[hsl(var(--primary))]">{student.name.slice(0,1).toUpperCase()}</div><span className="text-xs font-bold">{student.name}</span></div></td><td className="px-4 py-3 text-xs text-[hsl(var(--muted-foreground))]">{student.admissionNo}</td><td className="px-4 py-3 text-xs">{student.sectionName}</td><td className="px-4 py-3">{canManage ? <EnrollmentYearField enrollmentId={student.enrollmentId} academicYear={student.academicYear}/> : <span className="text-xs">{student.academicYear}</span>}</td><td className="px-4 py-3"><StatusTag status={student.status}/></td></tr>)}</tbody></table></div>
          <div className="flex items-center justify-between border-t border-[hsl(var(--border))] px-4 py-3"><span className="text-[11px] text-[hsl(var(--muted-foreground))">Showing {students.data.total ? page * 20 + 1 : 0}–{Math.min((page + 1) * 20, students.data.total)} of {students.data.total}</span><div className="flex gap-2"><button data-testid="button-students-prev" disabled={page === 0} className="btn btn-muted min-h-8 px-2" onClick={() => setPage(p => p - 1)}><ChevronLeft size={16}/><span className="desktop-only">Previous</span></button><button data-testid="button-students-next" disabled={(page + 1) * 20 >= students.data.total} className="btn btn-muted min-h-8 px-2" onClick={() => setPage(p => p + 1)}><span className="desktop-only">Next</span><ChevronRight size={16}/></button></div></div>
        </div>}
      </QueryState>}
  </>;
}

function SessionsPage({ userRoles }: { userRoles: string[] }) {
  const queryClient = useQueryClient(); const sessions = useGetSessions(); const sections = useGetSections(); const classes = useGetClasses();
  const isTeacher = userRoles.includes('teacher') || userRoles.includes('class_teacher');
  const canStart = userRoles.some(role => ['super_admin','org_admin','campus_admin','hod','teacher','class_teacher'].includes(role));
  const [showForm, setShowForm] = useState(false); const [title, setTitle] = useState(''); const [startAt, setStartAt] = useState(''); const [mode, setMode] = useState<'section'|'class'>('section'); const [sectionIds, setSectionIds] = useState<string[]>([]); const [classId, setClassId] = useState('');
  const create = useCreateSession({ mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetSessionsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetDashboardOverviewQueryKey() }); setShowForm(false); setTitle(''); } } });
  const start = useStartSession({ mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetSessionsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetDashboardOverviewQueryKey() }); } } });
  const end = useEndSession({ mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetSessionsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetDashboardOverviewQueryKey() }); } } });
  const schedule = (event: FormEvent) => { event.preventDefault(); const body: LiveSessionInput = { title, mode, startAt: new Date(startAt).toISOString(), sectionIds: mode === 'class' ? sections.data?.items.filter(s => s.classId === classId).map(s => s.id) ?? [] : sectionIds, ...(mode === 'class' ? { classId } : {}), parentView: false }; create.mutate({ data: body }); };
  const canSchedule = userRoles.some(role => ['org_admin','campus_admin','hod','teacher','class_teacher','super_admin'].includes(role));
  return <><PageHeading eyebrow="Teaching & learning" title="Live classes" description="Schedule a connected class, or join a session that’s ready to begin." action={canSchedule ? <button className="btn btn-primary" data-testid="button-schedule-session" onClick={() => setShowForm(v => !v)}><Plus size={16}/>Schedule class</button> : undefined}/>
    {showForm && <form onSubmit={schedule} className="surface mb-5 grid gap-4 p-5 md:grid-cols-2">
      <div className="md:col-span-2"><h2 className="display m-0 text-lg font-extrabold">Plan a live class</h2><p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">Choose who will join and when the session begins.</p></div>
      <label className="text-xs font-bold">Class title<input required data-testid="input-session-title" className="field mt-1.5" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Fractions: equivalent values"/></label>
      <label className="text-xs font-bold">Start time<input required type="datetime-local" data-testid="input-session-start" className="field mt-1.5" value={startAt} onChange={e => setStartAt(e.target.value)}/></label>
      <label className="text-xs font-bold">Session type<select className="field mt-1.5" value={mode} onChange={e => setMode(e.target.value as 'section'|'class')}><option value="section">Selected sections</option><option value="class">Whole class</option></select></label>
      {mode === 'class' ? <label className="text-xs font-bold">Class<select required className="field mt-1.5" value={classId} onChange={e => setClassId(e.target.value)}><option value="">Select a class</option>{classes.data?.items.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label> : <fieldset className="rounded-xl border border-[hsl(var(--border))] p-3 md:col-span-2"><legend className="px-1 text-xs font-bold">Sections</legend><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{sections.data?.items.map(s => <label key={s.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={sectionIds.includes(s.id)} onChange={e => setSectionIds(v => e.target.checked ? [...v,s.id] : v.filter(id => id !== s.id))}/>{s.className} · {s.name}</label>)}</div>{!sections.data?.items.length && <span className="text-xs text-[hsl(var(--muted-foreground))]">No sections available.</span>}</fieldset>}
      {create.isError && <p role="alert" className="text-xs text-[hsl(var(--destructive))] md:col-span-2">{errorText(create.error)}</p>}
      <div className="flex gap-2 md:col-span-2"><button disabled={create.isPending || (mode === 'section' && !sectionIds.length) || (mode === 'class' && !classId)} className="btn btn-primary" data-testid="button-save-session">{create.isPending ? 'Scheduling…' : 'Schedule session'}</button><button type="button" className="btn btn-muted" onClick={() => setShowForm(false)}>Cancel</button></div>
    </form>}
    <QueryState loading={sessions.isLoading} error={sessions.error} empty={!sessions.data?.items.length} retry={() => sessions.refetch()}>
       {sessions.data && <div className="space-y-3">{sessions.data.items.map(session => <SessionRow key={session.id} session={session} action={<div className="flex gap-2">{session.status === 'scheduled' && canStart && <button disabled={start.isPending} className="btn btn-primary min-h-8 px-3 text-[11px]" data-testid={`button-start-${session.id}`} onClick={() => start.mutate({ sessionId: session.id })}><Radio size={13}/>Start</button>}{session.status === 'live' && isTeacher && <button disabled={end.isPending} className="btn btn-muted min-h-8 px-3 text-[11px]" data-testid={`button-end-${session.id}`} onClick={() => end.mutate({ sessionId: session.id })}>End</button>}<Link href={`/classroom/${session.id}`} className="btn btn-muted min-h-8 px-3 text-[11px]">Open <ArrowUpRight size={13}/></Link></div>}/>)}</div>}
    </QueryState>
    {(create.isError || start.isError || end.isError) && <div role="alert" className="mt-3 text-xs text-[hsl(var(--destructive))]">{errorText(create.error || start.error || end.error)}</div>}
  </>;
}

function TemplatesPage({ roles }: { roles: string[] }) {
  const canCreate = roles.some(role => ['super_admin','org_admin','campus_admin','hod','teacher','class_teacher'].includes(role));
  const qc = useQueryClient(); const query = useGetBoardTemplates(); const create = useCreateBoardTemplate({ mutation: { onSuccess: () => { qc.invalidateQueries({ queryKey: getGetBoardTemplatesQueryKey() }); setEditor(false); } } });
  const update = useUpdateBoardTemplate({ mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getGetBoardTemplatesQueryKey() }) } });
  const [editor, setEditor] = useState(false); const [selected, setSelected] = useState<BoardTemplate | null>(null); const [name, setName] = useState(''); const [scope, setScope] = useState<BoardTemplateInput['scope']>('org'); const [configText, setConfigText] = useState(JSON.stringify(initialBoardConfig, null, 2)); const [configError, setConfigError] = useState('');
  const openNew = () => { setSelected(null); setName(''); setScope('org'); setConfigText(JSON.stringify(initialBoardConfig, null, 2)); setConfigError(''); setEditor(true); };
  const openEdit = (item: BoardTemplate) => { setSelected(item); setName(item.name); setScope(item.scope === 'system' ? 'org' : item.scope); setConfigText(JSON.stringify(item.config, null, 2)); setConfigError(''); setEditor(true); };
  const save = (event: FormEvent) => { event.preventDefault(); try { const config = JSON.parse(configText) as BoardConfig; setConfigError(''); if (selected) update.mutate({ templateId: selected.id, data: { name, config } }); else create.mutate({ data: { name, scope, config } }); } catch { setConfigError('Check that the board configuration is valid JSON.'); } };
  const toggleDefault = (item: BoardTemplate) => update.mutate({ templateId: item.id, data: { isDefault: !item.isDefault } });
  return <><PageHeading eyebrow="Classroom tools" title="Smartboard templates" description="Choose a board setup that fits the way your school teaches." action={canCreate ? <button className="btn btn-primary" data-testid="button-new-template" onClick={openNew}><Plus size={16}/>Create template</button> : undefined}/>
    {editor && <form onSubmit={save} className="surface mb-6 p-5 md:p-6">
      <div className="mb-4 flex items-start justify-between"><div><h2 className="display m-0 text-lg font-extrabold">{selected ? 'Edit template' : 'New smartboard template'}</h2><p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">Set a name and adjust the complete board configuration.</p></div><button type="button" aria-label="Close editor" className="btn btn-quiet min-h-8 px-2" onClick={() => setEditor(false)}><X size={17}/></button></div>
      <div className="grid gap-4 md:grid-cols-[1fr_180px]"><label className="text-xs font-bold">Template name<input required maxLength={100} data-testid="input-template-name" className="field mt-1.5" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Science — diagrams & notes"/></label>{!selected && <label className="text-xs font-bold">Scope<select className="field mt-1.5" value={scope} onChange={e => setScope(e.target.value as BoardTemplateInput['scope'])}><option value="org">Organization</option><option value="class">Class</option><option value="section">Section</option><option value="teacher">Teacher</option></select></label>}
      <label className="text-xs font-bold md:col-span-2">Board configuration <textarea spellCheck={false} data-testid="input-template-config" className="field mt-1.5 min-h-[280px] resize-y font-mono text-[11px] leading-5" value={configText} onChange={e => setConfigText(e.target.value)}/></label></div>
      {configError && <p role="alert" className="text-xs text-[hsl(var(--destructive))]">{configError}</p>}
      {(create.isError || update.isError) && <p role="alert" className="text-xs text-[hsl(var(--destructive))]">{errorText(create.error || update.error)}</p>}
      <div className="mt-4 flex gap-2"><button disabled={create.isPending || update.isPending} className="btn btn-primary" data-testid="button-save-template">{create.isPending || update.isPending ? 'Saving…' : 'Save template'}</button><button type="button" className="btn btn-muted" onClick={() => setEditor(false)}>Cancel</button></div>
    </form>}
    <QueryState loading={query.isLoading} error={query.error} empty={!query.data?.items.length} retry={() => query.refetch()}>
      {query.data && <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{query.data.items.map((item, index) => <article key={item.id} data-testid={`template-card-${item.id}`} className="surface overflow-hidden">
        <div className={`relative flex h-36 items-center justify-center ${index % 3 === 0 ? 'bg-[hsl(var(--board-art-1))]' : index % 3 === 1 ? 'bg-[hsl(var(--board-art-2))]' : 'bg-[hsl(var(--board-art-3))]'}`}>
          <div className="absolute inset-4 rounded-xl border border-[hsl(var(--board-green)/.2)] bg-[hsl(var(--paper))] shadow-sm"><div className="absolute inset-0 opacity-50" style={{ backgroundImage: `linear-gradient(to bottom, transparent 31px, ${item.config.background.lineColor} 32px)`, backgroundSize: '100% 32px' }} /><div className="relative flex h-full items-center justify-center gap-2">{item.config.palette.slice(0,4).map(color => <span key={color} className="h-5 w-5 rounded-full border border-black/10" style={{ backgroundColor: color }}/>)}</div></div>
          {item.isDefault && <span className="absolute right-5 top-5 rounded-full bg-[hsl(var(--brand-forest))] px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider text-[hsl(var(--brand-inverse))]">Default</span>}
        </div><div className="p-4"><div className="mb-1 flex items-start justify-between gap-2"><h3 className="display m-0 text-[15px] font-extrabold">{item.name}</h3><span className="tag">{item.scope}</span></div><p className="mb-4 mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">{item.config.background.type} background · {item.config.canvas.aspect} canvas · {item.config.tools.length} tools</p>
           {canCreate && <div className="flex gap-2 border-t border-[hsl(var(--border))] pt-3"><button className="btn btn-muted min-h-8 flex-1 text-[11px]" data-testid={`button-edit-template-${item.id}`} onClick={() => openEdit(item)}><Settings2 size={14}/>Edit setup</button><button className="btn btn-quiet min-h-8 text-[11px]" disabled={update.isPending} data-testid={`button-default-template-${item.id}`} onClick={() => toggleDefault(item)}>{item.isDefault ? <Check size={14}/> : <Plus size={14}/>} {item.isDefault ? 'Default' : 'Make default'}</button></div>}
        </div></article>)}</div>}
    </QueryState>
  </>;
}

function ClassroomPage({ roles: _roles }: { roles: string[] }) {
  const { sessionId } = useParams<{ sessionId: string }>();
  return sessionId ? <ClassroomScreen sessionId={sessionId} /> : <NotFound />;
}

export default App;
