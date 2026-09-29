import "server-only";

import { compare } from "bcryptjs";
import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  isPlaceholderSecret,
  looksLikeBcryptHash,
  normalizeUsername,
  readAdminCredentials,
  secretsMatch,
  usernameMatches,
  type AdminCredentials,
} from "./admin-credentials";
import { serverConfig } from "./config";
import { isSameOriginRequest } from "./request-origin";

export const ADMIN_COOKIE_NAME = "lili_backoffice";

const issuer = "lilidecoai";
const audience = "lilidecoai-backoffice";
const minimumProductionPasswordLength = 10;

export interface AdminSession {
  username: string;
  issuedAt: number;
}

/** Which ADMIN_* variables reach the server. Presence only, never values. */
export type DetectedAdminVariables = {
  ADMIN_CREDENTIALS_MODE: boolean;
  ADMIN_USERNAME: boolean;
  ADMIN_PASSWORD: boolean;
  ADMIN_PASSWORD_HASH: boolean;
  APP_SESSION_SECRET: boolean;
};

export type AdminConfigurationStatus =
  | { configured: true; credentials: AdminCredentials }
  | { configured: false; reason: string; detected: DetectedAdminVariables };

export class AdminAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** Browser authentication mutations must originate from this exact site. */
export function assertAdminRequestOrigin(request: Request): void {
  if (!isSameOriginRequest(request))
    throw new AdminAuthError("Origine de la requête refusée", 403);
}

/**
 * Even the fixed account requires a private deployment signing secret.
 * Demo mode never bypasses administrator authentication.
 */
export function adminConfiguration(): AdminConfigurationStatus {
  const credentials = readAdminCredentials({
    mode: process.env.ADMIN_CREDENTIALS_MODE,
    username: serverConfig.adminUsername,
    password: serverConfig.adminPassword,
    passwordHash: serverConfig.adminPasswordHash,
  });
  if (!credentials) {
    return {
      configured: false,
      reason:
        process.env.ADMIN_CREDENTIALS_MODE?.trim() === "environment"
          ? "Le mode de rotation exige ADMIN_PASSWORD_HASH ou ADMIN_PASSWORD."
          : "ADMIN_CREDENTIALS_MODE doit être fixed ou environment.",
      detected: detectedAdminVariables(),
    };
  }
  if (
    !serverConfig.sessionSecret ||
    serverConfig.sessionSecret.length < 32 ||
    isPlaceholderSecret(serverConfig.sessionSecret)
  ) {
    return {
      configured: false,
      reason: "APP_SESSION_SECRET doit être un secret privé d’au moins 32 caractères.",
      detected: detectedAdminVariables(),
    };
  }
  if (
    serverConfig.adminSessionSecret &&
    (serverConfig.adminSessionSecret.length < 32 ||
      isPlaceholderSecret(serverConfig.adminSessionSecret))
  ) {
    return {
      configured: false,
      reason: "ADMIN_SESSION_SECRET doit être un secret privé d’au moins 32 caractères.",
      detected: detectedAdminVariables(),
    };
  }
  if (credentials.passwordHash && !looksLikeBcryptHash(credentials.passwordHash)) {
    return {
      configured: false,
      reason:
        "ADMIN_PASSWORD_HASH n’est pas un hash bcrypt valide (format $2b$12$…).",
      detected: detectedAdminVariables(),
    };
  }
  if (credentials.password && isPlaceholderSecret(credentials.password)) {
    return {
      configured: false,
      reason: "ADMIN_PASSWORD contient encore une valeur d’exemple.",
      detected: detectedAdminVariables(),
    };
  }
  if (
    process.env.NODE_ENV === "production" &&
    credentials.password &&
    credentials.password.length < minimumProductionPasswordLength
  ) {
    return {
      configured: false,
      reason: `En production, ADMIN_PASSWORD doit contenir au moins ${minimumProductionPasswordLength} caractères.`,
      detected: detectedAdminVariables(),
    };
  }
  return { configured: true, credentials };
}

export function detectedAdminVariables(): DetectedAdminVariables {
  return {
    ADMIN_CREDENTIALS_MODE: Boolean(process.env.ADMIN_CREDENTIALS_MODE),
    ADMIN_USERNAME: Boolean(serverConfig.adminUsername),
    ADMIN_PASSWORD: Boolean(serverConfig.adminPassword),
    ADMIN_PASSWORD_HASH: Boolean(serverConfig.adminPasswordHash),
    APP_SESSION_SECRET: Boolean(serverConfig.sessionSecret),
  };
}

