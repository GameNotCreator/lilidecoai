"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Clipboard,
  Clock3,
  Code2,
  DollarSign,
  ExternalLink,
  Image as ImageIcon,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { Product } from "@lili/types";
import { Button } from "@lili/ui";
import { api, getProducts } from "@/lib/api";

interface RenderRow {
  id: string;
  status: string;
  provider: string | null;
  model: string | null;
  resultUrl: string | null;
  qualityScore: number | null;
  creditCharged: boolean;
  createdAt: string;
}

interface SessionInfo {
  role: string;
  organization?: { name: string; slug: string } | null;
}

export function WorkspaceIdentity() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  useEffect(() => {
    void api<SessionInfo>("/v1/auth/me").then(setSession);
  }, []);
  const name = session?.organization?.name ?? "Atelier";
  const initials =
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "LD";
  return (
    <div className="workspace-chip">
      <span>{initials}</span>
      <div>
        <strong>{name}</strong>
        <small>{session ? "Organisation MongoDB" : "Chargement…"}</small>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  useEffect(() => {
    void api<SessionInfo>("/v1/auth/me").then(setSession);
  }, []);
  const name = session?.organization?.name ?? "Votre atelier";
  const slug = session?.organization?.slug ?? "chargement";
  return (
    <SimpleAppPage
      eyebrow="Paramètres"
      title={`${name}.`}
      text="Les frontières de l’organisation restent appliquées à chaque requête et chaque asset."
      cards={[
        {
          title: "Organisation",
          text: `Slug public : ${slug}. Rôle actuel : ${session?.role ?? "—"}.`,
        },
        {
          title: "Confidentialité",
          text: "Photos de pièce supprimées après 24 heures par défaut.",
        },
        {
          title: "Origines du widget",
          text: "Configurez une liste restrictive avant l’ouverture publique.",
        },
      ]}
    />
  );
}

export function RendersPage() {
  const [renders, setRenders] = useState<RenderRow[]>([]);
  useEffect(() => {
    void api<RenderRow[]>("/v1/renders").then(setRenders);
  }, []);
  return (
    <>
      <AppHead
        eyebrow="Historique"
        title="Rendus & tentatives."
        text="Chaque sortie garde son provider, modèle, coût, durée et décision qualité."
      />
      <div className="app-card">
        <div className="render-list">
          {renders.length === 0 && (
            <Empty text="Aucun rendu pour l’instant. Lancez la démo pour créer le premier." />
          )}
          {renders.map((render) => (
            <div className="render-row" key={render.id}>
              <div className="render-mini">
                {render.resultUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={render.resultUrl} alt="" />
                ) : (
                  <ImageIcon size={19} />
                )}
              </div>
              <div>
                <strong>Rendu {render.id.slice(0, 8)}</strong>
                <small>
                  {new Date(render.createdAt).toLocaleString("fr-FR")}
                </small>
              </div>
              <span>
                {render.provider ?? "—"}
                <small>{render.model ?? ""}</small>
              </span>
              <span className={`status status-${render.status}`}>
                {render.status}
              </span>
              <strong>
                {render.qualityScore
                  ? `${Math.round(render.qualityScore * 100)}%`
                  : "—"}
              </strong>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

export function WidgetPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState("");
  const [merchantSlug, setMerchantSlug] = useState("atelier-lili");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void Promise.all([
      getProducts(),
      api<{ organization?: { slug?: string } | null }>("/v1/auth/me"),
    ]).then(([values, session]) => {
      setProducts(values);
      setProductId(values[0]?.id ?? "");
      setMerchantSlug(session.organization?.slug ?? "atelier-lili");
    });
  }, []);
  const snippet = useMemo(
    () =>
      `<script src="${typeof window === "undefined" ? "https://votre-domaine" : window.location.origin}/widget.js"\n  data-merchant="${merchantSlug}"\n  data-product="${productId || "PRODUCT_ID"}"\n  data-label="Voir chez moi"\n  async></script>`,
    [merchantSlug, productId],
  );
  return (
    <>
      <AppHead
        eyebrow="Widget marchand"
        title="La visualisation, sur votre boutique."
        text="Un script sans secret ouvre le studio responsive dans une modal isolée."
      />
      <div className="app-grid">
        <div className="app-card app-card-wide">
          <div className="form-section-title">
            <span>01</span>
            <div>
              <h2>Installation HTML</h2>
              <p>Collez ce fragment près du bouton d’achat.</p>
            </div>
          </div>
          <div className="field">
            <label htmlFor="widget-product">Produit</label>
            <select
              id="widget-product"
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
            >
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </div>
          <pre className="code-block">
            <code>{snippet}</code>
          </pre>
          <Button
            className="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(snippet);
              setCopied(true);
            }}
          >
            {copied ? <Check size={17} /> : <Clipboard size={17} />}
            {copied ? "Copié" : "Copier le code"}
          </Button>
        </div>
        <div className="app-card widget-preview-card">
          <span className="eyebrow">Aperçu</span>
          <div className="mock-product-page">
            <div />
            <strong>Objet signature</strong>
            <span>Pièce artisanale · 189 TND</span>
            <button>
              Voir chez moi <ExternalLink size={15} />
            </button>
            <button className="mock-buy">Ajouter au panier</button>
          </div>
          <ul className="clean-list">
            <li>
              <ShieldCheck size={16} /> Origines autorisées
            </li>
            <li>
              <Code2 size={16} /> Aucun secret côté navigateur
            </li>
            <li>
              <Sparkles size={16} /> Événements métier intégrés
            </li>
          </ul>
        </div>
      </div>
    </>
  );
}

