import { SimpleDemoStudio } from "@/components/simple-demo-studio";

export function DemoExperience() {
  return (
    <main className="demo-page focused-demo-page">
      <div className="container demo-container">
        <SimpleDemoStudio />
        <p className="privacy-reassurance">
          Vos photos servent uniquement à créer la visualisation et sont supprimées
          automatiquement sous 24 heures.
        </p>
      </div>
    </main>
  );
}
