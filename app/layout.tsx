import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Design SKILL.md Generator",
  description: "Local design skill generator and verifier"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
