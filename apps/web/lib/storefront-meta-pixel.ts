import {
  measurementEventKey,
  type MeasurementEvent,
} from "./storefront-measurement";

type Pixel = {
  (...args: unknown[]): void;
  callMethod?: (...args: unknown[]) => void;
  queue?: unknown[][];
  push?: Pixel;
  loaded?: boolean;
  version?: string;
};
type PixelWindow = Window & { fbq?: Pixel; _fbq?: Pixel };
let initialized = false;
let granted = false;
let currentPage = "";
const pageEvents = new Set<string>();

function pixelWindow() {
  return window as PixelWindow;
}

function initPixel(pixelId: string) {
  const browser = pixelWindow();
  if (!browser.fbq) {
    const pixel: Pixel = (...args) => {
      if (pixel.callMethod) pixel.callMethod(...args);
      else pixel.queue?.push(args);
    };
    pixel.queue = [];
    pixel.push = pixel;
    pixel.loaded = true;
    pixel.version = "2.0";
    browser.fbq = browser._fbq = pixel;
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://connect.facebook.net/en_US/fbevents.js";
    document.head.append(script);
  }
  const { fbq } = browser;
  if (!granted) fbq("consent", "grant");
  if (!initialized) {
    fbq("set", "autoConfig", false, pixelId);
    fbq("init", pixelId);
    initialized = true;
  }
  granted = true;
  return fbq;
}

export function revokeMetaPixel() {
  if (!granted) return;
  try {
    pixelWindow().fbq?.("consent", "revoke");
  } catch {
    // Clear local state even if Meta's script is unavailable.
  }
  granted = false;
  currentPage = "";
  pageEvents.clear();
  for (const name of ["_fbp", "_fbc"]) {
    const expired = `${name}=; Path=/; Max-Age=0`;
    document.cookie = expired;
    const domains = location.hostname.split(".");
    for (let index = 0; index < domains.length - 1; index++) {
      document.cookie = `${expired}; Domain=${domains.slice(index).join(".")}`;
    }
  }
}

const pixelEventNames = {
  product_viewed: "ViewContent",
  cart_item_added: "AddToCart",
  checkout_started: "InitiateCheckout",
  order_request_recorded: "Lead",
} as const;

export function recordMetaPixelEvent(
  pixelId: string,
  event: MeasurementEvent,
  leadId?: string,
) {
  const fbq = initPixel(pixelId);
  if (currentPage !== location.pathname) {
    currentPage = location.pathname;
    pageEvents.clear();
    fbq("trackSingle", pixelId, "PageView");
  }
  if (event.name === "catalogue_viewed" || event.name === "category_selected")
    return;
  if (event.name === "order_request_recorded" && !leadId) return;
  const key = leadId ? `lead:${leadId}` : measurementEventKey(event);
  if (pageEvents.has(key)) return;
  pageEvents.add(key);

  const fields =
    "productId" in event
      ? { content_type: "product", content_ids: [event.productId] }
      : {};
  const name = pixelEventNames[event.name];
  if (leadId) fbq("trackSingle", pixelId, name, fields, { eventID: key });
  else fbq("trackSingle", pixelId, name, fields);
}
