import { useState } from "react";
import { ArrowRight, GraduationCap, ShieldCheck } from "lucide-react";
import "./_group.css";

const schoolName = "St Joseph's Public School";
const platformName = "My School Day";

export function Current() {
  const [message, setMessage] = useState("");

  return (
    <div className="grid min-h-[100dvh] md:grid-cols-[1.05fr_.95fr]">
      <section className="relative hidden overflow-hidden bg-[hsl(var(--brand-forest))] p-12 text-[hsl(var(--brand-inverse))] md:flex md:flex-col md:justify-between">
        <div className="absolute -right-24 -top-24 h-[440px] w-[440px] rounded-full border border-white/10" />
        <div className="absolute -right-5 top-[-70px] h-[300px] w-[300px] rounded-full border border-white/10" />
        <div className="relative flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-[hsl(var(--brand-accent))] text-[hsl(var(--brand-ink))]">
            <GraduationCap />
          </div>
          <div>
            <div className="display text-base font-extrabold leading-tight">{schoolName}</div>
            <div className="mt-1 text-[10px] uppercase tracking-[.14em] text-white/55">{platformName}</div>
          </div>
        </div>
        <div className="relative max-w-xl pb-12">
          <div className="mb-6 flex items-center gap-2 text-xs font-bold uppercase tracking-[.18em] text-[hsl(var(--classroom-ready))]">
            <span className="h-px w-8 bg-[hsl(var(--brand-accent))]" />
            A closer school community
          </div>
          <h1 className="display text-5xl font-extrabold leading-[1.08] tracking-[-.04em]">
            Learning moves<br />better <span className="text-[hsl(var(--brand-accent))]">together.</span>
          </h1>
          <p className="mt-6 max-w-md text-[15px] leading-7 text-white/65">
            Classes, teachers and families — connected in one dependable space built around your school.
          </p>
        </div>
        <div className="relative flex justify-between border-t border-white/15 pt-5 text-[10px] uppercase tracking-[.16em] text-white/45">
          <span>{platformName}</span><span>For every learner</span>
        </div>
      </section>

      <section className="flex min-h-[100dvh] items-center justify-center px-5 py-10">
        <div className="w-full max-w-[410px]">
          <div className="mb-9 md:hidden">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-[hsl(var(--primary))] text-white"><GraduationCap /></div>
              <div>
                <div className="display text-base font-extrabold leading-tight">{schoolName}</div>
                <div className="mt-1 text-[10px] uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]">{platformName}</div>
              </div>
            </div>
          </div>
          <div className="mb-8">
            <span className="tag mb-4">School sign-in</span>
            <h2 className="display mb-2 text-[30px] font-extrabold tracking-[-.04em]">Welcome back</h2>
            <p className="m-0 text-sm text-[hsl(var(--muted-foreground))]">Sign in with your school account to continue.</p>
          </div>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); setMessage("This is a visual preview. Sign in on the school app."); }}>
            <label className="block text-xs font-bold">
              Organization
              <div className="mt-1.5"><input required autoComplete="organization" className="field" placeholder="Your school’s organization" /></div>
            </label>
            <label className="block text-xs font-bold">
              Email address
              <div className="mt-1.5"><input required type="email" autoComplete="username" className="field" placeholder="name@school.edu.in" /></div>
            </label>
            <label className="block text-xs font-bold">
              Password
              <div className="mt-1.5"><input required type="password" autoComplete="current-password" className="field" placeholder="Enter your password" /></div>
            </label>
            {message && <p role="status" className="text-xs text-[hsl(var(--muted-foreground))]">{message}</p>}
            <button className="btn btn-primary mt-2 w-full" type="submit">Sign in <ArrowRight size={16} /></button>
          </form>
          <div className="mt-7 flex items-center gap-2 border-t border-[hsl(var(--border))] pt-5 text-[11px] text-[hsl(var(--muted-foreground))]">
            <ShieldCheck size={15} className="text-[hsl(var(--primary))}" />
            Your school credentials stay protected.
          </div>
        </div>
      </section>
    </div>
  );
}
