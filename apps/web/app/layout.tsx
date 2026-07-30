import type { Metadata } from "next";
import { Cormorant_Garamond, Manrope } from "next/font/google";
import Link from "next/link";
import { ArrowUpRight, Menu } from "lucide-react";
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
    <html lang="fr">
      <body className={`${sans.variable} ${serif.variable}`}>
        <div className="demo-banner">
          <span>Mode démonstration</span>
          <span aria-hidden="true">•</span>
          <span>Aucune génération OpenAI sans clé serveur</span>
        </div>
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
            <Link className="button" href="/demo">
              Essayer maintenant <ArrowUpRight size={16} />
            </Link>
            <button className="button secondary mobile-nav" aria-label="Ouvrir le menu">
              <Menu size={18} />
            </button>
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

