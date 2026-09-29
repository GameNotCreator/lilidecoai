export interface WorkerRevisionIdentity {
  revision: string;
  source: "explicit" | "git" | "local";
  kind: "content-sha256" | "git-sha" | "unversioned";
  credible: boolean;
}
export function inspectWorkerRevision(
  env: Record<string, string | undefined>,
): WorkerRevisionIdentity;
export function renderWorkerRevision(
  env: Record<string, string | undefined>,
  requireImmutable?: boolean,
): string;
