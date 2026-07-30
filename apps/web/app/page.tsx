import Link from "next/link";
import {
  ArrowRight,
  Box,
  Check,
  Eye,
  LockKeyhole,
  Ruler,
  Sparkles,
  Upload,
} from "lucide-react";

export default function HomePage() {
  return (
    <main>
      <section className="hero">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow">La visualisation qui rassure</span>
            <h1>
              Imaginez-le <em>chez vous.</em> À la bonne échelle.
            </h1>
            <p className="hero-copy">
              Transformez l’hésitation en évidence. Votre client place votre
              objet dans sa propre pièce, compare le rendu, puis achète avec
              confiance.
            </p>
            <div className="hero-actions">
              <Link className="button" href="/demo">
                Tester avec ma pièce <ArrowRight size={17} />
              </Link>
              <Link className="button secondary" href="/app">
                Je suis marchand
              </Link>
            </div>
          </div>
          <div className="room-visual" aria-label="Aperçu d’un vase placé dans un salon">
            <div className="console-table" />
            <div className="hero-vase" />
            <div className="visual-note">
              <strong>42 cm réels</strong>
              <br />
              Échelle calibrée • Ombre douce • Produit protégé
            </div>
          </div>
        </div>
      </section>

      <div className="container stats-strip">
        <div className="stat">
          <strong>1 objet</strong>
          <span className="muted">Une décision claire, sans distraction</span>
        </div>
        <div className="stat">
          <strong>24 h</strong>
          <span className="muted">Suppression automatique des photos</span>
        </div>
        <div className="stat">
          <strong>100%</strong>
          <span className="muted">Du produit catalogue préservé</span>
        </div>
      </div>

      <section className="section" id="fonctionnement">
        <div className="container">
          <div className="section-heading">
            <span className="eyebrow">Trois gestes</span>
            <h2>Du doute au coup de cœur.</h2>
            <p>
              Un parcours court, pensé pour le mobile et intégré à la fiche
              produit du marchand.
            </p>
          </div>
          <div className="steps-grid">
            <article className="card step-card">
              <span className="step-number">1</span>
              <h3>Photographiez</h3>
              <p>
                Téléversez une photo lumineuse de la pièce. Les métadonnées sont
                supprimées avant stockage.
              </p>
              <Upload size={25} color="var(--moss)" />
            </article>
            <article className="card step-card">
              <span className="step-number">2</span>
              <h3>Placez & calibrez</h3>
              <p>
                Choisissez une surface, ajustez l’objet et calibrez une mesure
                connue pour une échelle exacte.
              </p>
              <Ruler size={25} color="var(--moss)" />
            </article>
            <article className="card step-card">
              <span className="step-number">3</span>
              <h3>Visualisez</h3>
              <p>
                Comparez avant/après. La géométrie reste déterministe ; l’IA
                n’intègre que le contact et la lumière.
              </p>
              <Sparkles size={25} color="var(--moss)" />
            </article>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container trust-panel">
          <div>
            <span className="eyebrow" style={{ color: "#d8dec9" }}>
              Fidélité par conception
            </span>
            <h2>Le produit reste le produit.</h2>
          </div>
          <div className="trust-list">
            <TrustItem icon={<Ruler size={18} />} title="Géométrie déterministe">
              L’échelle, la perspective et le placement sont calculés, jamais
              improvisés.
            </TrustItem>
            <TrustItem icon={<LockKeyhole size={18} />} title="Pixels protégés">
              Silhouette, couleurs, motifs et proportions restent la source de
              vérité catalogue.
            </TrustItem>
            <TrustItem icon={<Eye size={18} />} title="Qualité mesurée">
              Chaque rendu reçoit des scores de fidélité et peut être rejeté
              avant facturation.
            </TrustItem>
            <TrustItem icon={<Box size={18} />} title="Mock mode complet">
              Le parcours entier fonctionne localement sans clé, GPU ou compte
              distant.
            </TrustItem>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container card" style={{ padding: "54px", textAlign: "center" }}>
          <Check size={28} color="var(--moss)" style={{ margin: "0 auto" }} />
          <h2 style={{ fontSize: "clamp(2.5rem, 5vw, 4.8rem)", margin: "18px 0 10px" }}>
            Voyez-le. Aimez-le. Gardez-le.
          </h2>
          <p className="muted">
            Commencez avec le vase de démonstration ou créez votre propre
            catalogue marchand.
          </p>
          <div className="hero-actions" style={{ justifyContent: "center" }}>
            <Link className="button" href="/demo">
              Lancer la démo <ArrowRight size={17} />
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}

function TrustItem({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="trust-item">
      <span>{icon}</span>
      <div>
        <strong>{title}</strong>
        <span>{children}</span>
      </div>
    </div>
  );
}

