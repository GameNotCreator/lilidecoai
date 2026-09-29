import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
vi.mock("server-only", () => ({}));
import {
  fillMirrorInterior,
  hasSeparatedSubjects,
} from "../lib/server/mask-topology";
import { cutoutVerdict } from "../lib/server/cutout-identity";

describe("product silhouette topology", () => {
  it("repairs enclosed mirror glass while preserving exterior transparency", async () => {
    const input = await sharp(
      Buffer.from(
        '<svg width="100" height="100"><rect width="100" height="100" fill="black"/><circle cx="50" cy="50" r="35" stroke="white" stroke-width="4" fill="black"/></svg>',
      ),
    )
      .removeAlpha()
      .png()
      .toBuffer();
    const output = await sharp(await fillMirrorInterior(input))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(output.data[(50 * 100 + 50) * output.info.channels]).toBe(255);
    expect(output.data[0]).toBe(0);
  });
  it("does not turn a malformed alpha-bearing service response into a valid mask", async () => {
    const input = await sharp({
      create: { width: 10, height: 10, channels: 4, background: "white" },
    })
      .png()
      .toBuffer();
    await expect(fillMirrorInterior(input)).rejects.toThrow(
      "Invalid matting mask",
    );
  });
  it("restores partially transparent glass without a seam inside the frame", async () => {
    const input = await sharp(
      Buffer.from(
        '<svg width="100" height="100"><rect width="100" height="100" fill="black"/><circle cx="50" cy="50" r="35" stroke="white" stroke-width="4" fill="#a0a0a0"/></svg>',
      ),
    )
      .removeAlpha()
      .png()
      .toBuffer();
    const output = await sharp(await fillMirrorInterior(input))
      .greyscale()
      .raw()
      .toBuffer();
    expect(output[50 * 100 + 50]).toBe(255);
    expect(output[50 * 100 + 75]).toBe(255);
    expect(output[0]).toBe(0);
  });
  it("rejects two separated large subjects but tolerates tiny detached detail", async () => {
    const make = (second: string) =>
      sharp(
        Buffer.from(
          `<svg width="200" height="400"><rect x="50" y="10" width="100" height="130" fill="red"/>${second}</svg>`,
        ),
      )
        .png()
        .toBuffer();
    expect(
      await hasSeparatedSubjects(
        await make(
          '<rect x="50" y="250" width="100" height="130" fill="red"/>',
        ),
      ),
    ).toBe(true);
    expect(
      await hasSeparatedSubjects(
        await make('<circle cx="100" cy="270" r="3" fill="red"/>'),
      ),
    ).toBe(false);
    expect(
      cutoutVerdict({
        multipleSubjects: true,
        opaque: false,
        ragged: false,
        hollowed: false,
        enclosedBackground: false,
        shadowBand: false,
        busyBackground: false,
        vanished: false,
      }),
    ).toMatchObject({
      usable: false,
      code: "multiple_subjects",
    });
  });
});
