import type { Render } from "@lili/types";
import { ApiError, InvalidApiResponseError } from "./api-errors";

export interface RenderTrackingIssue {
  kind: "connection" | "access" | "unavailable" | "invalid_response";
  automaticRetry: boolean;
  message: string;
}

function trackingIssue(reason: unknown): RenderTrackingIssue {
  if (reason instanceof InvalidApiResponseError) {
    return {
      kind: "invalid_response",
      automaticRetry: false,
      message:
        "Le suivi ne peut pas être affiché pour le moment. Vous pouvez réessayer de consulter l’état du rendu.",
    };
  }
  if (reason instanceof ApiError) {
    if (reason.status === 401 || reason.status === 403) {
      return {
        kind: "access",
        automaticRetry: false,
        message:
          "Le suivi n’est plus accessible avec cette session. Vous pouvez réessayer de le consulter après avoir rétabli votre accès.",
      };
    }
    if (
      reason.status >= 400 &&
      reason.status < 500 &&
      ![408, 425, 429].includes(reason.status)
    ) {
      return {
        kind: "unavailable",
        automaticRetry: false,
        message:
          "Cette visualisation n’est plus disponible dans le suivi. Vous pouvez vérifier à nouveau sans relancer la génération.",
      };
    }
  }
  return {
    kind: "connection",
    automaticRetry: true,
    message:
      "Le suivi est momentanément interrompu. Votre demande reste enregistrée ; nous essayons de récupérer son état.",
  };
}

/** One read at a time; a connection failure never starts a second generation. */
export function startRenderTracking({
  renderId,
  fetchRender,
  onRender,
  onInterrupted,
}: {
  renderId: string;
  fetchRender: (id: string, signal: AbortSignal) => Promise<Render>;
  onRender: (render: Render) => void;
  onInterrupted: (issue: RenderTrackingIssue | null) => void;
}) {
  let stopped = false;
  let finished = false;
  let inFlight = false;
  let failures = 0;
  let manualOnly = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeRequest: AbortController | null = null;

  async function poll() {
    if (stopped || finished || inFlight) return;
    clearTimeout(timer);
    inFlight = true;
    const request = new AbortController();
    activeRequest = request;
    // Abort the actual fetch: a lost connection cannot hold the single-flight
    // lock forever, and retries never leave old reads running in parallel.
    const timeout = setTimeout(() => request.abort(), 15_000);
    let delay: number | null = null;
    try {
      const next = await fetchRender(renderId, request.signal);
      if (stopped) return;
      failures = 0;
      manualOnly = false;
      onInterrupted(null);
      onRender(next);
      finished = next.status !== "processing" && next.status !== "queued";
      if (!finished) delay = 1600;
    } catch (reason) {
      if (stopped) return;
      failures += 1;
      const issue = trackingIssue(reason);
      manualOnly = !issue.automaticRetry;
      onInterrupted(issue);
      if (issue.automaticRetry)
        delay = Math.min(30_000, 1600 * 2 ** Math.min(failures, 5));
    } finally {
      clearTimeout(timeout);
      activeRequest = null;
      inFlight = false;
      if (!stopped && delay !== null)
        timer = setTimeout(() => void poll(), delay);
    }
  }

  timer = setTimeout(() => void poll(), 0);
  return {
    refresh: () => void poll(),
    resume: () => {
      if (!manualOnly) void poll();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      activeRequest?.abort();
    },
  };
}