interface CreditData {
  balance: number;
  transactions: Array<{
    id: string;
    type: string;
    amount: number;
    status: string;
    balanceAfter: number;
    createdAt: string;
  }>;
}

export function CreditsPage() {
  const [data, setData] = useState<CreditData>({
    balance: 0,
    transactions: [],
  });
  const [message, setMessage] = useState("");
  const refresh = () => void api<CreditData>("/v1/credits").then(setData);
  useEffect(refresh, []);
  async function buy(pack: "starter" | "studio" | "scale") {
    const result = await api<{ credited: boolean }>("/v1/checkout", {
      method: "POST",
      body: JSON.stringify({
        pack,
        idempotencyKey: `checkout-${crypto.randomUUID()}`,
      }),
    });
    setMessage(
      result.credited
        ? "Pack crédité en mode démonstration."
        : "Checkout créé.",
    );
    refresh();
  }
  return (
    <>
      <AppHead
        eyebrow="Portefeuille"
        title={`${data.balance} crédits disponibles.`}
        text="Une réservation n’altère pas le solde. Le débit n’est capturé qu’après un rendu accepté."
      />
      {message && <div className="success-note">{message}</div>}
      <div className="credit-pack-grid">
        <CreditPack
          name="Starter"
          credits={20}
          price="29 TND"
          onClick={() => void buy("starter")}
        />
        <CreditPack
          name="Studio"
          credits={75}
          price="79 TND"
          featured
          onClick={() => void buy("studio")}
        />
        <CreditPack
          name="Scale"
          credits={220}
          price="179 TND"
          onClick={() => void buy("scale")}
        />
      </div>
      <div className="app-card transaction-card">
        <div className="app-card-title">
          <div>
            <span>Ledger</span>
            <h2>Derniers mouvements</h2>
          </div>
        </div>
        {data.transactions.map((transaction) => (
          <div className="transaction-row" key={transaction.id}>
            <span className="transaction-icon">
              <Sparkles size={16} />
            </span>
            <div>
              <strong>{transaction.type.replaceAll("_", " ")}</strong>
              <small>
                {new Date(transaction.createdAt).toLocaleString("fr-FR")}
              </small>
            </div>
            <strong
              className={transaction.amount >= 0 ? "positive" : "negative"}
            >
              {transaction.amount > 0 ? "+" : ""}
              {transaction.amount}
            </strong>
            <span>Solde {transaction.balanceAfter}</span>
          </div>
        ))}
      </div>
    </>
  );
}

