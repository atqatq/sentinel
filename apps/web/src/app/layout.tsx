import type { Metadata } from "next"

import "./globals.css"

export const metadata: Metadata = {
  title: "Sentinel",
  description:
    "Multi-tenant supply-chain planning, sourcing and intelligence layer over Precoro.",
}

/*
 * Root layout — the two cascade roots (README §Design tokens: theme and
 * density each cascade from a single root attribute, never through props).
 * Dark is the default; ThemeToggle and the density control flip the same
 * attributes on documentElement at runtime.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-sds-theme="dark" data-sds-density="comfortable">
      <body className="min-h-screen bg-canvas font-sans text-text antialiased">
        {children}
      </body>
    </html>
  )
}
