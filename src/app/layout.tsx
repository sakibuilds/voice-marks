import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voice Marks — Smart Recorder",
  description:
    "Record live conversations, interviews, podcasts, and panels with real-time captions. Tap to mark key moments and jump straight back to them.",
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