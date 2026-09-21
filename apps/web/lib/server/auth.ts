import "server-only";

import { compare, hash } from "bcryptjs";
import { jwtVerify, SignJWT } from "jose";
import type { Db } from "mongodb";

import { serverConfig } from "./config";
import { collections } from "./mongodb";
import { DEMO_ORGANIZATION_ID, DEMO_USER_ID } from "./types";

export interface Tenant {
  organizationId: string;
  userId: string;
  role: "owner" | "admin" | "member" | "viewer" | "guest" | "platform_admin";
  publicProductId?: string;
  publicSessionId?: string;
  /**
   * Set only for the identity demo mode hands to a request that carries no
   * session at all. It looks like an organization owner so the demo works
   * without a login, but nobody proved they are one — so it reads published
   * catalogue images and nothing else. Never signed into a token: a real
   * session can never claim it.
   */
  synthetic?: true;
}

const cookieName = "lili_session";
const guestCookieName = "lili_guest_session";
const publicCookieName = "lili_public_session";
const developmentSecret = "lilidecoai-development-session-secret-2026";

function secret(): Uint8Array {
  return new TextEncoder().encode(
    serverConfig.sessionSecret ?? developmentSecret,
  );
}

/**
 * Every identity this request could legitimately act as, most specific first.
 *
 * `tenantForRequest` picks one, and a merchant account cookie wins over a
 * guest cookie. That is right for an API call, but a browser sends every
 * cookie with an `<img>` request too: a signed-in merchant browsing the public
 * demo would be read as their own organization and refused the guest session's
 * images. Reading an image asks "may any of these identities read it", not
 * "which one is primary".
 */
export async function tenantsForRequest(request: Request): Promise<Tenant[]> {
  const authorization = request.headers.get("authorization");
  const candidates = [
    authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined,
    readCookie(request, cookieName),
    readCookie(request, guestCookieName),
    readCookie(request, publicCookieName),
  ].filter((token): token is string => Boolean(token));
  const tenants: Tenant[] = [];
  for (const token of candidates) {
    const tenant = await verifySessionToken(token);
    if (tenant) tenants.push(tenant);
  }
  if (tenants.length) return tenants;
  return serverConfig.demoMode ? [demoTenant(request)] : [];
}

function demoTenant(request: Request): Tenant {
  return {
    organizationId: DEMO_ORGANIZATION_ID,
    userId: DEMO_USER_ID,
    role:
      request.headers.get("x-user-role") === "platform_admin"
        ? "platform_admin"
        : "owner",
    synthetic: true,
  };
}

export async function tenantForRequest(request: Request): Promise<Tenant> {
  const authorization = request.headers.get("authorization");
  const token =
    (authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined) ??
    readCookie(request, cookieName) ??
    readCookie(request, guestCookieName) ??
    readCookie(request, publicCookieName);
  if (token) {
    const tenant = await verifySessionToken(token);
    if (tenant) return tenant;
  }
  if (serverConfig.demoMode) return demoTenant(request);
  throw new AuthError("Authentification requise", 401);
}

export async function verifySessionToken(
  token: string,
): Promise<Tenant | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: "lilidecoai",
      audience: "lilidecoai-web",
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.organizationId !== "string" ||
      typeof payload.role !== "string"
    ) {
      return null;
    }
    const tenant: Tenant = {
      organizationId: payload.organizationId,
      userId: payload.sub,
      role: payload.role as Tenant["role"],
    };
    if (typeof payload.publicProductId === "string") {
      tenant.publicProductId = payload.publicProductId;
    }
    if (typeof payload.publicSessionId === "string") {
      tenant.publicSessionId = payload.publicSessionId;
    }
    return tenant;
  } catch {
    return null;
  }
}

export async function createSession(
  tenant: Tenant,
): Promise<{ token: string; cookie: string }> {
  const token = await signTenant(tenant, "7d");
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return {
    token,
    cookie: `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`,
  };
}