export function adminAuthConfigured(): boolean {
  return adminConfiguration().configured;
}

export async function verifyAdminCredentials(
  username: string,
  password: string,
): Promise<boolean> {
  const status = adminConfiguration();
  if (!status.configured) return false;
  const { credentials } = status;
  const usernameOk = usernameMatches(credentials.username, username);
  // Both branches always run so a wrong username costs the same as a wrong
  // password.
  const passwordOk = credentials.passwordHash
    ? await compare(password, credentials.passwordHash)
    : secretsMatch(credentials.password ?? "", password);
  return usernameOk && passwordOk;
}

export async function createAdminSession(
  username: string,
): Promise<{ token: string; cookie: string }> {
  const status = adminConfiguration();
  if (!status.configured) throw new AdminAuthError(status.reason, 503);
  if (!usernameMatches(status.credentials.username, username))
    throw new AdminAuthError("Identifiants invalides", 401);
  const maxAge = Math.round(serverConfig.adminSessionHours * 3600);
  const token = await new SignJWT({ scope: "backoffice" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(status.credentials.username)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${maxAge}s`)
    .sign(await secret());
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return {
    token,
    cookie: `${ADMIN_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`,
  };
}

export function clearAdminSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

export async function verifyAdminToken(
  token: string,
): Promise<AdminSession | null> {
  try {
    const status = adminConfiguration();
    if (!status.configured) return null;
    const { payload } = await jwtVerify(token, await secret(), {
      issuer,
      audience,
      algorithms: ["HS256"],
    });
    if (
      typeof payload.sub !== "string" ||
      payload.scope !== "backoffice" ||
      !usernameMatches(status.credentials.username, payload.sub)
    ) {
      return null;
    }
    return {
      username: payload.sub,
      issuedAt: typeof payload.iat === "number" ? payload.iat * 1000 : 0,
    };
  } catch {
    return null;
  }
}

/** Reads the session attached to an API request. */
export async function adminSessionForRequest(
  request: Request,
): Promise<AdminSession | null> {
  if (!adminAuthConfigured()) return null;
  const token = readCookie(request.headers.get("cookie"), ADMIN_COOKIE_NAME);
  return token ? verifyAdminToken(token) : null;
}

/** Guard for every back-office API route. */
export async function requireAdminRequest(
  request: Request,
): Promise<AdminSession> {
  const status = adminConfiguration();
  if (!status.configured) {
    throw new AdminAuthError(`Back office indisponible. ${status.reason}`, 503);
  }
  const session = await adminSessionForRequest(request);
  if (!session) {
    throw new AdminAuthError("Session administrateur requise", 401);
  }
  // A session signed for a username that no longer matches the environment is
  // rejected: rotating ADMIN_USERNAME logs everybody out.
  if (!usernameMatches(status.credentials.username, session.username)) {
    throw new AdminAuthError("Session administrateur expirée", 401);
  }
  return session;
}

/** Reads the session inside a server component. */
export async function currentAdminSession(): Promise<AdminSession | null> {
  if (!adminAuthConfigured()) return null;
  const token = (await cookies()).get(ADMIN_COOKIE_NAME)?.value;
  return token ? verifyAdminToken(token) : null;
}

/** Guard for every back-office page. Redirects instead of throwing. */
export async function requireAdminPage(returnTo: string): Promise<AdminSession> {
  const session = await currentAdminSession();
  if (!session) {
    redirect(`/admin/login?next=${encodeURIComponent(returnTo)}`);
  }
  return session;
}

async function secret(): Promise<Uint8Array> {
  const status = adminConfiguration();
  if (!status.configured) throw new AdminAuthError(status.reason, 503);
  const base =
    serverConfig.adminSessionSecret ??
    serverConfig.sessionSecret;
  // A distinct key prevents merchant-token reuse. Binding it to the active
  // credentials revokes existing sessions after either username or password rotation.
  const derived = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([
      base,
      "backoffice",
      normalizeUsername(status.credentials.username),
      status.credentials.passwordHash ?? status.credentials.password,
    ])),
  );
  return new Uint8Array(derived);
}

function readCookie(header: string | null, name: string): string | undefined {
  return header
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
