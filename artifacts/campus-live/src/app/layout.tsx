import type { Metadata } from "next";
import "../index.css";

export const metadata: Metadata = {
  title: "Campus Live",
  description: "School operations and live learning in one place.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
