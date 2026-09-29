import { compare } from "bcryptjs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  isPlaceholderSecret,
  looksLikeBcryptHash,
  normalizeUsername,
  readAdminCredentials,
  secretsMatch,
  usernameMatches,
} from "../lib/server/admin-credentials";

describe("back office credentials", () => {
  it("uses the requested fixed account without storing a clear-text default", async () => {
    const credentials = readAdminCredentials({});
    expect(credentials?.username).toBe("LiliDeco");
    expect(credentials?.password).toBeUndefined();
    expect(await compare("LiliDeco2026", credentials!.passwordHash!)).toBe(true);
    expect(await compare("LiliDeco2026wrong", credentials!.passwordHash!)).toBe(false);
  });

  it("ignores stale credential variables unless rotation is explicitly selected", () => {
    expect(readAdminCredentials({ username: "old", password: "old", passwordHash: "broken" })).toEqual(readAdminCredentials({}));
    expect(readAdminCredentials({ mode: "unknown" })).toBeNull();
    expect(readAdminCredentials({ mode: "environment" })).toBeNull();
    expect(readAdminCredentials({ mode: "environment", password: "   " })).toBeNull();
  });

  it("supports explicit rotation and prefers the hash over a stale plain password", () => {
    expect(readAdminCredentials({ mode: "environment", password: "un-mot-de-passe" })).toEqual({
      username: "LiliDeco",
      password: "un-mot-de-passe",
    });
    expect(
      readAdminCredentials({ mode: "environment", username: " Hedi ", password: "old", passwordHash: "$2b$12$abc" }),
    ).toEqual({ username: "Hedi", passwordHash: "$2b$12$abc" });
  });

  it("compares secrets of different lengths without throwing", () => {
    expect(secretsMatch("motdepasse", "motdepasse")).toBe(true);
    expect(secretsMatch("motdepasse", "court")).toBe(false);
    expect(secretsMatch("", "quelque-chose")).toBe(false);
  });

  it("ignores case and spacing on the username only", () => {
    expect(normalizeUsername("  Hedi ")).toBe("hedi");
    expect(usernameMatches("Hedi", "hedi")).toBe(true);
    expect(usernameMatches("Hedi", "hedi2")).toBe(false);
    expect(secretsMatch("MotDePasse", "motdepasse")).toBe(false);
  });

  it("recognizes bcrypt hashes and example values", () => {
    expect(
      looksLikeBcryptHash(
        "$2b$12$C6UzMDM.H6dfI/f/IKcEe.crdT8ZDwPMoTNPnwmZuBrRpTtY5o8ni",
      ),
    ).toBe(true);
    expect(looksLikeBcryptHash("pas-un-hash")).toBe(false);
    expect(isPlaceholderSecret("replace-with-a-long-passphrase")).toBe(true);
    expect(isPlaceholderSecret("admin")).toBe(true);
    expect(isPlaceholderSecret("F9!kd82jzQm3")).toBe(false);
  });
});