interface AdminOverview {
  renders: number;
  succeeded: number;
  successRate: number;
  recentEstimatedCostUsd: number;
  attempts: Array<{
    id: string;
    provider: string;
    model: string;
    status: string;
    latencyMs: number;
    estimatedCostUsd: number;
    createdAt: string;
  }>;
}

export function AdminPage() {
  const [data, setData] = useState<AdminOverview | null>(null);
  useEffect(() => {
    void api<AdminOverview>("/v1/admin/overview", {
      headers: { "X-User-Role": "platform_admin" },
    }).then(setData);
  }, []);
  return (
    <main className="admin-page">
      <div className="container">
        <AppHead
          eyebrow="Administration"
          title="Opérations & qualité."
          text="Une vue dédiée aux providers, tentatives, coûts, erreurs et audits."
        />
        <div className="metric-grid">
          <AdminMetric
            icon={<ImageIcon />}
            label="Rendus"
            value={String(data?.renders ?? 0)}
          />
          <AdminMetric
            icon={<Check />}
            label="Acceptés"
            value={String(data?.succeeded ?? 0)}
          />
          <AdminMetric
            icon={<Clock3 />}
            label="Succès"
            value={`${Math.round((data?.successRate ?? 0) * 100)}%`}
          />
          <AdminMetric
            icon={<DollarSign />}
            label="Coût estimé"
            value={`$${(data?.recentEstimatedCostUsd ?? 0).toFixed(3)}`}
          />
        </div>
        <div className="app-card">
          <div className="app-card-title">
            <div>
              <span>Observabilité</span>
              <h2>Tentatives récentes</h2>
            </div>
          </div>
          <div className="admin-table">
            <div className="admin-table-head">
              <span>Provider / modèle</span>
              <span>Statut</span>
              <span>Latence</span>
              <span>Coût</span>
            </div>
            {data?.attempts.map((attempt) => (
              <div className="admin-table-row" key={attempt.id}>
                <span>
                  <strong>{attempt.provider}</strong>
                  <small>{attempt.model}</small>
                </span>
                <span className={`status status-${attempt.status}`}>
                  {attempt.status}
                </span>
                <span>{attempt.latencyMs} ms</span>
                <span>${Number(attempt.estimatedCostUsd).toFixed(4)}</span>
              </div>
            ))}
            {!data?.attempts.length && (
              <Empty text="Aucune tentative enregistrée." />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

export function SimpleAppPage({
  eyebrow,
  title,
  text,
  cards,
}: {
  eyebrow: string;
  title: string;
  text: string;
  cards: Array<{ title: string; text: string; value?: string }>;
}) {
  return (
    <>
      <AppHead eyebrow={eyebrow} title={title} text={text} />
      <div className="simple-card-grid">
        {cards.map((card) => (
          <article className="app-card" key={card.title}>
            {card.value && (
              <strong className="simple-value">{card.value}</strong>
            )}
            <h2>{card.title}</h2>
            <p className="muted">{card.text}</p>
          </article>
        ))}
      </div>
    </>
  );
}

function AppHead({
  eyebrow,
  title,
  text,
}: {
  eyebrow: string;
  title: string;
  text: string;
}) {
  return (
    <header className="app-page-head">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
    </header>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

function CreditPack({
  name,
  credits,
  price,
  featured = false,
  onClick,
}: {
  name: string;
  credits: number;
  price: string;
  featured?: boolean;
  onClick: () => void;
}) {
  return (
    <article className={`credit-pack ${featured ? "featured" : ""}`}>
      {featured && <span className="badge badge-positive">Le plus choisi</span>}
      <h2>{name}</h2>
      <strong>{credits}</strong>
      <span>rendus</span>
      <p>{price}</p>
      <Button className={featured ? "" : "secondary"} onClick={onClick}>
        Choisir
      </Button>
    </article>
  );
}

function AdminMetric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <article className="metric-card">
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}
