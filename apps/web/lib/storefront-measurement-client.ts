import {
  measurementBatchLimit,
  measurementChoiceCookie,
  measurementEventKey,
  readMeasurementChoice,
  type MeasurementBatch,
  type MeasurementChoice,
  type MeasurementChannel,
  type MeasurementEvent,
} from "./storefront-measurement";

const visitStorageKey = "lilideco-measurement-visit-v1";
const visitDuration = 30 * 60 * 1000;
export const measurementChoiceChange = "lilideco:measurement-choice";

type Visit = Pick<
  MeasurementBatch,
  "visitId" | "channel" | "screen" | "events"
> & {
  expiresAt: number;
  sent: number;
  seen: string[];
};

let activeVisit: Visit | null | undefined;

export function browserMeasurementChoice() {
  try {
    return readMeasurementChoice(document.cookie);
  } catch {
    return null;
  }
}

export function setBrowserMeasurementChoice(choice: MeasurementChoice) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${measurementChoiceCookie}=${choice}; Path=/; SameSite=Lax; Max-Age=15552000${secure}`;
  if (choice[0] === "0") clearMeasurementVisit();
  window.dispatchEvent(new Event(measurementChoiceChange));
}

export function measurementChannel(
  search: string,
  referrer: string,
  ownHost: string,
): MeasurementChannel {
  const params = new URLSearchParams(search);
  const medium = params.get("utm_medium")?.trim().toLowerCase();
  const source = params.get("utm_source")?.trim().toLowerCase();
  if (
    medium === "paid_social" ||
    medium === "paidsocial" ||
    medium === "paid-social" ||
    (["cpc", "paid"].includes(medium ?? "") &&
      ["facebook", "instagram", "meta", "fb", "ig"].includes(source ?? ""))
  )
    return "paid-social";
  if (medium === "organic") return "organic";
  if (medium === "social" || medium === "organic_social") return "social";
  if (medium) return "other";
  if (!referrer) return "direct";

  try {
    const host = new URL(referrer).hostname;
    if (host === ownHost) return "direct";
    if (
      [
        "google.com",
        "google.tn",
        "bing.com",
        "duckduckgo.com",
        "yahoo.com",
      ].some((domain) => host === domain || host.endsWith(`.${domain}`))
    )
      return "organic";
    if (
      ["facebook.com", "instagram.com", "pinterest.com", "tiktok.com"].some(
        (domain) => host === domain || host.endsWith(`.${domain}`),
      )
    )
      return "social";
  } catch {
    // Malformed referrers are never stored.
  }
  return "other";
}

export function clearMeasurementVisit() {
  activeVisit = null;
  try {
    sessionStorage.removeItem(visitStorageKey);
  } catch {
    // Storage can be blocked by the browser.
  }
}

function saveVisit(visit: Visit) {
  try {
    sessionStorage.setItem(visitStorageKey, JSON.stringify(visit));
  } catch {
    // The budget still applies to this document when storage is blocked.
  }
}

function readVisit() {
  if (activeVisit === undefined) {
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(visitStorageKey) ?? "null",
      ) as Visit | null;
      activeVisit =
        saved &&
        typeof saved.expiresAt === "number" &&
        Number.isInteger(saved.sent) &&
        saved.sent >= 0 &&
        saved.sent <= 2 &&
        Array.isArray(saved.events) &&
        Array.isArray(saved.seen)
          ? saved
          : null;
    } catch {
      activeVisit = null;
    }
  }
  if (activeVisit && activeVisit.expiresAt <= Date.now())
    clearMeasurementVisit();
  return activeVisit;
}

export function recordAudienceEvent(event: MeasurementEvent) {
  if (browserMeasurementChoice()?.[0] !== "1") return;
  if (!readVisit()) {
    activeVisit = {
      visitId: crypto.randomUUID(),
      expiresAt: Date.now() + visitDuration,
      channel: measurementChannel(
        location.search,
        document.referrer,
        location.hostname,
      ),
      screen: matchMedia("(max-width: 760px)").matches ? "small" : "wide",
      sent: 0,
      seen: ["catalogue_viewed"],
      events: [{ name: "catalogue_viewed" }],
    };
    saveVisit(activeVisit);
  }

  const visit = activeVisit;
  if (!visit) return;
  if (visit.sent >= 2) return;
  const key = measurementEventKey(event);
  const checkout = event.name === "checkout_started";
  const lead = event.name === "order_request_recorded";
  const maximum = measurementBatchLimit - (checkout || lead ? 0 : 2);
  if (visit.events.length >= maximum || visit.seen.includes(key)) return;

  visit.events.push(event);
  visit.seen.push(key);
  saveVisit(visit);
  if (checkout || lead) flushAudienceEvents(lead ? "lead" : "first");
}

export function flushAudienceEvents(trigger: "first" | "exit" | "lead") {
  if (browserMeasurementChoice()?.[0] !== "1") return;
  const visit = readVisit();
  if (
    !visit?.events.length ||
    visit.sent >= 2 ||
    (visit.sent === 1 && trigger === "first")
  )
    return;

  const sequence = visit.sent === 0 ? 1 : 2;
  const body = JSON.stringify({
    visitId: visit.visitId,
    channel: visit.channel,
    screen: visit.screen,
    sequence,
    events: visit.events,
  } satisfies MeasurementBatch);
  // Persist the budget before sending so pagehide and visibilitychange can't send the same lot.
  visit.sent = sequence;
  visit.events = [];
  saveVisit(visit);
  void fetch("/api/storefront/measure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
    credentials: "same-origin",
  }).catch(() => {});
}
