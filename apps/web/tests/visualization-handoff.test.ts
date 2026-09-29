import { describe, expect, it } from "vitest";
import { cartProductIds, parseVisualizationIds } from "../lib/storefront";
import {
  isLoopbackHostname,
  mobileHandoffOrigin,
  visualizationHandoff,
} from "../lib/visualization-handoff";

const id = "00000000-0000-4000-8000-000000000101";
const other = "00000000-0000-4000-8000-000000000102";

describe("visualization device handoff", () => {
  it("preserves product identity, order and repeated units without cart storage or auth", () => {
    const ids = cartProductIds([
      { productId: id, quantity: 2 },
      { productId: other, quantity: 1 },
    ]);
    const result = visualizationHandoff(ids, "https://bylilideco.test");
    expect(result.problem).toBeNull();
    const url = new URL(result.url!);
    expect(url.origin).toBe("https://bylilideco.test");
    expect(url.pathname).toBe("/visualiser");
    expect([...url.searchParams.keys()]).toEqual(["products"]);
    expect(parseVisualizationIds(url.searchParams.get("products")!)).toEqual(ids);
  });

  it.each([{ ids: [] }, { ids: ["garbage"] }, { ids: [id, id, id, id] }])("rejects invalid selection $ids", ({ ids }) => {
    expect(visualizationHandoff(ids, "https://shop.test")).toEqual({
      url: null,
      problem: "invalid-selection",
    });
  });

  it.each(["localhost", "preview.localhost", "127.0.0.1", "127.0.1.2", "[::1]"])(
    "never presents the phone with the computer's loopback address: %s",
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(true);
      expect(visualizationHandoff([id], `http://${hostname}:3105`)).toEqual({
        url: null,
        problem: "local-origin",
      });
    },
  );

  it.each(["192.168.1.10", "10.0.0.12", "172.16.0.20", "172.31.255.12"])(
    "allows an explicit local network preview: %s",
    (host) => {
      const origin = `http://${host}:3105`;
      const configured = visualizationHandoff([id], "http://127.0.0.1:3105", origin);
      expect(new URL(configured.url!).origin).toBe(origin);
      expect(new URL(visualizationHandoff([id], origin).url!).origin).toBe(origin);
    },
  );

  it("never replaces a hosted site's origin with a development configuration", () => {
    const result = visualizationHandoff([id], "https://shop.test", "http://192.168.1.2:3105");
    expect(new URL(result.url!).origin).toBe("https://shop.test");
  });

  it.each([
    "javascript:alert(1)",
    "https://name:password@shop.test",
    "https://shop.test/admin",
    "https://shop.test/?token=private",
    "https://shop.test/#secret",
    "http://public.test",
    "http://172.32.0.1:3105",
    "http://169.254.1.2:3105",
    "http://0.0.0.0:3105",
    "https://[::]",
    "https://localhost",
    "//shop.test",
    "not an address",
  ])("refuses unsafe or ambiguous origins: %s", (origin) => {
    expect(mobileHandoffOrigin(origin)).toBeNull();
    expect(visualizationHandoff([id], "http://127.0.0.1:3105", origin)).toEqual({
      url: null,
      problem: "invalid-origin",
    });
  });
});
