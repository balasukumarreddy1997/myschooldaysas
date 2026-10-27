import type { Metadata } from "next";
import "../index.css";
import { SCHOOL_NAME, PLATFORM_NAME } from "@/lib/branding";

export const metadata: Metadata = {
  title: `${SCHOOL_NAME} | ${PLATFORM_NAME}`,
  description: `${SCHOOL_NAME} school operations and live learning.`,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
