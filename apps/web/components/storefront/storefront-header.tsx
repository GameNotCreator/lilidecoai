"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, ShoppingBag } from "lucide-react";
import Image from "next/image";
import { storeIdentity } from "@/lib/site";
import { useStorefrontCart } from "@/lib/storefront-cart";
import { cartQuantity } from "@/lib/storefront";

export function StorefrontHeader() {
  const path = usePathname();
  const { lines } = useStorefrontCart();
  const count = cartQuantity(lines);
  return (
    <header className="store-header">
      <div className="store-announcement">
        Art · Artisanat · Design · Mode & co
      </div>
      <div className="store-shell store-header-inner">
        <Link href="/" className="store-brand" aria-label="LiliDeco, accueil">
          <span className="store-logo-window">
            <Image
              src="/brand/lilideco-logo.png"
              width={674}
              height={674}
              alt="ByLiliDeco — Concept store"
              sizes="(max-width: 760px) 168px, 280px"
              loading="eager"
            />
          </span>
        </Link>
        <nav aria-label="Navigation principale" className="store-nav">
          <Link href="/" aria-current={path === "/" ? "page" : undefined}>
            La boutique
          </Link>
          <Link href="/#maison" className="store-about-link">
            L’esprit By Lili
          </Link>
          <Link
            href="/panier"
            className="store-cart-link"
            aria-current={path === "/panier" ? "page" : undefined}
          >
            <ShoppingBag size={18} aria-hidden="true" />
            <span>Panier</span>
            <span
              className="store-cart-count"
              aria-label={`${count} article${count > 1 ? "s" : ""}`}
            >
              {count}
            </span>
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function StorefrontFooter() {
  return (
    <footer className="store-footer">
      <div className="store-shell store-footer-inner">
        <div>
          <Link
            href="/"
            className="store-footer-brand"
            aria-label="ByLiliDeco, accueil"
          >
            <Image
              src="/brand/lilideco-monogram.png"
              width={72}
              height={72}
              alt="By L"
            />
          </Link>
          <p>ByLiliDeco · Concept store</p>
        </div>
        <nav aria-label="La boutique" className="store-footer-links">
          <a href={`tel:${storeIdentity.telephone}`}>+216 22 300 600</a>
          <a
            href={storeIdentity.instagram}
            target="_blank"
            rel="noopener noreferrer"
          >
            Instagram <ArrowUpRight size={14} aria-hidden="true" />
          </a>
          <a
            href={storeIdentity.facebook}
            target="_blank"
            rel="noopener noreferrer"
          >
            Facebook <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </nav>
        <nav
          aria-label="Informations et espace boutique"
          className="store-footer-links"
        >
          <Link href="/terms">Conditions d’utilisation</Link>
          <Link href="/privacy">Confidentialité</Link>
          <Link href="/mentions-legales">Mentions légales</Link>
          <Link href="/admin">
            Espace boutique <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </nav>
      </div>
    </footer>
  );
}
