/** Shared by runtime and the read-only production preflight.
 * An explicitly supplied release identity wins over repository metadata: a
 * CLI snapshot can include uncommitted files with the same Git HEAD.
 * An invalid explicit value must never silently fall back to that Git HEAD.
 */
export function inspectWorkerRevision(env) {
  const explicit = env.RENDER_WORKER_REVISION !== undefined;
  const candidate = explicit
    ? env.RENDER_WORKER_REVISION
    : env.VERCEL_GIT_COMMIT_SHA;
  const revision = typeof candidate === "string" ? candidate.trim() : "local";
  const git = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(revision);
  const content = /^sha256:[a-f0-9]{64}$/.test(revision);
  const placeholder = /^(?:0+|f+)$/i.test(revision.replace(/^sha256:/, ""));
  return {
    revision: revision || "local",
    source: explicit ? "explicit" : candidate !== undefined ? "git" : "local",
    kind: content ? "content-sha256" : git ? "git-sha" : "unversioned",
    credible: !placeholder && (content ? explicit : git),
  };
}

/** @param {Record<string, string | undefined>} env */
export function renderWorkerRevision(
  env,
  requireImmutable = env.NODE_ENV === "production",
) {
  const identity = inspectWorkerRevision(env);
  if (requireImmutable && !identity.credible)
    throw new Error(
      "An immutable RENDER_WORKER_REVISION or full Git revision is required in production",
    );
  return identity.revision;
}
