import "server-only";

import { calibrateSegment, calibrateSurface, type Quad } from "@lili/geometry";
import type { Db } from "mongodb";
import sharp from "sharp";
import { z } from "zod";

import {
  ApiInputError,
  createCutout,
  deleteAsset,
  normalizeImage,
  readAsset,
  storeAsset,
  validateImage,
} from "./assets";
import {
  AuthError,
  authenticateUser,
  clearSessionCookie,
  createPublicSession,
  createSession,
  registerUser,
  tenantForRequest,
  type Tenant,
} from "./auth";
import { cloudinaryStorageConfigured, serverConfig } from "./config";
import { CreditError, getCredits } from "./credits";
import { collections, database, pingMongo } from "./mongodb";
import { createRender, RenderError } from "./rendering";
import { productResponse, renderResponse, sceneResponse } from "./serializers";
import { ensureDemoSeed } from "./seed";
import type {
  CalibrationDocument,
  ProductDocument,
  SceneDocument,
} from "./types";
import { DEMO_MERCHANT_SLUG, DEMO_PRODUCT_ID } from "./types";

const productCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).default(""),
  sku: z.string().trim().max(80).nullable().optional(),
  widthCm: z.number().positive().max(1000),
  heightCm: z.number().positive().max(1000),
  depthCm: z.number().nonnegative().max(1000),
  material: z.string().trim().min(2).max(120),
  generationInstructions: z.string().trim().max(1500).default(""),
  placementType: z.enum([
    "table",
    "nightstand",
    "shelf",
    "niche",
    "wall",
    "floor",
  ]),
  lightingProfile: z.record(z.string(), z.unknown()).default({}),
  buyUrl: z.url().nullable().optional(),
});

const renderCreateSchema = z.object({
  placement: z.object({
    sceneId: z.string().uuid(),
    productId: z.string().uuid(),
    calibrationId: z.string().uuid().optional(),
    mode: z.string().max(20).optional(),
    surfaceType: z
      .enum(["table", "nightstand", "shelf", "niche", "wall", "floor"])
      .optional(),
    xNormalized: z.number().min(0).max(1).optional(),
    yNormalized: z.number().min(0).max(1).optional(),
    scale: z.number().min(0.04).max(0.75).optional(),
    rotationDegrees: z.number().min(-180).max(180).optional(),
    lighting: z
      .object({
        direction: z.string().max(30).optional(),
        temperature: z.string().max(30).optional(),
        hardness: z.string().max(30).optional(),
      })
      .optional(),
  }),
  idempotencyKey: z.string().min(1).max(160),
  quality: z.string().max(30).optional(),
});

export async function dispatchApi(
  request: Request,
  path: string[],
): Promise<Response> {
  try {
    if (path[0] === "health" && request.method === "GET") {
      return Response.json({
        status: "ok",
        database: (await pingMongo()) ? "mongodb" : "unavailable",
        storage: cloudinaryStorageConfigured()
          ? "cloudinary"
          : "mongodb-fallback",
        authentication: serverConfig.demoMode ? "demo" : "required",
        runtime: "nextjs-vercel",
      });
    }

    const db = await database();
    if (serverConfig.demoMode) {
      await ensureDemoSeed(db);
    }

    if (path[0] === "auth") {
      return await handleAuth(db, request, path.slice(1));
    }
    if (
      path[0] === "visualizer" &&
      path.length === 3 &&
      request.method === "GET"
    ) {
      if (path[1] === DEMO_MERCHANT_SLUG && path[2] === DEMO_PRODUCT_ID) {
        await ensureDemoSeed(db);
      }
      return await publicVisualizer(db, path[1] as string, path[2] as string);
    }

    const tenant = await tenantForRequest(request);
    if (path[0] === "products") {
      return await handleProducts(db, tenant, request, path.slice(1));
    }
    if (path[0] === "scenes") {
      return await handleScenes(db, tenant, request, path.slice(1));
    }
    if (path[0] === "renders") {
      return await handleRenders(db, tenant, request, path.slice(1));
    }
    if (path[0] === "credits" && request.method === "GET") {
      const credits = await getCredits(db, tenant.organizationId);
      return Response.json(
        tenant.publicSessionId
          ? { balance: credits.balance > 0 ? 1 : 0, transactions: [] }
          : credits,
      );
    }
    if (path[0] === "analytics" && request.method === "POST") {
      return await handleAnalytics(db, tenant, request);
    }
    if (path[0] === "widgets") {
      requireMerchant(tenant);
      return await handleWidgets(db, tenant, request, path.slice(1));
    }
    if (
      path[0] === "admin" &&
      path[1] === "overview" &&
      request.method === "GET"
    ) {
      requireMerchant(tenant);
      return await adminOverview(db, tenant);
    }
    if (
      path[0] === "admin" &&
      path[1] === "audit" &&
      request.method === "GET"
    ) {
      requireMerchant(tenant);
      return await adminAudit(db, tenant);
    }
    return error("Route introuvable", 404);
  } catch (reason) {
    return errorResponse(reason);
  }
}

