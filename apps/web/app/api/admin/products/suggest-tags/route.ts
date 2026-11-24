import { z } from "zod";
import { detail, jsonBody, withAdmin } from "@/lib/server/admin-route";
import {
  groqTagSuggestionsAvailable,
  suggestGroqProductTags,
} from "@/lib/server/groq-product-tags";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const input = z
  .object({ description: z.string().trim().min(1).max(2_000) })
  .strict();

export function POST(request: Request) {
  return withAdmin(request, async ({ db, organization }) => {
    const { description } = input.parse(await jsonBody(request));
    if (!groqTagSuggestionsAvailable())
      return detail("Les suggestions de tags sont indisponibles.", 503);
    await enforceRateLimit(
      db,
      organization.id,
      "product-tag-suggestions",
      12,
      60_000,
    );
    try {
      return Response.json({ tags: await suggestGroqProductTags(description) });
    } catch {
      return detail(
        "Les suggestions de tags n’ont pas pu être chargées. Réessayez dans un instant.",
        502,
      );
    }
  });
}
