import type { Metadata, Viewport } from "next";
import { Footer } from "@/components/Footer";
import { ThemeProvider } from "@/components/ThemeProvider";
import { THEME_BOOT } from "@/lib/theme";
import { ViewportProvider } from "@/components/ViewportProvider";
import { AppShell } from "@/components/AppShell";
import { Overlays } from "@/components/Overlays";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted webfonts. These were next/font/google, which fetches from Google at BUILD time; on
// 2026-10-15 that failed intermittently on Vercel and in CI (Turbopack "Can't resolve
// '@vercel/turbopack-next/internal/font/google/font'") while the same commit built locally. The
// files are committed under app/fonts/, so the build needs no package and no network. Where each
// file came from, its sha256 and its licence: app/fonts/README.md.
//
// Each call reproduces the @font-face set the Google version emitted for its preloaded subset:
//   - the CSS variable names are unchanged. The family NAME inside each one is now the const name
//     ("inter", "notoSansThai", ...), not Google's. Do not "fix" that with a font-family
//     declaration: Turbopack applies it to the @font-face but still writes the const name into
//     the variable, so every multi-word family ends up pointing at a face that does not exist;
//   - unicode-range is Google's range for that subset, verbatim (the fontsource CSS carries the
//     same string), so a glyph outside it falls through to the next family in the stack;
//   - the variable files are listed once per weight, as Google listed them: one file, one
//     @font-face per weight. A weight-range face would render Thai `font-bold` at a true 700
//     where it renders at 600 today.
//   - adjustFontFallback names the metric-matched local fallback Google's metrics used (Arial for
//     sans and mono, Times New Roman for serif). Next computes the overrides from the file, not
//     Google's figures, and that fallback face draws whatever the shipped subset lacks and
//     Arial/Times has, so ← → ≤ ≥ change size in all three stacks: sans +0.7% (size-adjust 107.12% -> 107.89%),
//     heading -1.2% (96.98% -> 95.82%), mono -2.3% (134.59% -> 131.49%);
//   - only latin + thai ship. Greek (α β μ Δ) now comes from that Arial/Times fallback in every
//     stack, which in mono means proportional Arial. app/fonts/README.md says how to add it back.
// No `fallback` list here on purpose: these variables are composed in globals.css, Latin family
// first, and a generic family placed here would sit in front of the Thai face in that stack.
const inter = localFont({
  src: "./fonts/inter-latin-wght-normal.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-inter",
  display: "swap",
  adjustFontFallback: "Arial",
  declarations: [
    { prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  ],
});

const cormorantGaramond = localFont({
  src: [
    { path: "./fonts/cormorant-garamond-latin-wght-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/cormorant-garamond-latin-wght-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-cormorant",
  display: "swap",
  adjustFontFallback: "Times New Roman",
  declarations: [
    { prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  ],
});

const jetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono-latin-400-normal.woff2",
  weight: "400",
  style: "normal",
  variable: "--font-jetbrains",
  display: "swap",
  adjustFontFallback: "Arial",
  declarations: [
    { prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  ],
});

const notoSansThai = localFont({
  src: [
    { path: "./fonts/noto-sans-thai-thai-wght-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/noto-sans-thai-thai-wght-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/noto-sans-thai-thai-wght-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-noto-sans-thai",
  display: "swap",
  adjustFontFallback: "Arial",
  declarations: [
    { prop: "unicode-range", value: "U+02D7, U+0303, U+0331, U+0E01-0E5B, U+200C-200D, U+25CC" },
  ],
});

const notoSerifThai = localFont({
  src: [
    { path: "./fonts/noto-serif-thai-thai-wght-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/noto-serif-thai-thai-wght-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-noto-serif-thai",
  display: "swap",
  adjustFontFallback: "Times New Roman",
  declarations: [
    { prop: "unicode-range", value: "U+02D7, U+0303, U+0331, U+0E01-0E5B, U+200C-200D, U+25CC" },
  ],
});

export const metadata: Metadata = {
  title: "CLICS Audit Dashboard",
  description: "CLICS — Case-based Learning Intelligence Credit System",
};

// viewportFit:'cover' is required for the env(safe-area-inset-*) used by the responsive primitives
// (globals.css) to be non-zero on notched / home-indicator devices (tablets auditors may use).
//
// themeColor is the media form (generate-viewport.md) so the browser chrome follows the OS on first
// paint; the values mirror --background (:root / .dark in globals.css). lib/theme.ts applyTheme()
// rewrites these metas when the person picks Light/Dark against the OS.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f5" },
    { media: "(prefers-color-scheme: dark)", color: "#181715" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="th"
      suppressHydrationWarning
      className={`${inter.variable} ${cormorantGaramond.variable} ${jetbrainsMono.variable} ${notoSansThai.variable} ${notoSerifThai.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var e=document.documentElement;" + THEME_BOOT +
              // Same no-FOUC reason as the theme: without this a reader who chose English watches
              // the Thai copy of /manual paint first and then swap.
              "if(localStorage.getItem('clics_manual_lang')==='en'){e.setAttribute('data-manual-lang','en');e.setAttribute('lang','en');}" +
              "}catch(e){}})();",
          }}
        />
        <ThemeProvider>
          <ViewportProvider>
            <AppShell>
              {children}
              <Footer />
            </AppShell>
            <Overlays />
          </ViewportProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
