import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kargo · Hiring Shortlist",
  description: "Ranked candidate shortlists with visible reasoning. Arjun makes every decision.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
