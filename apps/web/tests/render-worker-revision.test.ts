import { describe, expect, it } from "vitest";
import {
  inspectWorkerRevision,
  renderWorkerRevision,
} from "../lib/render-worker-revision.mjs";

const git = "a".repeat(40),
  snapshot = `sha256:${"b".repeat(64)}`;
describe("immutable worker release identity", () => {
  it("prefers content identity to the unchanged Git HEAD of a dirty checkout", () => {
    const env = {
      VERCEL_GIT_COMMIT_SHA: git,
      RENDER_WORKER_REVISION: snapshot,
      NODE_ENV: "production",
    };
    expect(renderWorkerRevision(env)).toBe(snapshot);
    expect(inspectWorkerRevision(env)).toMatchObject({
      source: "explicit",
      kind: "content-sha256",
      credible: true,
    });
  });
  it("uses full Git identity only when no explicit revision was supplied", () => {
    expect(renderWorkerRevision({ VERCEL_GIT_COMMIT_SHA: git }, true)).toBe(
      git,
    );
    expect(
      renderWorkerRevision({ VERCEL_GIT_COMMIT_SHA: "a".repeat(64) }, true),
    ).toBe("a".repeat(64));
    expect(renderWorkerRevision({ RENDER_WORKER_REVISION: git }, true)).toBe(
      git,
    );
  });
  it.each([
    "",
    " ",
    "local",
    "main",
    "a".repeat(7),
    "sha256:broken",
    "sha256:" + "g".repeat(64),
    "0".repeat(40),
    "f".repeat(64),
    "sha256:" + "0".repeat(64),
  ])(
    "refuses explicit invalid identity %j without using the valid Git fallback",
    (revision) => {
      expect(() =>
        renderWorkerRevision({
          NODE_ENV: "production",
          VERCEL_GIT_COMMIT_SHA: git,
          RENDER_WORKER_REVISION: revision,
        }),
      ).toThrow("immutable");
    },
  );
  it("does not accept a content tag as Git metadata", () => {
    expect(() =>
      renderWorkerRevision({ VERCEL_GIT_COMMIT_SHA: snapshot }, true),
    ).toThrow("immutable");
  });
  it("retains local development while refusing missing production identity", () => {
    expect(renderWorkerRevision({})).toBe("local");
    expect(() => renderWorkerRevision({ NODE_ENV: "production" })).toThrow(
      "immutable",
    );
  });
});
