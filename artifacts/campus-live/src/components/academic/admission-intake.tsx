"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAvailableStudentsQueryKey,
  getGetSectionsQueryKey,
  getGetStudentsQueryKey,
  useCreateStudentAdmissions,
  usePreviewStudentAdmissions,
} from "@workspace/api-client-react";
import type { SectionSummary } from "@workspace/api-client-react";
import { FileUp, UserPlus } from "lucide-react";

type AdmissionRow = { name: string; email: string; admissionNo: string };

function parseAdmissionCsv(text: string): AdmissionRow[] {
  const source = text.replace(/^\uFEFF/, "");
  const table: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((value) => value.trim())) table.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("The CSV has an unclosed quoted value.");
  row.push(cell.replace(/\r$/, ""));
  if (row.some((value) => value.trim())) table.push(row);
  if (table.length < 2) throw new Error("Add a header and at least one student row.");

  const headers = table[0]!.map((value) => value.trim().toLowerCase().replace(/[\s_-]/g, ""));
  const nameIndex = headers.indexOf("name");
  const emailIndex = headers.indexOf("email");
  const admissionIndex = headers.findIndex((value) => value === "admissionno" || value === "admissionnumber");
  if ([nameIndex, emailIndex, admissionIndex].some((index) => index < 0)) {
    throw new Error("CSV headers must include name, email, and admissionNo.");
  }
  const rows = table.slice(1).map((values) => ({
    name: values[nameIndex] ?? "",
    email: values[emailIndex] ?? "",
    admissionNo: values[admissionIndex] ?? "",
  }));
  if (rows.length > 20) throw new Error("A batch can contain at most 20 students.");
  return rows;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The request could not be completed.";

