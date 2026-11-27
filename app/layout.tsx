import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const siteUrl =
  process.env.NEXT_PUBLIC_APP_URL?.trim() ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "GitGraph — Codebase Dependency Mapper",
    template: "%s | GitGraph",
  },
  description:
    "Turn any TypeScript, JavaScript, Python, or Go GitHub repository into an interactive dependency map with AST parsing, blast radius analysis, and AI explanations.",
  keywords: [
    "GitGraph",
    "codebase dependency map",
    "AST parser",
    "GitHub repository analyzer",
    "blast radius",
    "TypeScript",
    "JavaScript",
    "Python",
    "Go",
  ],
  openGraph: {
    title: "GitGraph — Codebase Dependency Mapper",
    description:
      "Turn any TypeScript, JavaScript, Python, or Go GitHub repository into an interactive dependency map with AST parsing, blast radius analysis, and AI explanations.",
    type: "website",
    siteName: "GitGraph",
  },
  twitter: {
    card: "summary_large_image",
    title: "GitGraph — Codebase Dependency Mapper",
    description:
      "Interactive dependency maps, blast radius analysis, and grounded AI explanations for TypeScript, JavaScript, Python, and Go repositories.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

// Clerk's components read the same tokens as the app, so they follow the
// theme control instead of the OS.
const clerkAppearance = {
  variables: {
    colorBackground: "var(--surface)",
    colorForeground: "var(--fg)",
    colorMutedForeground: "var(--fg-muted)",
    colorPrimary: "var(--accent)",
    colorPrimaryForeground: "var(--accent-fg)",
    colorInput: "var(--canvas)",
    colorInputForeground: "var(--fg)",
    colorNeutral: "var(--fg)",
    colorBorder: "var(--line)",
    fontFamily: "var(--font-geist-sans)",
    fontSize: "0.8125rem",
    borderRadius: "0.25rem",
  },
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex h-full flex-col">
        <ClerkProvider appearance={clerkAppearance}>{children}</ClerkProvider>
      </body>
    </html>
  );
}
