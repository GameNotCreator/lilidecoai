import type { Metadata } from "next";
import { Cormorant_Garamond, Manrope } from "next/font/google";
import Link from "next/link";
import { ArrowUpRight, UserRound } from "lucide-react";
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
    default: "Project Visualizer — Voir avant d’acheter",
    template: "%s — Project Visualizer",
  },
  description:
    "Visualisez un objet décoratif chez vous, à la bonne échelle, avant de l’acheter.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr" data-scroll-behavior="smooth">
      <body className={`${sans.variable} ${serif.variable}`}>
        {serverConfig.demoMode && (
          <div className="demo-banner">
            <span>Mode démonstration</span>
            <span aria-hidden="true">•</span>
            <span>Aucune génération OpenAI sans clé serveur</span>
          </div>
        )}
        <header className="site-header">
          <div className="container site-header-inner">
            <Link className="brand" href="/">
              <span className="brand-mark">V</span>
              <span>Project Visualizer</span>
            </Link>
            <nav className="main-nav" aria-label="Navigation principale">
              <Link href="/#fonctionnement">Comment ça marche</Link>
              <Link href="/pricing">Tarifs</Link>
              <Link href="/demo">Démo</Link>
              <Link href="/app">Espace marchand</Link>
            </nav>
            <Link className="button header-cta" href="/demo">
              Essayer maintenant <ArrowUpRight size={16} />
            </Link>
            <Link
              className="button secondary mobile-nav"
              href="/app"
              aria-label="Espace marchand"
            >
              <UserRound size={18} />
              <span>Compte</span>
            </Link>
          </div>
        </header>
        {children}
        <footer className="site-footer">
          <div className="container footer-grid">
            <div>
              <div className="brand">
                <span className="brand-mark">V</span>
                <span>Project Visualizer</span>
              </div>
              <p>La bonne échelle. Le bon choix. Moins de retours.</p>
            </div>
            <div className="footer-links">
              <Link href="/terms">Conditions</Link>
              <Link href="/privacy">Confidentialité</Link>
              <Link href="/pricing">Tarifs</Link>
              <Link href="/login">Connexion</Link>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
