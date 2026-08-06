import type { Metadata } from "next";
import { Cormorant_Garamond, Manrope } from "next/font/google";
import Link from "next/link";
import { ScanLine } from "lucide-react";
import { serverConfig } from "@/lib/server/config";
import "./globals.css";

const sans = Manrope({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const serif = Cormorant_Garamond({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Lili Deco AI — Essayez un objet chez vous",
    template: "%s — Lili Deco AI",
  },
  description:
    "Ajoutez une photo de votre pièce et visualisez un objet à la bonne place.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr" data-scroll-behavior="smooth">
      <body className={`${sans.variable} ${serif.variable}`}>
        <header className="site-header simple-site-header">
          <div className="container site-header-inner">
            <Link className="brand simple-brand" href="/">
              <span className="brand-mark">L</span>
              <span>Lili Deco AI</span>
            </Link>
            <nav className="simple-nav" aria-label="Navigation principale">
              {serverConfig.demoMode && <span className="demo-chip">Démo</span>}
              <Link className="simple-nav-link" href="/">
                <ScanLine size={18} />
                <span>Visualiser</span>
              </Link>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