async function handleAuth(
  db: Db,
  request: Request,
  path: string[],
): Promise<Response> {
  if (path[0] === "signup" && request.method === "POST") {
    const body = (await request.json()) as {
      name?: string;
      email?: string;
      password?: string;
      studio?: string;
    };
    const tenant = await registerUser(db, {
      name: body.name ?? "",
      email: body.email ?? "",
      password: body.password ?? "",
      studio: body.studio ?? "",
    });
    const session = await createSession(tenant);
    return Response.json(
      { authenticated: true },
      { status: 201, headers: { "Set-Cookie": session.cookie } },
    );
  }
  if (path[0] === "login" && request.method === "POST") {
    const body = (await request.json()) as {
      email?: string;
      password?: string;
    };
    const tenant = await authenticateUser(
      db,
      body.email ?? "",
      body.password ?? "",
    );
    const session = await createSession(tenant);
    return Response.json(
      { authenticated: true },
      { headers: { "Set-Cookie": session.cookie } },
    );
  }
  if (path[0] === "logout" && request.method === "POST") {
    return Response.json(
      { authenticated: false },
      { headers: { "Set-Cookie": clearSessionCookie() } },
    );
  }
  if (path[0] === "me" && request.method === "GET") {
    const tenant = await tenantForRequest(request);
    const organization = await collections(db).organizations.findOne({
      id: tenant.organizationId,
    });
    return Response.json({
      ...tenant,
      organization: organization
        ? { name: organization.name, slug: organization.slug }
        : null,
    });
  }
  return error("Route d’authentification introuvable", 404);
}

