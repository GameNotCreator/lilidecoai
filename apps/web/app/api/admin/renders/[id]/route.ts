import { z } from "zod";

import { withAdmin } from "@/lib/server/admin-route";
import { collections } from "@/lib/server/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Merchant diagnostics deliberately exclude visitors' photographs and tokens. */
export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return withAdmin(request, async ({ db, organization }) => {
    const id = z.uuid().parse((await context.params).id);
    const render = await collections(db).renders.findOne({
      id,
      organizationId: organization.id,
    });
    const headers = { "Cache-Control": "no-store" };
    if (!render) {
      return Response.json(
        { detail: "Rendu introuvable" },
        { status: 404, headers },
      );
    }
    return Response.json(
      {
        id: render.id,
        status: render.status,
        error: render.error ?? null,
        pipelineState: render.pipelineState ?? null,
        execution: render.execution
          ? {
              deadlineAt: render.execution.deadlineAt.toISOString(),
              attempts: render.execution.attempts,
              errorCode: render.execution.errorCode ?? null,
            }
          : null,
        createdAt: render.createdAt.toISOString(),
        updatedAt: render.updatedAt.toISOString(),
        estimatedCostUsd:
          render.usageTotals?.estimatedCostUsd ?? render.estimatedCostUsd ?? 0,
      },
      { headers },
    );
  });
}
