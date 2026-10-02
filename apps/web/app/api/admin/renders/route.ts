import { z } from "zod";

import { withAdmin } from "../../../../lib/server/admin-route";
import { collections } from "../../../../lib/server/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const scaleEvidenceSchema = z.object({
  scaleSource: z.enum([
    "user", "vision", "vision_coarse", "vision_interpolated", "assumed_room_width",
  ]),
  confidence: z.enum(["high", "low", "none"]),
});

/** Bounded merchant diagnostics; never reads photographs or visitor identities. */
export async function GET(request: Request): Promise<Response> {
  return withAdmin(request, async ({ db, organization }) => {
    const productId = z.uuid().optional().parse(
      new URL(request.url).searchParams.get("productId") ?? undefined,
    );
    const renders = await collections(db).renders.find(
      {
        organizationId: organization.id,
        ...(productId ? {
          $or: [
            { productId },
            { "requestSnapshot.input.simplePlacements.productId": productId },
          ],
        } : {}),
      },
      {
        projection: {
          _id: 0, id: 1, status: 1, productId: 1, createdAt: 1, updatedAt: 1,
          pipelineState: 1, estimatedCostUsd: 1, "usageTotals.estimatedCostUsd": 1,
          "engineVersions.quality": 1, "placement.scaleSpans.scaleSource": 1,
          "placement.scaleSpans.confidence": 1,
        },
      },
    ).sort({ createdAt: -1, id: -1 }).limit(20).toArray();
    return Response.json({
      renders: renders.map((render) => {
        const spans = render.placement?.scaleSpans;
        const scaleEvidence = Array.isArray(spans)
          ? spans.slice(0, 3).flatMap((span: unknown) => {
              const parsed = scaleEvidenceSchema.safeParse(span);
              return parsed.success ? [parsed.data] : [];
            })
          : [];
        return {
          id: render.id,
          status: render.status,
          productId: render.productId,
          createdAt: render.createdAt.toISOString(),
          updatedAt: render.updatedAt.toISOString(),
          pipelineState: render.pipelineState ?? null,
          estimatedCostUsd:
            render.usageTotals?.estimatedCostUsd ?? render.estimatedCostUsd ?? 0,
          qualityVersion: render.engineVersions?.quality ?? null,
          scaleEvidence,
        };
      }),
    }, { headers: { "Cache-Control": "no-store" } });
  });
}
