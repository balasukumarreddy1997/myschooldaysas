"use client";

import { type FormEvent, useState } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetFeeInvoicesQueryKey,
  getGetMyFeeInvoicesQueryKey,
  useGenerateFeeInvoices,
  useGetFeeInvoices,
  useGetFeeReceipt,
  useGetMyFeeInvoices,
  useGetSections,
  usePayFeeInvoice,
} from "@workspace/api-client-react";

const adminRoles = ["super_admin", "org_admin", "campus_admin"];
const money = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
const dateText = (value?: string | null) => value ? value.slice(0, 10) : "—";
const fieldClass = "field w-full";

type FeesPageProps = { roles: string[] };

export function FeesPage({ roles }: FeesPageProps) {
  const isAdmin = roles.some((role) => adminRoles.includes(role));
  const isParent = roles.includes("parent");
  const queryClient = useQueryClient();
  const sections = useGetSections(undefined, { query: { enabled: isAdmin } });
  const invoices = useGetFeeInvoices(
    { limit: 100, offset: 0 },
    { query: { enabled: isAdmin } },
  );
  const myInvoices = useGetMyFeeInvoices({ query: { enabled: isParent } });
  const [sectionId, setSectionId] = useState("");
  const [academicYear, setAcademicYear] = useState("");
  const [period, setPeriod] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notice, setNotice] = useState("");

  const generate = useGenerateFeeInvoices({
    mutation: {
      onSuccess: async (result) => {
        setNotice(result.generatedCount
          ? `${result.generatedCount} invoice${result.generatedCount === 1 ? "" : "s"} issued.`
          : "These invoices already exist for that section and period.");
        await queryClient.invalidateQueries({ queryKey: getGetFeeInvoicesQueryKey() });
      },
      onError: (error) => setNotice(error.message || "Invoices could not be issued."),
    },
  });
  const pay = usePayFeeInvoice({
    mutation: {
      onSuccess: async (result) => {
        setNotice(`Payment complete. Receipt ${result.receiptNumber} is ready.`);
        await queryClient.invalidateQueries({ queryKey: getGetMyFeeInvoicesQueryKey() });
      },
      onError: (error) => setNotice(error.message || "Payment could not be completed."),
    },
  });

  function submitInvoices(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    const amountPaise = Math.round(Number(amount) * 100);
    if (!Number.isSafeInteger(amountPaise) || amountPaise < 1) {
      setNotice("Enter a valid amount in rupees.");
      return;
    }
    generate.mutate({
      data: { sectionId, academicYear, period, description, amountPaise, dueDate },
    });
  }

  if (isAdmin) {
    const sectionItems = sections.data?.items ?? [];
    const invoiceItems = invoices.data?.items ?? [];
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <p className="eyebrow">School finance</p>
          <h1 className="display text-3xl font-extrabold">Fee invoices</h1>
          <p className="mt-2 max-w-2xl text-sm text-[hsl(var(--muted-foreground))]">
            Issue one invoice to each active student in a section. Repeating the same period with the same details will not create duplicates.
          </p>
        </header>

        <section className="surface p-5 md:p-6">
          <h2 className="display text-lg font-bold">Issue section invoices</h2>
          <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={submitInvoices}>
            <label className="block text-sm font-semibold">
              Section
              <select className={`${fieldClass} mt-2`} value={sectionId} onChange={(event) => setSectionId(event.target.value)} required>
                <option value="">Choose a section</option>
                {sectionItems.map((section) => (
                  <option key={section.id} value={section.id}>{section.className} · {section.name}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-semibold">
              Academic year
              <input className={`${fieldClass} mt-2`} value={academicYear} onChange={(event) => setAcademicYear(event.target.value)} placeholder="2026-2027" minLength={4} maxLength={24} required />
            </label>
            <label className="block text-sm font-semibold">
              Billing period
              <input className={`${fieldClass} mt-2`} value={period} onChange={(event) => setPeriod(event.target.value)} placeholder="Term 1 or 2026-10" maxLength={40} required />
            </label>
            <label className="block text-sm font-semibold">
              Description
              <input className={`${fieldClass} mt-2`} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Term 1 tuition fee" maxLength={160} required />
            </label>
            <label className="block text-sm font-semibold">
              Amount per student (₹)
              <input className={`${fieldClass} mt-2`} type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required />
            </label>
            <label className="block text-sm font-semibold">
              Due date
              <input className={`${fieldClass} mt-2`} type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} required />
            </label>
            <div className="md:col-span-2 flex flex-wrap items-center gap-3">
              <button className="btn btn-primary" type="submit" disabled={generate.isPending || !sectionId}>
                {generate.isPending ? "Issuing…" : "Issue invoices"}
              </button>
              {notice && <p className="text-sm text-[hsl(var(--muted-foreground))]" role="status">{notice}</p>}
            </div>
          </form>
          {sections.isError && <p className="mt-3 text-sm text-red-700">Sections could not be loaded. Refresh and try again.</p>}
          {invoices.isError && <p className="mt-3 text-sm text-red-700">Invoices could not be loaded. Refresh and try again.</p>}
        </section>

        <section className="surface overflow-hidden">
          <div className="border-b border-[hsl(var(--border))] p-5">
            <h2 className="display text-lg font-bold">Recent invoices</h2>
          </div>
          {invoices.isLoading ? <p className="p-5 text-sm">Loading invoices…</p> : invoiceItems.length === 0
            ? <p className="p-5 text-sm text-[hsl(var(--muted-foreground))]">No fee invoices have been issued yet.</p>
            : <div className="overflow-x-auto">
              <table className="w-full min-w-[740px] text-left text-sm">
                <thead className="bg-[hsl(var(--muted))] text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                  <tr><th className="p-3">Student</th><th className="p-3">Invoice</th><th className="p-3">Period</th><th className="p-3">Amount</th><th className="p-3">Due</th><th className="p-3">Status</th><th className="p-3">Receipt</th></tr>
                </thead>
                <tbody>
                  {invoiceItems.map((invoice) => (
                    <tr className="border-t border-[hsl(var(--border))]" key={invoice.id}>
                      <td className="p-3 font-semibold">{invoice.studentName}</td>
                      <td className="p-3">{invoice.invoiceNumber}</td>
                      <td className="p-3">{invoice.period} · {invoice.academicYear}</td>
                      <td className="p-3">{money(invoice.amountPaise)}</td>
                      <td className="p-3">{dateText(invoice.dueDate)}</td>
                      <td className="p-3 capitalize">{invoice.status}</td>
                      <td className="p-3">{invoice.receiptNumber
                        ? <Link className="font-semibold text-[hsl(var(--primary))] underline" href={`/fees/receipts/${encodeURIComponent(invoice.receiptNumber)}`}>{invoice.receiptNumber}</Link>
                        : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
        </section>
      </div>
    );
  }

  if (isParent) {
    const items = myInvoices.data?.items ?? [];
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <p className="eyebrow">Family account</p>
          <h1 className="display text-3xl font-extrabold">Fees and receipts</h1>
          <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">View invoices for your linked children and pay eligible balances.</p>
        </header>
        {notice && <div className="surface p-4 text-sm" role="status">{notice}</div>}
        {myInvoices.isError && <div className="surface p-5 text-sm text-red-700">Fee information could not be loaded. Refresh and try again.</div>}
        {myInvoices.isLoading ? <div className="surface p-5 text-sm">Loading fee information…</div>
          : items.length === 0 ? <div className="surface p-6 text-sm text-[hsl(var(--muted-foreground))]">There are no invoices for your linked children.</div>
            : <div className="space-y-4">
              {items.map((invoice) => (
                <article className="surface p-5 md:p-6" key={invoice.id}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">{invoice.studentName}</p>
                      <h2 className="display mt-1 text-xl font-bold">{invoice.description}</h2>
                      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">{invoice.invoiceNumber} · {invoice.period} · {invoice.academicYear}</p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-bold capitalize ${invoice.status === "paid" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>
                      {invoice.status}
                    </span>
                  </div>
                  <div className="mt-5 flex flex-wrap items-end justify-between gap-4 border-t border-[hsl(var(--border))] pt-4">
                    <div className="flex gap-8">
                      <div><p className="text-xs text-[hsl(var(--muted-foreground))]">Amount</p><p className="mt-1 text-lg font-bold">{money(invoice.amountPaise)}</p></div>
                      <div><p className="text-xs text-[hsl(var(--muted-foreground))]">Due date</p><p className="mt-1 font-semibold">{dateText(invoice.dueDate)}</p></div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {invoice.canPay && invoice.status === "unpaid" && (
                        <button className="btn btn-primary" disabled={pay.isPending} onClick={() => pay.mutate({ invoiceId: invoice.id })}>
                          {pay.isPending ? "Processing…" : "Pay now"}
                        </button>
                      )}
                      {!invoice.canPay && invoice.status === "unpaid" && (
                        <span className="text-sm text-[hsl(var(--muted-foreground))]">Payment is not enabled for this account.</span>
                      )}
                      {invoice.receiptNumber && (
                        <Link className="btn btn-muted" href={`/fees/receipts/${encodeURIComponent(invoice.receiptNumber)}`}>View receipt</Link>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>}
      </div>
    );
  }

  return <div className="surface p-6 text-sm">Fee access is available to school administrators and parents.</div>;
}

export function FeeReceiptPage() {
  const { receiptNumber = "" } = useParams<{ receiptNumber: string }>();
  const receipt = useGetFeeReceipt(receiptNumber);
  if (receipt.isLoading) return <div className="surface mx-auto max-w-2xl p-6">Loading receipt…</div>;
  if (receipt.isError || !receipt.data) return <div className="surface mx-auto max-w-2xl p-6 text-sm text-red-700">Receipt could not be loaded.</div>;
  const item = receipt.data;
  return (
    <div className="mx-auto max-w-2xl">
      <style>{`@media print { body * { visibility: hidden !important; } #fee-receipt, #fee-receipt * { visibility: visible !important; } #fee-receipt { position: absolute; inset: 0 auto auto 0; width: 100%; box-shadow: none !important; } }`}</style>
      <article id="fee-receipt" className="surface p-7 md:p-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="eyebrow">Campus Live · payment receipt</p>
            <h1 className="display mt-2 text-3xl font-extrabold">Payment received</h1>
          </div>
          <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">PAID</span>
        </div>
        <dl className="mt-8 grid gap-5 border-y border-[hsl(var(--border))] py-6 sm:grid-cols-2">
          <div><dt className="text-xs text-[hsl(var(--muted-foreground))]">Receipt number</dt><dd className="mt-1 font-semibold">{item.receiptNumber}</dd></div>
          <div><dt className="text-xs text-[hsl(var(--muted-foreground))]">Invoice number</dt><dd className="mt-1 font-semibold">{item.invoiceNumber}</dd></div>
          <div><dt className="text-xs text-[hsl(var(--muted-foreground))]">Student</dt><dd className="mt-1 font-semibold">{item.studentName}</dd></div>
          <div><dt className="text-xs text-[hsl(var(--muted-foreground))]">Payment date</dt><dd className="mt-1 font-semibold">{dateText(item.paidAt)}</dd></div>
          <div><dt className="text-xs text-[hsl(var(--muted-foreground))]">Description</dt><dd className="mt-1 font-semibold">{item.description}</dd></div>
          <div><dt className="text-xs text-[hsl(var(--muted-foreground))]">Billing period</dt><dd className="mt-1 font-semibold">{item.period} · {item.academicYear}</dd></div>
          <div><dt className="text-xs text-[hsl(var(--muted-foreground))]">Payment method</dt><dd className="mt-1 font-semibold capitalize">{item.paymentMethod}</dd></div>
          <div><dt className="text-xs text-[hsl(var(--muted-foreground))]">Amount paid</dt><dd className="mt-1 text-xl font-extrabold">{money(item.amountPaise)}</dd></div>
        </dl>
        <div className="mt-6 flex flex-wrap gap-3 print:hidden">
          <button className="btn btn-primary" onClick={() => window.print()}>Print receipt</button>
          <Link className="btn btn-muted" href="/fees">Back to fees</Link>
        </div>
      </article>
    </div>
  );
}
