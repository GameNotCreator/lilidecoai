import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

const defaultUsername = "LiliDeco";
const defaultPasswordHash =
  "$2b$12$uHN/kryIhgRsOG8CaWGQdOQ0DU0mIK32jUHF1K0L43/EqeQXA/ODq";

export interface AdminCredentials {
  username: string;
  password?: string;
  passwordHash?: string;
}

export interface AdminCredentialEnvironment {
  mode?: string;
  username?: string;
  password?: string;
  passwordHash?: string;
}

/**
 * The requested account is the default. Old ADMIN_* values cannot silently
 * replace it; an operator must explicitly enable environment-based rotation.
 */
export function readAdminCredentials(
  environment: AdminCredentialEnvironment,
): AdminCredentials | null {
  const mode = trimmed(environment.mode) ?? "fixed";
  if (mode === "fixed")
    return { username: defaultUsername, passwordHash: defaultPasswordHash };
  if (mode !== "environment") return null;
  const password = trimmed(environment.password);
  const passwordHash = trimmed(environment.passwordHash);
  if (!password && !passwordHash) return null;
  return {
    username: trimmed(environment.username) ?? defaultUsername,
    ...(password && !passwordHash ? { password } : {}),
    ...(passwordHash ? { passwordHash } : {}),
  };
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** Compares two secrets without leaking their length or content through timing. */
export function secretsMatch(expected: string, provided: string): boolean {
  return timingSafeEqual(digest(expected), digest(provided));
}

export function usernameMatches(expected: string, provided: string): boolean {
  return secretsMatch(normalizeUsername(expected), normalizeUsername(provided));
}

export function looksLikeBcryptHash(value: string): boolean {
  return /^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}

/** Rejects the placeholder values shipped in .env.example. */
export function isPlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized.startsWith("replace-with") ||
    normalized.startsWith("change-me") ||
    normalized === "password" ||
    normalized === "admin"
  );
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}
