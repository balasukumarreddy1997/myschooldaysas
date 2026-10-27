"use client";

import { type FormEvent, useState } from "react";
import { useCreatePublicAdmissionEnquiry } from "@workspace/api-client-react";
import type { PublicAdmissionEnquiryInput } from "@workspace/api-client-react";
import { ArrowRight, Check, GraduationCap, ShieldCheck } from "lucide-react";
import { SCHOOL_NAME } from "@/lib/branding";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Your enquiry could not be sent. Please try again.";

export function PublicAdmissionForm() {
  const [resultId, setResultId] = useState("");
  const createEnquiry = useCreatePublicAdmissionEnquiry();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? "").trim();
    const payload: PublicAdmissionEnquiryInput = {
      orgSlug: value("orgSlug"),
      childName: value("childName"),
      classApplying: value("classApplying"),
      guardianName: value("guardianName"),
      guardianPhone: value("guardianPhone"),
      ...(value("dateOfBirth") ? { dateOfBirth: value("dateOfBirth") } : {}),
      ...(value("guardianEmail") ? { guardianEmail: value("guardianEmail") } : {}),
      ...(value("notes") ? { notes: value("notes") } : {}),
    };
    createEnquiry.mutate({ data: payload }, {
      onSuccess: (response) => setResultId(response.id),
    });
  }

  if (resultId) {
    return (
      <main className="shell grain grid min-h-[100dvh] place-items-center px-4 py-10">
        <section className="surface page-enter w-full max-w-[560px] overflow-hidden">
          <div className="h-2 bg-[hsl(var(--primary))]" />
          <div className="p-7 sm:p-10">
            <div className="mb-6 grid h-14 w-14 place-items-center rounded-2xl bg-[hsl(var(--brand-mint))] text-[hsl(var(--brand-mint-ink))]"><Check size={26} strokeWidth={2.5} /></div>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[.2em] text-[hsl(var(--primary))]">Enquiry received</p>
            <h1 className="display m-0 text-3xl font-extrabold tracking-[-.04em]">Thank you for reaching out.</h1>
            <p className="mt-3 text-sm leading-6 text-[hsl(var(--muted-foreground))]">The admissions team has your details and will be in touch soon. Keep this reference for your records.</p>
            <div className="mt-7 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4">
              <div className="text-[10px] font-bold uppercase tracking-[.15em] text-[hsl(var(--muted-foreground))]">Enquiry reference</div>
              <div className="mt-1 break-all font-mono text-sm font-semibold" role="status" data-testid="text-enquiry-id">{resultId}</div>
            </div>
            <div className="mt-6 flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]"><ShieldCheck size={15} className="text-[hsl(var(--primary))]" />Your information is shared with the school admissions team.</div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="shell grain min-h-[100dvh] px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto grid w-full max-w-6xl overflow-hidden rounded-[22px] border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-[0_18px_70px_hsl(var(--foreground)/.08)] md:grid-cols-[.78fr_1.22fr]">
        <aside className="relative flex min-h-[250px] flex-col justify-between overflow-hidden bg-[hsl(var(--brand-forest))] p-7 text-[hsl(var(--brand-inverse))] sm:p-10 md:min-h-[740px]">
          <div aria-hidden="true" className="absolute -right-20 top-28 h-72 w-72 rounded-full border border-white/10" />
          <div aria-hidden="true" className="absolute -right-4 top-44 h-48 w-48 rounded-full border border-white/10" />
          <div className="relative flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[hsl(var(--brand-accent))] text-[hsl(var(--brand-ink))]"><GraduationCap size={22} /></div><span className="display text-base font-extrabold leading-tight">{SCHOOL_NAME}</span></div>
          <div className="relative my-10 max-w-md">
            <p className="mb-4 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.2em] text-[hsl(var(--classroom-ready))]"><span className="h-px w-7 bg-[hsl(var(--brand-accent))]" />Admissions enquiry</p>
            <h1 className="display text-[38px] font-extrabold leading-[1.05] tracking-[-.045em] sm:text-5xl">A good start<br />begins with a<br /><span className="text-[hsl(var(--brand-accent))]">conversation.</span></h1>
            <p className="mt-5 max-w-sm text-sm leading-6 text-white/65">Tell us a little about your family. Our admissions team will help you understand the next steps.</p>
          </div>
          <div className="relative flex items-center gap-2 border-t border-white/15 pt-5 text-[11px] text-white/55"><ShieldCheck size={15} />A direct line to your school’s admissions team</div>
        </aside>

        <section className="p-6 sm:p-9 md:p-11">
          <div className="mb-7">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[.18em] text-[hsl(var(--primary))]">First contact</p>
            <h2 className="display m-0 text-2xl font-extrabold tracking-[-.035em]">Share your details</h2>
            <p className="mb-0 mt-2 text-sm text-[hsl(var(--muted-foreground))]">Fields marked with <span className="text-[hsl(var(--destructive))]">*</span> are required.</p>
          </div>
          <form className="space-y-5" onSubmit={submit}>
            <label className="block text-xs font-bold">School organization <span className="text-[hsl(var(--destructive))]">*</span>
              <input name="orgSlug" required minLength={1} maxLength={80} autoComplete="organization" className="field mt-1.5" placeholder="Your school’s organization" />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-xs font-bold">Child’s full name <span className="text-[hsl(var(--destructive))]">*</span>
                <input name="childName" required minLength={2} maxLength={120} autoComplete="off" className="field mt-1.5" placeholder="Student name" />
              </label>
              <label className="block text-xs font-bold">Class applying for <span className="text-[hsl(var(--destructive))]">*</span>
                <input name="classApplying" required maxLength={80} className="field mt-1.5" placeholder="e.g. Grade 4" />
              </label>
              <label className="block text-xs font-bold">Date of birth <span className="font-normal text-[hsl(var(--muted-foreground))]">Optional</span>
                <input name="dateOfBirth" type="date" className="field mt-1.5" />
              </label>
              <label className="block text-xs font-bold">Parent / guardian name <span className="text-[hsl(var(--destructive))]">*</span>
                <input name="guardianName" required minLength={2} maxLength={120} autoComplete="name" className="field mt-1.5" placeholder="Your full name" />
              </label>
            </div>
            <div className="border-t border-[hsl(var(--border))] pt-5">
              <h3 className="m-0 text-xs font-bold">How can we reach you?</h3>
              <p className="mb-4 mt-1 text-xs text-[hsl(var(--muted-foreground))]">We’ll use these details only to follow up on this enquiry.</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-xs font-bold">Phone number <span className="text-[hsl(var(--destructive))]">*</span>
                  <input name="guardianPhone" type="tel" required minLength={7} maxLength={32} autoComplete="tel" className="field mt-1.5" placeholder="+1 555 010 2040" />
                </label>
                <label className="block text-xs font-bold">Email address <span className="font-normal text-[hsl(var(--muted-foreground))]">Optional</span>
                  <input name="guardianEmail" type="email" maxLength={254} autoComplete="email" className="field mt-1.5" placeholder="you@example.com" />
                </label>
              </div>
            </div>
            <label className="block text-xs font-bold">Anything you’d like us to know? <span className="font-normal text-[hsl(var(--muted-foreground))]">Optional</span>
              <textarea name="notes" maxLength={1000} rows={3} className="field mt-1.5 min-h-24 resize-y" placeholder="Questions, preferred times to connect, or other context…" />
            </label>
            {createEnquiry.isError && <div role="alert" className="rounded-lg border border-[hsl(var(--destructive)/.25)] bg-[hsl(var(--destructive)/.06)] px-3 py-2.5 text-xs text-[hsl(var(--destructive))]">{message(createEnquiry.error)}</div>}
            <button type="submit" disabled={createEnquiry.isPending} className="btn btn-primary w-full">
              {createEnquiry.isPending ? "Sending your enquiry…" : "Send enquiry"} <ArrowRight size={16} />
            </button>
            <p className="m-0 text-center text-[10px] leading-5 text-[hsl(var(--muted-foreground))]">By submitting, you’re asking the school to contact you about admissions.</p>
          </form>
        </section>
      </div>
    </main>
  );
}
