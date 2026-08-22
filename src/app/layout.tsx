import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voice Marks — Capture to Output Pack",
  description:
    "Record live conversations or paste a transcript, mark key moments, and turn raw voice capture into a reusable summary, action list, follow-up draft, and CRM note.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