async function handleProducts(
  db: Db,
  tenant: Tenant,
  request: Request,
  path: string[],
): Promise<Response> {
  const c = collections(db);
  if (path.length === 0 && request.method === "GET") {
    const products = await c.products
      .find({
        organizationId: tenant.organizationId,
        status: { $ne: "archived" },
        ...(tenant.publicProductId
          ? { id: tenant.publicProductId, status: "ready" as const }
          : {}),
      })
      .sort({ createdAt: -1 })
      .toArray();
    return Response.json(products.map(productResponse));
  }
  if (path.length === 0 && request.method === "POST") {
    requireMerchant(tenant);
    const body = productCreateSchema.parse(await request.json());
    const now = new Date();
    const product: ProductDocument = {
      id: crypto.randomUUID(),
      organizationId: tenant.organizationId,
      name: body.name,
      description: body.description,
      sku: body.sku ?? null,
      widthCm: body.widthCm,
      heightCm: body.heightCm,
      depthCm: body.depthCm,
      material: body.material,
      placementType: body.placementType,
      generationInstructions: body.generationInstructions,
      lightingProfile: body.lightingProfile,
      buyUrl: body.buyUrl ?? null,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    await c.products.insertOne(product);
    return Response.json(productResponse(product), { status: 201 });
  }

  const productId = path[0] as string;
  const product = await c.products.findOne({
    organizationId: tenant.organizationId,
    id: productId,
    ...(tenant.publicProductId ? { id: tenant.publicProductId } : {}),
  });
  if (!product) return error("Produit introuvable", 404);

  if (path.length === 1 && request.method === "GET") {
    return Response.json(productResponse(product));
  }
  requireMerchant(tenant);
  if (path.length === 1 && request.method === "PATCH") {
    const patch = productCreateSchema.partial().parse(await request.json());
    await c.products.updateOne(
      { id: product.id },
      { $set: { ...patch, updatedAt: new Date() } },
    );
    return Response.json(
      productResponse({ ...product, ...patch, updatedAt: new Date() }),
    );
  }
  if (path.length === 1 && request.method === "DELETE") {
    await c.products.updateOne(
      { id: product.id },
      { $set: { status: "archived", updatedAt: new Date() } },
    );
    return new Response(null, { status: 204 });
  }
  if (path[1] === "assets" && request.method === "POST") {
    const file = await uploadedFile(request);
    await validateImage(file.buffer, file.contentType);
    const normalized = await normalizeImage(file.buffer);
    const asset = await storeAsset(db, {
      organizationId: tenant.organizationId,
      kind: "product",
      buffer: normalized,
      contentType: "image/webp",
    });
    if (product.assetId) await deleteAsset(db, product.assetId);
    await c.products.updateOne(
      { id: product.id },
      {
        $set: {
          assetId: asset.id,
          status: "processing",
          updatedAt: new Date(),
        },
      },
    );
    return Response.json(
      productResponse({
        ...product,
        assetId: asset.id,
        status: "processing",
        updatedAt: new Date(),
      }),
    );
  }
  if (path[1] === "prepare" && request.method === "POST") {
    if (!product.assetId) throw new ApiInputError("Photo produit requise");
    const source = await readAsset(db, product.assetId);
    if (!source) return error("Photo produit introuvable", 404);
    const cutout = await createCutout(source.buffer);
    const asset = await storeAsset(db, {
      organizationId: tenant.organizationId,
      kind: "cutout",
      buffer: cutout,
      contentType: "image/webp",
    });
    if (product.cutoutAssetId) await deleteAsset(db, product.cutoutAssetId);
    await c.products.updateOne(
      { id: product.id },
      {
        $set: {
          cutoutAssetId: asset.id,
          status: "ready",
          updatedAt: new Date(),
        },
      },
    );
    return Response.json(
      productResponse({
        ...product,
        cutoutAssetId: asset.id,
        status: "ready",
        updatedAt: new Date(),
      }),
    );
  }
  if (path[1] === "anchor" && request.method === "POST") {
    const anchor = z
      .object({
        anchorType: z.string().max(40),
        xNormalized: z.number().min(0).max(1),
        yNormalized: z.number().min(0).max(1),
      })
      .parse(await request.json());
    await c.products.updateOne(
      { id: product.id },
      { $set: { anchor, updatedAt: new Date() } },
    );
    return Response.json(anchor, { status: 201 });
  }
  return error("Route produit introuvable", 404);
}

async function handleScenes(
  db: Db,
  tenant: Tenant,
  request: Request,
  path: string[],
): Promise<Response> {
  const c = collections(db);
  if (path.length === 0 && request.method === "POST") {
    const form = await request.formData();
    if (form.get("consent") !== "true") {
      throw new ApiInputError("Le consentement est requis");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiInputError("Photo requise");
    const input = Buffer.from(await file.arrayBuffer());
    await validateImage(input, file.type);
    const buffer = await normalizeImage(input);
    const metadata = await sharp(buffer).metadata();
    const expiresAt = new Date(
      Date.now() + serverConfig.roomRetentionHours * 60 * 60 * 1000,
    );
    const asset = await storeAsset(db, {
      organizationId: tenant.organizationId,
      kind: "scene",
      buffer,
      contentType: "image/webp",
      expiresAt,
    });
    const scene: SceneDocument = {
      id: crypto.randomUUID(),
      organizationId: tenant.organizationId,
      assetId: asset.id,
      status: "uploaded",
      widthPx: metadata.width ?? 0,
      heightPx: metadata.height ?? 0,
      analysis: {},
      ...(tenant.publicSessionId
        ? { publicSessionId: tenant.publicSessionId }
        : {}),
      consentAt: new Date(),
      createdAt: new Date(),
      expiresAt,
    };
    await c.scenes.insertOne(scene);
    return Response.json(sceneResponse(scene), { status: 201 });
  }

  const sceneId = path[0] as string;
  const scene = await c.scenes.findOne({
    organizationId: tenant.organizationId,
    id: sceneId,
    ...(tenant.publicSessionId
      ? { publicSessionId: tenant.publicSessionId }
      : {}),
  });
  if (!scene) return error("Scène introuvable", 404);
  if (path.length === 1 && request.method === "GET") {
    return Response.json(sceneResponse(scene));
  }
  if (path[1] === "analyse" && request.method === "POST") {
    const analysis = {
      orientation: scene.widthPx >= scene.heightPx ? "landscape" : "portrait",
      horizonY: 0.44,
      light: {
        direction: "left",
        temperature: "neutral",
        confidence: 0.72,
      },
      surfaces: [
        { type: "table", confidence: 0.86 },
        { type: "wall", confidence: 0.74 },
        { type: "floor", confidence: 0.62 },
      ],
    };
    await c.scenes.updateOne(
      { id: scene.id },
      { $set: { analysis, status: "analysed" } },
    );
    return Response.json(
      sceneResponse({ ...scene, analysis, status: "analysed" }),
    );
  }
  if (path[1] === "surfaces" && request.method === "POST") {
    const surface = {
      id: crypto.randomUUID(),
      ...((await request.json()) as Record<string, unknown>),
    };
    await c.scenes.updateOne(
      { id: scene.id },
      { $push: { "analysis.manualSurfaces": surface } },
    );
    return Response.json(surface, { status: 201 });
  }
  if (path[1] === "calibrate" && request.method === "POST") {
    const input = z
      .object({
        mode: z.enum(["quick", "wall", "surface"]),
        parameters: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(await request.json());
    const result = calibrationResult(scene, input.mode, input.parameters);
    const calibration: CalibrationDocument = {
      id: crypto.randomUUID(),
      organizationId: tenant.organizationId,
      sceneId: scene.id,
      mode: input.mode,
      label:
        input.mode === "quick"
          ? "Échelle estimée"
          : input.mode === "wall"
            ? "Mur calibré"
            : "Surface calibrée",
      parameters: input.parameters,
      result,
      createdAt: new Date(),
    };
    await c.calibrations.insertOne(calibration);
    return Response.json(
      {
        id: calibration.id,
        mode: calibration.mode,
        label: calibration.label,
        result,
      },
      { status: 201 },
    );
  }
  return error("Route scène introuvable", 404);
}

function calibrationResult(
  scene: SceneDocument,
  mode: "quick" | "wall" | "surface",
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  if (mode === "quick") {
    return { estimated: true, pixelsPerCentimeter: scene.widthPx / 300 };
  }
  if (mode === "wall") {
    const start = parameters.start as { x: number; y: number };
    const end = parameters.end as { x: number; y: number };
    return calibrateSegment(
      { x: start.x * scene.widthPx, y: start.y * scene.heightPx },
      { x: end.x * scene.widthPx, y: end.y * scene.heightPx },
      Number(parameters.realLengthCm),
    ) as unknown as Record<string, unknown>;
  }
  const corners = (parameters.corners as Array<{ x: number; y: number }>).map(
    (point) => ({
      x: point.x * scene.widthPx,
      y: point.y * scene.heightPx,
    }),
  ) as unknown as Quad;
  return calibrateSurface(
    corners,
    Number(parameters.widthCm),
    Number(parameters.depthCm),
  ) as unknown as Record<string, unknown>;
}

async function handleRenders(
  db: Db,
  tenant: Tenant,
  request: Request,
  path: string[],
): Promise<Response> {
  const c = collections(db);
  if (path.length === 0 && request.method === "GET") {
    const renders = await c.renders
      .find({
        organizationId: tenant.organizationId,
        ...(tenant.publicSessionId
          ? { publicSessionId: tenant.publicSessionId }
          : {}),
      })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    return Response.json(renders.map(renderResponse));
  }
  if (path.length === 0 && request.method === "POST") {
    const input = renderCreateSchema.parse(await request.json());
    if (tenant.publicSessionId) {
      if (input.placement.productId !== tenant.publicProductId) {
        throw new AuthError("Produit non autorisé", 403);
      }
      const ownedScene = await c.scenes.findOne({
        id: input.placement.sceneId,
        organizationId: tenant.organizationId,
        publicSessionId: tenant.publicSessionId,
      });
      if (!ownedScene) throw new AuthError("Scène non autorisée", 403);
    }
    const result = await createRender(
      db,
      tenant.organizationId,
      input,
      tenant.publicSessionId,
    );
    return Response.json(result, { status: 201 });
  }
  const render = await c.renders.findOne({
    organizationId: tenant.organizationId,
    id: path[0],
    ...(tenant.publicSessionId
      ? { publicSessionId: tenant.publicSessionId }
      : {}),
  });
  if (!render) return error("Rendu introuvable", 404);
  if (path.length === 1 && request.method === "GET") {
    return Response.json(renderResponse(render));
  }
  if (path.length === 1 && request.method === "DELETE") {
    if (render.resultAssetId) await deleteAsset(db, render.resultAssetId);
    await c.renders.updateOne(
      { id: render.id },
      { $set: { status: "deleted", updatedAt: new Date() } },
    );
    return new Response(null, { status: 204 });
  }
  if (path[1] === "retry" && request.method === "POST") {
    const retryInput = {
      placement: render.placement,
      idempotencyKey: `${render.idempotencyKey}:retry:${crypto.randomUUID()}`,
      quality: "medium",
    };
    const result = await createRender(
      db,
      tenant.organizationId,
      retryInput as unknown as Parameters<typeof createRender>[2],
      tenant.publicSessionId,
    );
    return Response.json(result, { status: 201 });
  }
  return error("Route rendu introuvable", 404);
}

async function handleAnalytics(
  db: Db,
  tenant: Tenant,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const serialized = JSON.stringify(body);
  if (/data:image|https?:\/\/.*\.(png|jpe?g|webp)/i.test(serialized)) {
    throw new ApiInputError("Les événements ne peuvent contenir aucune photo");
  }
  await collections(db).analytics.insertOne({
    id: crypto.randomUUID(),
    organizationId: tenant.organizationId,
    ...body,
    createdAt: new Date(),
  });
  return new Response(null, { status: 202 });
}

async function handleWidgets(
  db: Db,
  tenant: Tenant,
  request: Request,
  path: string[],
): Promise<Response> {
  const c = collections(db);
  if (path.length === 0 && request.method === "POST") {
    const body = (await request.json()) as Record<string, unknown>;
    const widget = {
      id: crypto.randomUUID(),
      organizationId: tenant.organizationId,
      enabled: true,
      allowedOrigins: [],
      ...body,
      createdAt: new Date(),
    };
    await c.auditLogs.insertOne({
      ...widget,
      action: "widget.created",
    });
    return Response.json(widget, { status: 201 });
  }
  if (path.length === 1 && request.method === "PATCH") {
    const patch = (await request.json()) as Record<string, unknown>;
    await c.auditLogs.updateOne(
      {
        id: path[0],
        organizationId: tenant.organizationId,
        action: "widget.created",
      },
      { $set: patch },
    );
    return Response.json({ id: path[0], ...patch });
  }
  return error("Route widget introuvable", 404);
}

async function publicVisualizer(
  db: Db,
  merchantSlug: string,
  productId: string,
): Promise<Response> {
  const organization = await collections(db).organizations.findOne({
    slug: merchantSlug,
  });
  if (!organization) return error("Marchand introuvable", 404);
  const product = await collections(db).products.findOne({
    id: productId,
    organizationId: organization.id,
    status: "ready",
  });
  if (!product) return error("Produit introuvable", 404);
  const session = await createPublicSession(organization.id, product.id);
  return Response.json(
    {
      merchant: { slug: organization.slug, name: organization.name },
      product: productResponse(product),
      widget: { enabled: true },
      accessToken: session.token,
    },
    { headers: { "Set-Cookie": session.cookie } },
  );
}

function requireMerchant(tenant: Tenant): void {
  if (tenant.role === "viewer" || tenant.publicSessionId) {
    throw new AuthError("Droits marchand requis", 403);
  }
}

async function adminOverview(db: Db, tenant: Tenant): Promise<Response> {
  const c = collections(db);
  const [renders, succeeded, attempts] = await Promise.all([
    c.renders.countDocuments({ organizationId: tenant.organizationId }),
    c.renders.countDocuments({
      organizationId: tenant.organizationId,
      status: "succeeded",
    }),
    c.renderAttempts
      .find({ organizationId: tenant.organizationId })
      .sort({ createdAt: -1 })
      .limit(25)
      .toArray(),
  ]);
  return Response.json({
    renders,
    succeeded,
    successRate: renders ? succeeded / renders : 0,
    recentEstimatedCostUsd: attempts.reduce(
      (sum, item) => sum + item.estimatedCostUsd,
      0,
    ),
    attempts: attempts.map((item) => ({
      ...item,
      _id: undefined,
      createdAt: item.createdAt.toISOString(),
    })),
  });
}

async function adminAudit(db: Db, tenant: Tenant): Promise<Response> {
  const logs = await collections(db)
    .auditLogs.find({ organizationId: tenant.organizationId })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  return Response.json(logs);
}

async function uploadedFile(
  request: Request,
): Promise<{ buffer: Buffer; contentType: string }> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiInputError("Fichier requis");
  return {
    buffer: Buffer.from(await file.arrayBuffer()),
    contentType: file.type,
  };
}

function error(message: string, status: number): Response {
  return Response.json({ detail: message }, { status });
}

function errorResponse(reason: unknown): Response {
  if (reason instanceof z.ZodError) {
    return error(reason.issues[0]?.message ?? "Données invalides", 422);
  }
  if (reason instanceof AuthError) return error(reason.message, reason.status);
  if (reason instanceof RenderError)
    return error(reason.message, reason.status);
  if (reason && typeof reason === "object" && "status" in reason) {
    const status = reason.status;
    const message = "message" in reason ? reason.message : null;
    if (
      typeof status === "number" &&
      status >= 400 &&
      status < 600 &&
      typeof message === "string"
    ) {
      return error(message, status);
    }
  }
  if (reason instanceof ApiInputError || reason instanceof CreditError) {
    return error(reason.message, 422);
  }
  if (
    reason &&
    typeof reason === "object" &&
    "code" in reason &&
    reason.code === 11000
  ) {
    return error("Cette opération existe déjà", 409);
  }
  console.error(reason);
  return error("Erreur interne", 500);
}
