import "server-only";

import { calibrateSegment, calibrateSurface, type Quad } from "@lili/geometry";
import {
  renderRequestSchema,
  sceneAnalysisRequestSchema,
  segmentationRequestSchema,
  simplePlacementKindSchema,
  type CutoutMetadata,
} from "@lili/types";
import type { Db } from "mongodb";
import sharp from "sharp";
import { z } from "zod";

import {
  ApiInputError,
  assetUrl,
  deleteAsset,
  normalizeImage,
  prepareCutout,
  readAsset,
  privateVisibility,
  storeAsset,
  validateImage,
} from "./assets";
import {
  AuthError,
  authenticateUser,
  clearSessionCookie,
  createGuestSession,
  createPublicSession,
  createSession,
  registerUser,
  tenantForRequest,
  type Tenant,
} from "./auth";
import {
  archiveExpiry,
  productImageAssetIds,
  syncProductAssetVisibility,
} from "./admin-products";
import { cloudinaryStorageConfigured, serverConfig } from "./config";
import {
  CUTOUT_VERSION,
  CutoutUnusableError,
  cutoutTrust,
  cutoutVerdict,
} from "./cutout-identity";
import { CreditError, getCredits } from "./credits";
import { collections, database, pingMongo } from "./mongodb";
import {
  selectPlacementIntentProvider,
  selectSceneAnalysisProvider,
  selectSegmentationProvider,
} from "./ai";
import { enforceRateLimit } from "./rate-limit";
import { getOrEstimateSceneScale } from "./scale-estimation";
import { createRender, RenderError, type DeferRenderTask } from "./rendering";
import { stopRender } from "./render-lifecycle";
import { checkpointAssetIds } from "./checkpoint-assets";
import { buildRetryInput } from "./render-request";
import {
  productAssetVisibility,
  productListFilter,
  productOwnerSession,
} from "./product-visibility";
import { productResponse, renderResponse, sceneResponse } from "./serializers";
import { ensureDemoCredits, ensureDemoSeed } from "./seed";
import type {
  CalibrationDocument,
  ProductDocument,
  SceneDocument,
  SegmentationDocument,
} from "./types";
import {
  DEMO_MERCHANT_SLUG,
} from "./types";