export function AdmissionIntake({ sections }: { sections: SectionSummary[] }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [sectionId, setSectionId] = useState("");
  const [academicYear, setAcademicYear] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [admissionNo, setAdmissionNo] = useState("");
  const [csvText, setCsvText] = useState("");
  const [csvError, setCsvError] = useState("");
  const [credentials, setCredentials] = useState<Array<{
    id: string;
    name: string;
    email: string;
    admissionNo: string;
    temporaryPassword: string;
    temporaryPasswordExpiresAt: string;
  }> | null>(null);
  const preview = usePreviewStudentAdmissions();
  const create = useCreateStudentAdmissions({
    mutation: {
      onSuccess: (result) => {
        setCredentials(result.items);
        preview.reset();
        queryClient.invalidateQueries({ queryKey: getGetStudentsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetSectionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAvailableStudentsQueryKey() });
      },
    },
  });

  const clearResults = () => {
    preview.reset();
    create.reset();
    setCredentials(null);
    setCsvError("");
  };

  const admissionRows = (): AdmissionRow[] => {
    if (mode === "single") return [{ name, email, admissionNo }];
    return parseAdmissionCsv(csvText);
  };

  function submitPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearResults();
    let rows: AdmissionRow[];
    try {
      rows = admissionRows();
    } catch (error) {
      setCsvError(errorMessage(error));
      return;
    }
    if (!sectionId || academicYear.trim().length < 4) return;
    preview.mutate({
      data: {
        sectionId,
        academicYear: academicYear.trim(),
        rows,
      },
    });
  }

  async function loadCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setCsvError("");
    try {
      setCsvText(await file.text());
      clearResults();
    } catch {
      setCsvError("Could not read the selected CSV file.");
    }
    event.target.value = "";
  }

  function confirmAdmissions() {
    if (!preview.data?.valid) return;
    create.mutate({
      data: {
        sectionId: preview.data.sectionId,
        academicYear: preview.data.academicYear,
        rows: preview.data.items.map(({ name: rowName, email: rowEmail, admissionNo: rowAdmissionNo }) => ({
          name: rowName,
          email: rowEmail,
          admissionNo: rowAdmissionNo,
        })),
      },
    });
  }

  const selectedSection = sections.find((section) => section.id === sectionId);

  return (
    <section className="surface mb-5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 flex items-center gap-2 text-sm font-bold"><UserPlus size={16} /> New student admissions</h2>
          <p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">Create student accounts and enroll them together. Temporary passwords are shown once and expire in seven days.</p>
        </div>
        <div className="flex gap-1 rounded-lg bg-[hsl(var(--muted))] p-1" role="group" aria-label="Admission type">
          <button type="button" className={`rounded-md px-3 py-1.5 text-xs font-semibold ${mode === "single" ? "bg-[hsl(var(--card))] shadow-sm" : ""}`} aria-pressed={mode === "single"} onClick={() => { setMode("single"); clearResults(); }}>One student</button>
          <button type="button" className={`rounded-md px-3 py-1.5 text-xs font-semibold ${mode === "bulk" ? "bg-[hsl(var(--card))] shadow-sm" : ""}`} aria-pressed={mode === "bulk"} onClick={() => { setMode("bulk"); clearResults(); }}>CSV batch</button>
        </div>
      </div>

      <form className="mt-4 grid gap-3 border-t border-[hsl(var(--border))] pt-4 md:grid-cols-2" onSubmit={submitPreview}>
        <label className="text-xs font-semibold">Section
          <select className="field mt-1.5" required value={sectionId} onChange={(event) => { setSectionId(event.target.value); clearResults(); }}>
            <option value="">Select section</option>
            {sections.map((section) => <option key={section.id} value={section.id}>{section.className} · {section.name}</option>)}
          </select>
          {selectedSection && <span className="mt-1 block font-normal text-[hsl(var(--muted-foreground))]">
            {selectedSection.studentCount} active · {selectedSection.capacity == null ? "no capacity limit" : `capacity ${selectedSection.capacity}`}
          </span>}
        </label>
        <label className="text-xs font-semibold">Academic year
          <input className="field mt-1.5" required minLength={4} maxLength={24} value={academicYear} placeholder="e.g. 2026-27" onChange={(event) => { setAcademicYear(event.target.value); clearResults(); }} />
        </label>

        {mode === "single" ? <>
          <label className="text-xs font-semibold">Student name
            <input className="field mt-1.5" required maxLength={120} value={name} onChange={(event) => { setName(event.target.value); clearResults(); }} />
          </label>
          <label className="text-xs font-semibold">Student email
            <input className="field mt-1.5" required type="email" maxLength={254} value={email} onChange={(event) => { setEmail(event.target.value); clearResults(); }} />
          </label>
          <label className="text-xs font-semibold md:col-span-2">Admission number
            <input className="field mt-1.5" required maxLength={40} value={admissionNo} onChange={(event) => { setAdmissionNo(event.target.value); clearResults(); }} />
          </label>
        </> : <div className="md:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-xs font-semibold" htmlFor="admission-csv">CSV rows</label>
            <label className="btn min-h-8 cursor-pointer px-3 text-xs">
              <FileUp size={14} /> Upload CSV
              <input id="admission-csv" className="sr-only" type="file" accept=".csv,text/csv" onChange={loadCsv} />
            </label>
          </div>
          <textarea className="field mt-1.5 min-h-32 font-mono text-xs" value={csvText} onChange={(event) => { setCsvText(event.target.value); clearResults(); }} placeholder={"name,email,admissionNo\nAsha Rao,asha@example.com,ADM-1001\nRavi Das,ravi@example.com,ADM-1002"} />
          <p className="mb-0 mt-1 text-xs text-[hsl(var(--muted-foreground))]">Include the header row. Up to 20 students per batch. Quoted CSV values are supported.</p>
        </div>}

        {csvError && <p role="alert" className="m-0 text-xs text-[hsl(var(--destructive))] md:col-span-2">{csvError}</p>}
        {preview.isError && <p role="alert" className="m-0 text-xs text-[hsl(var(--destructive))] md:col-span-2">{errorMessage(preview.error)}</p>}
        <div className="flex justify-end md:col-span-2">
          <button className="btn btn-primary min-h-9 px-4 text-xs" disabled={!sectionId || academicYear.trim().length < 4 || preview.isPending || create.isPending}>
            {preview.isPending ? "Checking…" : "Preview admissions"}
          </button>
        </div>
      </form>

      {preview.data && <div className="mt-4 rounded-lg border border-[hsl(var(--border))] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold" role="status">
            {preview.data.valid ? `${preview.data.items.length} student(s) ready` : "Resolve the issues below before confirming"}
            {" · "}
            {preview.data.seatsAvailable == null ? "unlimited seats" : `${preview.data.seatsAvailable} seat(s) available`}
          </div>
          {preview.data.valid && <button type="button" className="btn btn-primary min-h-8 px-3 text-xs" disabled={create.isPending} onClick={confirmAdmissions}>
            {create.isPending ? "Creating accounts…" : "Confirm and create"}
          </button>}
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[540px] text-left text-xs">
            <thead><tr className="text-[hsl(var(--muted-foreground))]"><th className="p-2">Row</th><th className="p-2">Name</th><th className="p-2">Email</th><th className="p-2">Admission no.</th></tr></thead>
            <tbody>{preview.data.items.map((item) => <tr key={item.row} className="border-t border-[hsl(var(--border))]"><td className="p-2">{item.row}</td><td className="p-2">{item.name}</td><td className="p-2">{item.email}</td><td className="p-2">{item.admissionNo}</td></tr>)}</tbody>
          </table>
        </div>
        {!!preview.data.errors.length && <ul className="mb-0 mt-2 space-y-1 text-xs text-[hsl(var(--destructive))]">
          {preview.data.errors.map((issue, index) => <li key={`${issue.row}-${issue.field}-${index}`}>Row {issue.row} · {issue.field}: {issue.message}</li>)}
        </ul>}
      </div>}

      {create.isError && <p role="alert" className="mb-0 mt-3 text-xs text-[hsl(var(--destructive))]">{errorMessage(create.error)} Please preview the batch again before retrying.</p>}
      {credentials && <div className="mt-4 rounded-lg border border-[hsl(var(--border))] p-3">
        <p className="mb-2 text-xs font-bold">Accounts created. Copy these temporary passwords now; they will not be shown again.</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-left text-xs">
            <thead><tr className="text-[hsl(var(--muted-foreground))]"><th className="p-2">Name</th><th className="p-2">Email</th><th className="p-2">Admission no.</th><th className="p-2">Temporary password</th><th className="p-2">Expires</th></tr></thead>
            <tbody>{credentials.map((credential) => <tr key={credential.id} className="border-t border-[hsl(var(--border))]"><td className="p-2">{credential.name}</td><td className="p-2">{credential.email}</td><td className="p-2">{credential.admissionNo}</td><td className="p-2 font-mono select-all">{credential.temporaryPassword}</td><td className="p-2">{credential.temporaryPasswordExpiresAt.slice(0, 10)}</td></tr>)}</tbody>
          </table>
        </div>
      </div>}
    </section>
  );
}
