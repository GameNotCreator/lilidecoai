"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Boxes,
  ExternalLink,
  LayoutDashboard,
  LogOut,
  PlusCircle,
} from "lucide-react";

import { adminApi } from "@/lib/admin-client";

const links = [
  { href: "/admin", label: "Tableau de bord", icon: LayoutDashboard },
  { href: "/admin/produits", label: "Banque de produits", icon: Boxes },
  { href: "/admin/produits/nouveau", label: "Nouveau produit", icon: PlusCircle },
  { href: "/admin/operations", label: "Opérations IA", icon: Activity },
];

export function AdminShell({
  username,
  children,
}: {
  username: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  async function logout() {
    setLeaving(true);
    try {
      await adminApi("/session", { method: "DELETE" });
    } finally {
      router.replace("/admin/login");
      router.refresh();
    }
  }

  return (
    <div className="bo-surface">
      <aside className="bo-sidebar">
        <div className="bo-brand">
          <span>LD</span>
          <div>
            <strong>Back office</strong>
            <small>Lili Deco AI</small>
          </div>
        </div>
        <nav>
          {links.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={isActive(pathname, href) ? "active" : undefined}
            >
              <Icon size={17} /> {label}
            </Link>
          ))}
        </nav>
        <div className="bo-sidebar-footer">
          <Link className="bo-sidebar-link" href="/" target="_blank">
            <ExternalLink size={15} /> Voir le site
          </Link>
          <div className="bo-user">
            <span>{username.slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>{username}</strong>
              <small>Administrateur</small>
            </div>
          </div>
          <button
            className="bo-button bo-button-ghost bo-button-block"
            onClick={() => void logout()}
            disabled={leaving}
            type="button"
          >
            <LogOut size={16} /> Déconnexion
          </button>
        </div>
      </aside>
      <div className="bo-content">{children}</div>
    </div>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  if (href === "/admin/produits") {
    return pathname.startsWith("/admin/produits") &&
      pathname !== "/admin/produits/nouveau";
  }
  return pathname === href;
}