const productCreateSchema = z.object({
  temporary: z.boolean().default(false),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).default(""),
  objectType: z
    .enum([
      "vase",
      "lamp",
      "frame",
      "mirror",
      "rug",
      "furniture",
      "plant",
      "clock",
      "other",
    ])
    .default("other"),
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

const placementIntentSchema = z.object({
  productId: z.string().uuid(),
  instruction: z.string().trim().max(1_500).default(""),
});

const sceneScaleSchema = z.object({
  points: z
    .array(
      z.object({
        x: z.number().finite().min(0).max(1),
        y: z.number().finite().min(0).max(1),
      }),
    )
    .min(1)
    .max(3),
  kinds: z.array(simplePlacementKindSchema).max(3).optional(),
});

export async function dispatchApi(
  request: Request,
  path: string[],
  deferRenderTask?: DeferRenderTask,
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
        imagePipeline: {
          mode: "simple_point",
          mockMode: serverConfig.aiMockMode,
          activeDemoProvider: serverConfig.aiMockMode
            ? "mock"
            : serverConfig.openaiApiKey
              ? "openai"
              : "unavailable",
          activeDemoModel: serverConfig.aiMockMode
            ? "mock"
            : serverConfig.openaiApiKey
              ? serverConfig.openaiModel
              : null,
          executionMode: process.env.RENDER_EXECUTION_MODE === "durable" ? "durable" : "web",
          openAIConfigured: Boolean(serverConfig.openaiApiKey),
          googleConfigured: Boolean(serverConfig.googleApiKey),
          previewModel: serverConfig.googlePreviewImageModel,
          finalModel: serverConfig.googleFinalImageModel,
          openAIEnabled: Boolean(
            serverConfig.openAIImageEnabled && serverConfig.openaiApiKey,
          ),
        },
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
      if (path[1] === DEMO_MERCHANT_SLUG) {
        await ensureDemoSeed(db);
        await ensureDemoCredits(db);
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
      return await handleRenders(
        db,
        tenant,
        request,
        path.slice(1),
        deferRenderTask,
      );
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
  if (path[0] === "guest" && request.method === "POST") {
    await ensureDemoSeed(db);
    await ensureDemoCredits(db);
    // The body may still carry a `sessionId`; it is deliberately ignored.
    // A visitor session is what scopes their uploaded photos, so an identity
    // anyone can claim by sending its identifier is not an identity. Continuity
    // across a reload comes from the cookie, which the browser cannot forge.
    const currentTenant = await tenantForRequest(request).catch(() => null);
    const session = await createGuestSession(
      currentTenant?.role === "guest" ? currentTenant : undefined,
    );
    return Response.json(
      { authenticated: true, role: "guest", accessToken: session.token },
      { status: 201, headers: { "Set-Cookie": session.cookie } },
    );
  }
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
      .find(productListFilter(tenant))
      .sort({ createdAt: -1 })
      .toArray();
    return Response.json(products.map(productResponse));
  }
  if (path.length === 0 && request.method === "POST") {
    requireProductEditor(tenant);
    const body = productCreateSchema.parse(await request.json());
    const now = new Date();
    const product: ProductDocument = {
      id: crypto.randomUUID(),
      organizationId: tenant.organizationId,
      createdByUserId: tenant.userId,
      name: body.name,
      description: body.description,
      objectType: body.objectType,
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
      ...(body.temporary
        ? {
            expiresAt: new Date(
              Date.now() + serverConfig.roomRetentionHours * 60 * 60 * 1000,
            ),
          }
        : {}),
    };
    await c.products.insertOne(product);
    return Response.json(productResponse(product), { status: 201 });
  }

  const productId = path[0] as string;
  const product = await c.products.findOne({
    organizationId: tenant.organizationId,
    id: productId,
    ...(tenant.publicProductId ? { id: tenant.publicProductId } : {}),
    ...(tenant.role === "guest" ? { createdByUserId: tenant.userId } : {}),
  });
  if (!product) return error("Produit introuvable", 404);

  if (path.length === 1 && request.method === "GET") {
    return Response.json(productResponse(product));
  }
  requireProductEditor(tenant);
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
    // Archiving hides the product; its images used to stay forever, because
    // nothing ever stamped an expiry on them and the purge only reads
    // `expiresAt`. They now follow the room-photo retention — and
    // `setProductStatus` lifts that stamp again if the product is restored.
    const expiresAt = archiveExpiry();
    await syncProductAssetVisibility(db, product, "archived");
    await c.products.updateOne(
      { id: product.id },
      { $set: { status: "archived", expiresAt, updatedAt: new Date() } },
    );
    const imageIds = productImageAssetIds(product);
    if (imageIds.length) {
      await c.assets.updateMany(
        { id: { $in: imageIds }, expiresAt: { $exists: false } },
        { $set: { expiresAt } },
      );
    }
    return new Response(null, { status: 204 });
  }
  if (path[1] === "assets" && request.method === "POST") {
    const file = await uploadedFile(request);
    const viewType = z
      .enum(["front", "three_quarter", "side", "back", "detail"])
      .parse(file.fields.viewType ?? "front");
    const currentViews = product.views ?? [];
    if (
      currentViews.length >= 4 &&
      !currentViews.some((view) => view.type === viewType)
    ) {
      throw new ApiInputError("Maximum 4 vues par produit");
    }
    await validateImage(file.buffer, file.contentType);
    const normalized = await normalizeImage(file.buffer);
    const metadata = await sharp(normalized).metadata();
    const asset = await storeAsset(db, {
      organizationId: tenant.organizationId,
      kind: viewType === "front" ? "product" : "product_view",
      visibility: productAssetVisibility({ ...product, status: "processing" }),
      buffer: normalized,
      contentType: "image/webp",
      ...(product.expiresAt ? { expiresAt: product.expiresAt } : {}),
    });
    const previousView = currentViews.find((view) => view.type === viewType);
    if (previousView?.assetId) await deleteAsset(db, previousView.assetId);
    if (
      viewType === "front" &&
      product.assetId &&
      product.assetId !== previousView?.assetId
    ) {
      await deleteAsset(db, product.assetId);
    }
    const view = {
      id: previousView?.id ?? crypto.randomUUID(),
      assetId: asset.id,
      type: viewType,
      widthPx: metadata.width ?? 0,
      heightPx: metadata.height ?? 0,
      validationStatus: "valid" as const,
      createdAt: previousView?.createdAt ?? new Date(),
    };
    const views = [
      ...currentViews.filter((candidate) => candidate.type !== viewType),
      view,
    ];
    const nextAssetId =
      viewType === "front" ? asset.id : (product.assetId ?? asset.id);
    await c.products.updateOne(
      { id: product.id },
      {
        $set: {
          assetId: nextAssetId,
          views,
          status: "processing",
          updatedAt: new Date(),
        },
        // A new front photo invalidates the cutout made from the old one —
        // the same drift the back-office route had, now mirrored here. Kept,
        // the product would size and anchor from one photo and render another.
        ...(viewType === "front"
          ? { $unset: { cutoutAssetId: "", cutout: "" } }
          : {}),
      },
    );
    if (viewType === "front" && product.cutoutAssetId) {
      await deleteAsset(db, product.cutoutAssetId).catch(() => undefined);
    }
    const updated = await c.products.findOne({
      id: product.id,
      organizationId: product.organizationId,
    });
    if (!updated) return error("Produit introuvable", 404);
    await syncProductAssetVisibility(db, updated);
    return Response.json(productResponse(updated));
  }
  if (path[1] === "prepare" && request.method === "POST") {
    if (!product.assetId) throw new ApiInputError("Photo produit requise");
    const source = await readAsset(db, product.assetId);
    if (!source) return error("Photo produit introuvable", 404);
    const cutout = await prepareCutout(source.buffer);
    const warnings = [...cutout.warnings];
    // PRO-008 / A03. The model used to RE-RENDER the product here whenever the
    // local matte struggled, and that image became the cutout — that is, the
    // identity reference the render composites and re-stamps over its own
    // output. The only check was that the result was transparent enough, never
    // that it was still the customer's object.
    //
    // It cannot be salvaged by using the model's alpha over the original
    // pixels either: `selectOutputSize` quantises the request to three aspect
    // buckets, no mask is sent, and the answer comes back at 0.5-0.75x the
    // source resolution, so nothing relates the two grids. The call is gone.
    //
    // What replaces it is a verdict. Two outcomes are genuinely unusable and
    // are refused; every softer doubt is recorded and still shipped, because
    // its frequency on real photos has never been measured and refusing on a
    // guess would turn away customers whose photo works.
    const verdict = cutoutVerdict(cutout.quality);
    if (!verdict.usable) throw new CutoutUnusableError(verdict);
    const metadata: CutoutMetadata = {
      widthPx: cutout.widthPx,
      heightPx: cutout.heightPx,
      baseRowFraction: cutout.baseRowFraction,
      source: "heuristic",
      synthetic: false,
      shadowRemoved: cutout.shadowRemoved,
      warnings,
      cutoutVersion: CUTOUT_VERSION,
      verdict,
    };
    const asset = await storeAsset(db, {
      organizationId: tenant.organizationId,
      kind: "cutout",
      visibility: productAssetVisibility(product),
      buffer: cutout.buffer,
      contentType: "image/webp",
      ...(product.expiresAt ? { expiresAt: product.expiresAt } : {}),
    });
    if (product.cutoutAssetId) await deleteAsset(db, product.cutoutAssetId);
    await c.products.updateOne(
      { id: product.id },
      {
        $set: {
          cutoutAssetId: asset.id,
          cutout: metadata,
          status: "ready",
          updatedAt: new Date(),
        },
      },
    );
    const updated = await c.products.findOne({
      id: product.id,
      organizationId: product.organizationId,
    });
    if (!updated) return error("Produit introuvable", 404);
    await syncProductAssetVisibility(db, updated);
    return Response.json(productResponse(updated));
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
    // Uploading a room photo is free of model cost but not of storage, and it
    // is the entry point of every paid step that follows.
    await enforcePaidLimit(db, tenant, "scene-upload", 20, 500, 600_000);
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
      visibility: privateVisibility(tenant.publicSessionId),
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
  if (path[1] === "prepare" && request.method === "POST") {
    await enforceRateLimit(
      db,
      tenant.organizationId,
      "placement-intent",
      20,
      300_000,
    );
    const input = placementIntentSchema.parse(await request.json());
    if (tenant.publicProductId && input.productId !== tenant.publicProductId) {
      throw new AuthError("Produit non autorisé", 403);
    }
    const product = await c.products.findOne({
      id: input.productId,
      organizationId: tenant.organizationId,
      status: "ready",
    });
    if (!product?.cutoutAssetId) {
      throw new ApiInputError("Produit prêt introuvable");
    }
    // PRO-008. `ready` records that a cutout exists, nothing about where its
    // pixels came from. This analysis is a paid vision call spent on that
    // cutout, and the render would refuse the same product right after it —
    // refuse here, before the money goes. Found by the adversarial review.
    const intentTrust = cutoutTrust(product.cutout);
    if (!intentTrust.trusted) throw new ApiInputError(intentTrust.message);
    const [sceneAsset, productAsset] = await Promise.all([
      readAsset(db, scene.assetId),
      readAsset(db, product.cutoutAssetId),
    ]);
    if (!sceneAsset || !productAsset) {
      throw new ApiInputError("Les images nécessaires sont introuvables");
    }
    const surfaceMapping = {
      table: "tabletop",
      nightstand: "tabletop",
      shelf: "shelf",
      niche: "niche",
      wall: "wall",
      floor: "floor",
    } as const;
    const productSurfaceType =
      surfaceMapping[product.placementType as keyof typeof surfaceMapping] ??
      "floor";
    const intent = await selectPlacementIntentProvider().resolve({
      room: {
        data: new Uint8Array(sceneAsset.buffer),
        mimeType: sceneAsset.asset.contentType as
          "image/jpeg" | "image/png" | "image/webp",
        role: "room_original",
      },
      product: {
        data: new Uint8Array(productAsset.buffer),
        mimeType: productAsset.asset.contentType as
          "image/jpeg" | "image/png" | "image/webp",
        role: "product_front",
      },
      instruction: input.instruction,
      productName: product.name,
      productDescription: product.description,
      productSurfaceType,
      productDimensionsCm: {
        width: product.widthCm,
        height: product.heightCm,
        depth: product.depthCm,
      },
    });
    const intentMetadata = {
      mode: intent.mode,
      surfaceType: intent.surfaceType,
      placementPoint: intent.placementPoint,
      ...(intent.targetPoint ? { targetPoint: intent.targetPoint } : {}),
      ...(intent.targetLabel ? { targetLabel: intent.targetLabel } : {}),
      confidence: intent.confidence,
      needsClarification: intent.needsClarification,
      rationale: intent.rationale,
      provider: intent.providerResult.provider,
      model: intent.providerResult.model,
      durationMs: intent.providerResult.durationMs,
      createdAt: new Date(),
    };
    await c.scenes.updateOne(
      { id: scene.id },
      { $set: { "analysis.lastIntent": intentMetadata } },
    );
    if (intent.needsClarification) {
      return Response.json({
        ...intentMetadata,
        needsClarification: true,
      });
    }
    if (intent.mode !== "replace") {
      return Response.json(intentMetadata);
    }
    if (!intent.targetPoint) {
      return Response.json({
        ...intentMetadata,
        needsClarification: true,
        rationale: "L’élément présent n’a pas pu être localisé avec certitude.",
      });
    }
    const segmented = await selectSegmentationProvider().segment({
      room: {
        data: new Uint8Array(sceneAsset.buffer),
        mimeType: sceneAsset.asset.contentType as
          "image/jpeg" | "image/png" | "image/webp",
        role: "room_original",
      },
      point: intent.targetPoint,
    });
    if (segmented.confidence < 0.45) {
      return Response.json({
        ...intentMetadata,
        needsClarification: true,
        rationale:
          "L’objet a été repéré, mais sa zone reste ambiguë. Indiquez-le sur la photo.",
      });
    }
    const maskAsset = await storeAsset(db, {
      organizationId: tenant.organizationId,
      kind: "mask",
      visibility: privateVisibility(tenant.publicSessionId),
      buffer: Buffer.from(segmented.mask.data),
      contentType: "image/png",
      expiresAt: scene.expiresAt,
    });
    const confirmedAt = new Date();
    const segmentation: SegmentationDocument = {
      id: crypto.randomUUID(),
      organizationId: tenant.organizationId,
      sceneId: scene.id,
      ...(tenant.publicSessionId
        ? { publicSessionId: tenant.publicSessionId }
        : {}),
      point: intent.targetPoint,
      maskAssetId: maskAsset.id,
      label: segmented.label || intent.targetLabel || "objet sélectionné",
      confidence: segmented.confidence,
      box: segmented.box,
      status: "confirmed",
      provider: segmented.providerResult.provider,
      model: segmented.providerResult.model,
      createdAt: confirmedAt,
      confirmedAt,
    };
    await c.segmentations.insertOne(segmentation);
    return Response.json({
      ...intentMetadata,
      needsClarification: false,
      segmentation: {
        id: segmentation.id,
        status: segmentation.status,
        label: segmentation.label,
        confidence: segmentation.confidence,
        box: segmentation.box,
        maskUrl: assetUrl(segmentation.maskAssetId),
      },
    });
  }
  if (path[1] === "analyse" && request.method === "POST") {
    await enforceRateLimit(
      db,
      tenant.organizationId,
      "scene-analysis",
      30,
      300_000,
    );
    const body = await request.json().catch(() => ({}));
    const input = sceneAnalysisRequestSchema.parse(body);
    const sceneAsset = await readAsset(db, scene.assetId);
    if (!sceneAsset) return error("Photo de pièce introuvable", 404);
    const provider = selectSceneAnalysisProvider();
    const analysis = await provider.analyze({
      room: {
        data: new Uint8Array(sceneAsset.buffer),
        mimeType: sceneAsset.asset.contentType as
          "image/jpeg" | "image/png" | "image/webp",
        role: "room_original",
      },
      placementPoint: input.placementPoint,
      surfaceType: input.surfaceType,
      productDimensionsCm: {
        width: input.dimensionsCm.width,
        height: input.dimensionsCm.height,
        depth: input.dimensionsCm.depth,
      },
      ...(input.calibration
        ? { calibration: input.calibration as Record<string, unknown> }
        : {}),
    });
    const analysisDocument = analysis as unknown as Record<string, unknown>;
    await c.scenes.updateOne(
      { id: scene.id },
      { $set: { analysis: analysisDocument, status: "analysed" } },
    );
    return Response.json(
      sceneResponse({
        ...scene,
        analysis: analysisDocument,
        status: "analysed",
      }),
    );
  }
  if (path[1] === "segment" && request.method === "POST") {
    await enforceRateLimit(
      db,
      tenant.organizationId,
      "segmentation",
      30,
      300_000,
    );
    const input = segmentationRequestSchema.parse(await request.json());
    const sceneAsset = await readAsset(db, scene.assetId);
    if (!sceneAsset) return error("Photo de pièce introuvable", 404);
    const provider = selectSegmentationProvider();
    const segmented = await provider.segment({
      room: {
        data: new Uint8Array(sceneAsset.buffer),
        mimeType: sceneAsset.asset.contentType as
          "image/jpeg" | "image/png" | "image/webp",
        role: "room_original",
      },
      point: input.point,
      positivePoints: input.positivePoints,
      negativePoints: input.negativePoints,
    });
    const maskAsset = await storeAsset(db, {
      organizationId: tenant.organizationId,
      kind: "mask",
      visibility: privateVisibility(tenant.publicSessionId),
      buffer: Buffer.from(segmented.mask.data),
      contentType: "image/png",
      expiresAt: scene.expiresAt,
    });
    const segmentation = {
      id: crypto.randomUUID(),
      organizationId: tenant.organizationId,
      sceneId: scene.id,
      ...(tenant.publicSessionId
        ? { publicSessionId: tenant.publicSessionId }
        : {}),
      point: input.point,
      maskAssetId: maskAsset.id,
      label: segmented.label,
      confidence: segmented.confidence,
      box: segmented.box,
      status: "proposed" as const,
      provider: segmented.providerResult.provider,
      model: segmented.providerResult.model,
      createdAt: new Date(),
    };
    await c.segmentations.insertOne(segmentation);
    return Response.json(
      {
        id: segmentation.id,
        status: segmentation.status,
        label: segmentation.label,
        confidence: segmentation.confidence,
        box: segmentation.box,
        maskUrl: assetUrl(segmentation.maskAssetId),
        provider: segmentation.provider,
        model: segmentation.model,
      },
      { status: 201 },
    );
  }
  if (
    path[1] === "segments" &&
    path[3] === "confirm" &&
    request.method === "POST"
  ) {
    const segmentation = await c.segmentations.findOne({
      id: path[2],
      sceneId: scene.id,
      organizationId: tenant.organizationId,
      ...(tenant.publicSessionId
        ? { publicSessionId: tenant.publicSessionId }
        : {}),
    });
    if (!segmentation) return error("Masque introuvable", 404);
    let maskAssetId = segmentation.maskAssetId;
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const uploaded = await uploadedFile(request);
      await validateImage(uploaded.buffer, uploaded.contentType);
      const corrected = await sharp(uploaded.buffer, { failOn: "error" })
        .rotate()
        .resize({ width: scene.widthPx, height: scene.heightPx, fit: "fill" })
        .ensureAlpha()
        .png()
        .toBuffer();
      const maskAsset = await storeAsset(db, {
        organizationId: tenant.organizationId,
        kind: "mask",
        visibility: privateVisibility(tenant.publicSessionId),
        buffer: corrected,
        contentType: "image/png",
        expiresAt: scene.expiresAt,
      });
      maskAssetId = maskAsset.id;
    }
    const confirmedAt = new Date();
    await c.segmentations.updateOne(
      { id: segmentation.id },
      {
        $set: {
          maskAssetId,
          status: "confirmed",
          confirmedAt,
        },
      },
    );
    return Response.json({
      id: segmentation.id,
      status: "confirmed",
      label: segmentation.label,
      confidence: segmentation.confidence,
      box: segmentation.box,
      maskUrl: assetUrl(maskAssetId),
      confirmedAt: confirmedAt.toISOString(),
    });
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
  if (path[1] === "scale" && request.method === "POST") {
    // Free pre-flight: the customer sees the measured scale before paying,
    // and the render reuses this exact cached answer.
    await enforcePaidLimit(db, tenant, "scene-scale", 10, 300, 300_000);
    const input = sceneScaleSchema.parse(await request.json());
    const kinds = input.points.map(
      (_, index) => input.kinds?.[index] ?? "standing",
    );
    const result = await getOrEstimateSceneScale(
      db,
      scene,
      input.points,
      kinds,
    );
    return Response.json({ spans: result.spans, lighting: result.lighting });
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
  deferRenderTask?: DeferRenderTask,
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
  const qualityEndpoint =
    path.length === 1 && (path[0] === "preview" || path[0] === "final")
      ? path[0]
      : null;
  if (
    request.method === "POST" &&
    (path.length === 0 || qualityEndpoint !== null)
  ) {
    await enforcePaidLimit(db, tenant, "render", 12, 200, 600_000);
    const body = (await request.json()) as Record<string, unknown>;
    const input = renderRequestSchema.parse({
      ...body,
      ...(qualityEndpoint ? { outputQuality: qualityEndpoint } : {}),
    });
    if (tenant.publicSessionId) {
      if (
        tenant.publicProductId &&
        input.placement.productId !== tenant.publicProductId
      ) {
        throw new AuthError("Produit non autorisé", 403);
      }
      if (
        tenant.publicProductId &&
        input.simplePlacements?.some(
          (item) => item.productId !== tenant.publicProductId,
        )
      ) {
        throw new AuthError("Produit non autorisé", 403);
      }
      const ownedScene = await c.scenes.findOne({
        id: input.placement.sceneId,
        organizationId: tenant.organizationId,
        publicSessionId: tenant.publicSessionId,
      });
      if (!ownedScene) throw new AuthError("Scène non autorisée", 403);
    }
    const placementPoint = input.placementPoint ?? {
      x: input.placement.xNormalized as number,
      y: input.placement.yNormalized as number,
    };
    let targetMaskAssetId: string | undefined;
    if (input.mode === "replace" && input.workflow !== "simple_point") {
      const segmentation = await c.segmentations.findOne({
        id: input.targetMaskId,
        organizationId: tenant.organizationId,
        sceneId: input.placement.sceneId,
        status: "confirmed",
        ...(tenant.publicSessionId
          ? { publicSessionId: tenant.publicSessionId }
          : {}),
      });
      if (!segmentation) {
        throw new ApiInputError(
          "La zone sélectionnée doit être confirmée avant le rendu.",
        );
      }
      targetMaskAssetId = segmentation.maskAssetId;
    }
    const normalizedInput = {
      ...input,
      placementPoint,
      ...(targetMaskAssetId ? { targetMaskAssetId } : {}),
      placement: {
        ...input.placement,
        mode: input.mode,
        surfaceType:
          input.surfaceType ??
          input.placement.surfaceType ??
          (input.mode === "replace" ? "existing_object" : undefined),
        xNormalized: placementPoint.x,
        yNormalized: placementPoint.y,
        ...(input.targetPoint ? { targetPoint: input.targetPoint } : {}),
        ...(targetMaskAssetId ? { targetMaskAssetId } : {}),
        lighting: input.lighting,
      },
    };
    const result = await createRender(
      db,
      tenant.organizationId,
      normalizedInput,
      tenant.publicSessionId,
      deferRenderTask,
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
    const stopped = await stopRender(db, render, "delete");
    // Everything the render minted goes with it: the delivered image, the
    // deterministic composite, and any stage a corpus run captured. Leaving
    // the latter kept the customer's intermediate photos readable until the
    // scene expired, after they asked for the render to be gone.
    const minted = [
      stopped.resultAssetId,
      stopped.compositeAssetId,
      ...Object.values(stopped.stages ?? {}),
      ...checkpointAssetIds(stopped.execution?.steps),
    ].filter((id): id is string => Boolean(id));
    await Promise.allSettled(minted.map((id) => deleteAsset(db, id)));
    return new Response(null, { status: 204 });
  }
  if (path[1] === "cancel" && request.method === "POST") {
    return Response.json(
      renderResponse(await stopRender(db, render, "cancel")),
    );
  }
  if (path[1] === "feedback" && request.method === "POST") {
    const feedback = z
      .object({
        rating: z.number().int().min(1).max(5),
        comment: z.string().trim().max(1_000).optional(),
      })
      .parse(await request.json());
    const createdAt = new Date();
    await c.renderFeedback.insertOne({
      id: crypto.randomUUID(),
      organizationId: tenant.organizationId,
      renderId: render.id,
      ...(tenant.publicSessionId
        ? { publicSessionId: tenant.publicSessionId }
        : {}),
      rating: feedback.rating,
      ...(feedback.comment ? { comment: feedback.comment } : {}),
      createdAt,
    });
    await c.renders.updateOne(
      { id: render.id },
      { $set: { feedback: { ...feedback, createdAt }, updatedAt: createdAt } },
    );
    return Response.json({ saved: true }, { status: 201 });
  }
  if (path[1] === "retry" && request.method === "POST") {
    await enforcePaidLimit(db, tenant, "render", 12, 200, 600_000);
    const retryInput = buildRetryInput(render);
    const result = await createRender(
      db,
      tenant.organizationId,
      retryInput,
      tenant.publicSessionId,
      deferRenderTask,
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

/**
 * Every visitor of the public demo shares the demo organization, so an
 * organization-wide window on a paid action would let one visitor exhaust the
 * quota for everybody. Those windows are counted per visitor instead.
 */
function visitorScope(tenant: Tenant): string | undefined {
  if (tenant.publicSessionId) return tenant.publicSessionId;
  return tenant.role === "guest" ? tenant.userId : undefined;
}

/**
 * A paid action is counted twice: once per visitor, so one person cannot
 * exhaust the shared demo quota for everybody, and once for the organization
 * as a whole, so the demo keeps an absolute ceiling that no number of fresh
 * guest sessions can lift. A per-visitor window alone is not a spending cap —
 * `/v1/auth/guest` hands out visitor identities for free.
 */
async function enforcePaidLimit(
  db: Db,
  tenant: Tenant,
  action: string,
  perVisitor: number,
  perOrganization: number,
  windowMs: number,
): Promise<void> {
  const scope = visitorScope(tenant);
  if (scope) {
    await enforceRateLimit(
      db,
      tenant.organizationId,
      action,
      perVisitor,
      windowMs,
      scope,
    );
  }
  await enforceRateLimit(
    db,
    tenant.organizationId,
    action,
    perOrganization,
    windowMs,
  );
}

export { productAssetVisibility, productOwnerSession };

function requireMerchant(tenant: Tenant): void {
  if (
    tenant.publicSessionId ||
    !["owner", "admin", "member", "platform_admin"].includes(tenant.role)
  ) {
    throw new AuthError("Droits marchand requis", 403);
  }
}

function requireProductEditor(tenant: Tenant): void {
  if (
    (tenant.publicSessionId && tenant.role !== "guest") ||
    !["owner", "admin", "member", "guest", "platform_admin"].includes(
      tenant.role,
    )
  ) {
    throw new AuthError("Modification de produit non autorisée", 403);
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

async function uploadedFile(request: Request): Promise<{
  buffer: Buffer;
  contentType: string;
  fields: Record<string, string>;
}> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiInputError("Fichier requis");
  const fields: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") fields[key] = value;
  }
  return {
    buffer: Buffer.from(await file.arrayBuffer()),
    contentType: file.type,
    fields,
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
