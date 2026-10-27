"use client";

import dynamic from "next/dynamic";
import { PLATFORM_NAME } from "@/lib/branding";

const CampusLiveApp = dynamic(() => import("@/App"), {
  ssr: false,
  loading: () => (
    <div className="grid min-h-[100dvh] place-items-center p-6">
      <div className="h-10 w-44 animate-pulse rounded-lg bg-[hsl(var(--muted))]" aria-label={`Loading ${PLATFORM_NAME}`} />
    </div>
  ),
});

export default function CampusLivePage() {
  return <CampusLiveApp />;
}
