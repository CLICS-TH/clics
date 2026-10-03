import type { Metadata, Viewport } from "next";
import { Footer } from "@/components/Footer";
import { ThemeProvider } from "@/components/ThemeProvider";
import { THEME_BOOT } from "@/lib/theme";
import { ViewportProvider } from "@/components/ViewportProvider";
import { AppShell } from "@/components/AppShell";
import { Overlays } from "@/components/Overlays";
import {
  Inter,
  Cormorant_Garamond,
  JetBrains_Mono,
  Noto_Sans_Thai,
  Noto_Serif_Thai,
} from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const cormorantGaramond = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin"],
  weight: ["500", "600"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400"],
});

const notoSansThai = Noto_Sans_Thai({
  variable: "--font-noto-sans-thai",
  subsets: ["thai"],
  weight: ["400", "500", "600"],
});

const notoSerifThai = Noto_Serif_Thai({
  variable: "--font-noto-serif-thai",
  subsets: ["thai"],
  weight: ["500", "600"],
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
