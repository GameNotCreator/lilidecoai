import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
vi.mock("server-only", () => ({}));
vi.mock("../lib/server/config", () => ({
  serverConfig: {
    aiMockMode: false,
    openaiApiKey: "fixture-not-a-key",
    openaiBaseUrl: "https://vision.invalid/v1",
  },
}));
import { analyzeSpatialRoom } from "../lib/server/spatial-scene-cache";
import { reviewOrientedCandidate } from "../lib/server/ai/oriented-review";
import { globalRoom } from "./fixtures/spatial-room";

afterEach(() => vi.unstubAllGlobals());
const image = (format: "png" | "webp" | "jpeg") =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: "#a87e52" } })
    .toFormat(format)
    .toBuffer();
const reviewInput = (room: Buffer, original: Buffer, prepared: Buffer) => ({
  stage: "raw" as const,
  model: "gpt-6-astra",
  deadlineMs: Date.now() + 60_000,
  room,
  prepared,
  candidate: room,
  originals: [{ assetId: "original", buffer: original }],
  evidence: {
    originalAssetIds: ["original"],
    preparedImageSha256: "a".repeat(64),
    planFingerprint: "b".repeat(64),
    resultSha256: "c".repeat(64),
    providerOutputReviewed: true,
  },
  plan: {},
});
function mockedResponse(value: unknown) {
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
    status: "completed",
    model: "gpt-6-astra",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const requestImages = (fetchMock: ReturnType<typeof mockedResponse>) => {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  const body = JSON.parse(init.body as string);
  return body.input[0].content.filter((part: { type: string }) => part.type === "input_image") as Array<{ image_url: string }>;
};

describe("oriented vision request image encodings", () => {
  it.each(["png", "webp", "jpeg"] as const)("analyzes %s bytes with their actual MIME without reencoding", async (format) => {
    const room = await image(format);
    const fetchMock = mockedResponse(globalRoom);
    const result = await analyzeSpatialRoom(room, "gpt-6-astra");
    expect(result.value).toEqual(globalRoom);
    expect(requestImages(fetchMock)).toEqual([{ type: "input_image", image_url: `data:image/${format};base64,${room.toString("base64")}`, detail: "original" }]);
  });

  it("reviews mixed PNG room, WebP original and JPEG prepared view without changing their evidence bytes", async () => {
    const [room, original, prepared] = await Promise.all([image("png"), image("webp"), image("jpeg")]);
    const criteria = Object.fromEntries(["identity", "angle", "geometry", "contact", "shadow", "background"].map(name => [name, { status: "pass", observations: ["Fixture evidence"] }]));
    const fetchMock = mockedResponse(criteria);
    const result = await reviewOrientedCandidate(reviewInput(room, original, prepared));
    expect(result.criteria).toEqual(criteria);
    expect(requestImages(fetchMock).map(part => part.image_url)).toEqual([
      `data:image/png;base64,${room.toString("base64")}`,
      `data:image/webp;base64,${original.toString("base64")}`,
      `data:image/jpeg;base64,${prepared.toString("base64")}`,
      `data:image/png;base64,${room.toString("base64")}`,
    ]);
  });

  it("rejects unrecognized room or reference bytes before any provider request", async () => {
    const room = await image("png");
    const invalid = Buffer.from("not an image");
    const fetchMock = mockedResponse({});
    await expect(analyzeSpatialRoom(invalid, "gpt-6-astra")).rejects.toMatchObject({ status: 422, providerCalled: false });
    await expect(reviewOrientedCandidate(reviewInput(room, invalid, room))).rejects.toMatchObject({ status: 422, providerCalled: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
