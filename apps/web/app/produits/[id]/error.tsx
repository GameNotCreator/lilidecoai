"use client";
export default function ProductError({ reset }: { reset: () => void }) {
  return (
    <main className="storefront store-shell store-empty">
      <h1>La fiche se fait attendre</h1>
      <p>Le produit n’a pas pu être chargé. Réessayez dans un instant.</p>
      <button className="store-button" onClick={reset}>
        Réessayer
      </button>
    </main>
  );
}
