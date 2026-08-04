import { describe, expect, it } from "vitest";

import { sniffImageMime } from "../lib/server/image-security";

describe("upload image signatures", () => {
  it("recognizes the supported binary signatures", () => {
    expect(
      sniffImageMime(
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image/png");
    expect(sniffImageMime(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe(
      "image/jpeg",
    );
    expect(
      sniffImageMime(
        Uint8Array.from([
          0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        ]),
      ),
    ).toBe("image/webp");
  });

  it("rejects a renamed or unknown payload", () => {
    expect(
      sniffImageMime(new TextEncoder().encode("<script>alert(1)</script>")),
    ).toBeNull();
  });
});
