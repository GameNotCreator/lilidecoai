import Link from "next/link";
import {
  BarChart3,
  Boxes,
  CreditCard,
  Gauge,
  History,
  LayoutTemplate,
  Settings,
  Sparkles,
} from "lucide-react";

const links = [
  { href: "/app", label: "Dashboard", icon: Gauge },
  { href: "/app/catalog", label: "Catalogue", icon: Boxes },
  { href: "/app/renders", label: "Rendus", icon: History },
  { href: "/app/widget", label: "Widget", icon: LayoutTemplate },
  { href: "/app/analytics", label: "Statistiques", icon: BarChart3 },
  { href: "/app/credits", label: "Crédits", icon: Sparkles },
  { href: "/app/billing", label: "Facturation", icon: CreditCard },
  { href: "/app/settings", label: "Paramètres", icon: Settings },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="app-surface">
      <aside className="app-sidebar">
        <div className="workspace-chip">
          <span>AL</span>
          <div><strong>Atelier Lili</strong><small>Organisation démo</small></div>
        </div>
        <nav>
          {links.map(({ href, label, icon: Icon }) => (
            <Link href={href} key={href}><Icon size={17} /> {label}</Link>
          ))}
        </nav>
        <Link className="admin-link" href="/admin">Administration →</Link>
      </aside>
      <div className="app-content">{children}</div>
    </main>
  );
}

