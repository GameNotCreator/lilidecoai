import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./legal-document.module.css";

const documents = [
  { href: "/terms", label: "Conditions d’utilisation" },
  { href: "/privacy", label: "Confidentialité" },
  { href: "/mentions-legales", label: "Mentions légales" },
];

export function LegalDocument({
  title,
  intro,
  current,
  children,
}: {
  title: string;
  intro: string;
  current: string;
  children: ReactNode;
}) {
  return (
    <main id="main-content" className={styles.main}>
      <div className={styles.container}>
        <Link href="/" className={styles.back}>
          <span aria-hidden="true">←&nbsp;</span>Retour à la boutique
        </Link>
        <header className={styles.header}>
          <p className={styles.eyebrow}>
            <span translate="no">ByLiliDeco</span> · Informations pratiques
          </p>
          <h1>{title}</h1>
          <p className={styles.intro}>{intro}</p>
          <p className={styles.date}>
            Mise à jour le{" "}
            <time dateTime="2026-09-29">
              {new Intl.DateTimeFormat("fr-FR", {
                dateStyle: "long",
                timeZone: "UTC",
              }).format(new Date("2026-09-29T12:00:00Z"))}
            </time>
          </p>
        </header>
        <nav className={styles.navigation} aria-label="Informations légales">
          {documents.map(({ href, label }) => (
            <Link
              href={href}
              key={href}
              aria-current={current === href ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
        <article className={styles.article}>{children}</article>
      </div>
    </main>
  );
}

export function LegalContact() {
  return (
    <p>
      Pour joindre ByLiliDeco, appelez le{" "}
      <a className="link" href="tel:+21622300600">
        +216 22 300 600
      </a>{" "}
      ou écrivez à{" "}
      <a className="link break-all" href="mailto:bylilideco.tunisie@gmail.com">
        bylilideco.tunisie@gmail.com
      </a>. Vous pouvez aussi retrouver la marque sur{" "}
      <a
        className="link"
        href="https://www.instagram.com/bylilideco/"
        rel="noreferrer"
      >
        Instagram @bylilideco
      </a>
      . Pour une question concernant une photo, indiquez la date et la référence
      de votre visualisation si vous en disposez, sans renvoyer votre photo ni
      vos identifiants de connexion.
    </p>
  );
}
