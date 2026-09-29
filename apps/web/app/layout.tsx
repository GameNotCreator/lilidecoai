import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { siteOrigin, storeIdentity } from "@/lib/site";
import {
  StorefrontHeader,
  StorefrontFooter,
} from "@/components/storefront/storefront-header";
import "./globals.css";
import "@/components/storefront/storefront-theme.css";

const sans = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin()),
  ...(process.env.VERCEL_ENV === "preview"
    ? { robots: { index: false, follow: false } }
    : {}),
  title: {
    default: "ByLiliDeco — Art, artisanat & décoration",
    template: "%s — ByLiliDeco",
  },
  description: storeIdentity.description,
  icons: {
    icon: "/brand/lilideco-monogram.png",
    apple: "/brand/lilideco-monogram.png",
  },
  openGraph: {
    type: "website",
    locale: "fr_TN",
    siteName: storeIdentity.name,
    title: storeIdentity.name,
    description: storeIdentity.description,
    images: [
      {
        url: "/brand/lilideco-logo.png",
        width: 674,
        height: 674,
        alt: "ByLiliDeco — Concept store",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: storeIdentity.name,
    description: storeIdentity.description,
    images: ["/brand/lilideco-logo.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr" data-theme="lilideco" data-scroll-behavior="smooth">
      <body className={sans.variable}>
        <a className="store-skip-link" href="#page-content">
          Aller au contenu
        </a>
        <StorefrontHeader />
        <div id="page-content" tabIndex={-1}>
          {children}
        </div>
        <StorefrontFooter />
      </body>
    </html>
  );
}
