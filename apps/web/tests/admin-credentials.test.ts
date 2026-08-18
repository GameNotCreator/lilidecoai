import { describe, expect, it } from "vitest";

import {
  isPlaceholderSecret,
  looksLikeBcryptHash,
  normalizeUsername,
  readAdminCredentials,
  secretsMatch,
  usernameMatches,
} from "../lib/server/admin-credentials";

describe("back office credentials", () => {
  it("stays closed when no password is provided", () => {
    expect(readAdminCredentials({})).toBeNull();
    expect(readAdminCredentials({ username: "admin" })).toBeNull();
    expect(readAdminCredentials({ password: "   " })).toBeNull();
  });

  it("defaults the username and keeps the configured secret", () => {
    expect(readAdminCredentials({ password: "un-mot-de-passe" })).toEqual({
      username: "admin",
      password: "un-mot-de-passe",
    });
    expect(
      readAdminCredentials({ username: " Hedi ", passwordHash: "$2b$12$abc" }),
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
