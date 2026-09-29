import { z } from "zod";

export const spatialRetryBodySchema = z
  .object({
    idempotencyKey: z.string().min(1).max(160),
  })
  .strict();

export function retryKeyMatchesSource(
  key: string,
  sourceRenderId: string,
): boolean {
  const prefix = `retry:${sourceRenderId}:`;
  return (
    key.length <= 160 &&
    key.startsWith(prefix) &&
    z.string().uuid().safeParse(key.slice(prefix.length)).success
  );
}

export const spatialRetrySubmissionSchema = z
  .object({
    kind: z.literal("retry"),
    sourceRenderId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(160),
    placement: z
      .object({ sceneId: z.string().uuid(), productId: z.string().uuid() })
      .strict(),
  })
  .strict()
  .refine(
    (request) =>
      retryKeyMatchesSource(request.idempotencyKey, request.sourceRenderId),
    "La clé de reprise ne correspond pas au rendu d’origine.",
  );