export async function createPublicSession(
  organizationId: string,
  productId: string,
): Promise<{ token: string; cookie: string; sessionId: string }> {
  const sessionId = crypto.randomUUID();
  const tenant: Tenant = {
    organizationId,
    userId: `public:${sessionId}`,
    role: "viewer",
    publicProductId: productId,
    publicSessionId: sessionId,
  };
  const token = await signTenant(tenant, "24h");
  const production =
    process.env.NODE_ENV === "production"
      ? "; SameSite=None; Secure; Partitioned"
      : "; SameSite=Lax";
  return {
    token,
    sessionId,
    cookie: `${publicCookieName}=${token}; Path=/; HttpOnly; Max-Age=86400${production}`,
  };
}

/**
 * A guest session identity is minted here and nowhere else.
 *
 * It used to accept an identifier supplied by the caller so a page could
 * re-adopt its own session. Since a guest session now scopes the photos that
 * visitor uploaded, an identity anyone could claim by naming it would be no
 * protection at all. Continuity across a reload comes from `existing`, read
 * from the cookie.
 */
export async function createGuestSession(existing?: Tenant): Promise<{
  token: string;
  cookie: string;
}> {
  const sessionId = crypto.randomUUID();
  const tenant: Tenant =
    existing?.role === "guest"
      ? existing
      : {
          organizationId: DEMO_ORGANIZATION_ID,
          userId: `guest:${sessionId}`,
          role: "guest",
          publicSessionId: `guest:${sessionId}`,
        };
  const token = await signTenant(tenant, "24h");
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return {
    token,
    cookie: `${guestCookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`,
  };
}

async function signTenant(tenant: Tenant, expiresIn: string): Promise<string> {
  return new SignJWT({
    organizationId: tenant.organizationId,
    role: tenant.role,
    ...(tenant.publicProductId
      ? { publicProductId: tenant.publicProductId }
      : {}),
    ...(tenant.publicSessionId
      ? { publicSessionId: tenant.publicSessionId }
      : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(tenant.userId)
    .setIssuer("lilidecoai")
    .setAudience("lilidecoai-web")
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret());
}

export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export async function registerUser(
  db: Db,
  input: { name: string; email: string; password: string; studio: string },
): Promise<Tenant> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@") || input.password.length < 10) {
    throw new AuthError(
      "E-mail invalide ou mot de passe inférieur à 10 caractères",
      422,
    );
  }
  const c = collections(db);
  if (await c.users.findOne({ email })) {
    throw new AuthError("Ce compte existe déjà", 409);
  }
  const userId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const studioName = input.studio.trim() || "Atelier";
  const slugBase =
    studioName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 48) || "atelier";
  await c.organizations.insertOne({
    id: organizationId,
    name: studioName,
    slug: `${slugBase}-${organizationId.slice(0, 8)}`,
    createdAt: new Date(),
  });
  await c.users.insertOne({
    id: userId,
    email,
    passwordHash: await hash(input.password, 12),
    name: input.name.trim() || "Marchand",
    organizationId,
    role: "owner",
    createdAt: new Date(),
  });
  await c.wallets.insertOne({
    organizationId,
    balance: 3,
    processedKeys: [],
    updatedAt: new Date(),
  });
  await c.auditLogs.insertOne({
    id: crypto.randomUUID(),
    organizationId,
    userId,
    action: "organization.created",
    studio: studioName,
    createdAt: new Date(),
  });
  return { organizationId, userId, role: "owner" };
}

export async function authenticateUser(
  db: Db,
  emailValue: string,
  password: string,
): Promise<Tenant> {
  const user = await collections(db).users.findOne({
    email: emailValue.trim().toLowerCase(),
  });
  if (!user || !(await compare(password, user.passwordHash))) {
    throw new AuthError("Identifiants invalides", 401);
  }
  return {
    organizationId: user.organizationId,
    userId: user.id,
    role: user.role,
  };
}

function readCookie(request: Request, name: string): string | undefined {
  const cookie = request.headers.get("cookie");
  return cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
