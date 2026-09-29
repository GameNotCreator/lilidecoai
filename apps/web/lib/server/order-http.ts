import "server-only";
import { z } from "zod";
import { OrderRequestError } from "./order-requests";
import { RateLimitError } from "./rate-limit";

export async function readOrderBody(request: Request) {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    throw new OrderRequestError(
      "La demande doit être envoyée au format JSON.",
      415,
    );
  const maximum = 16_384;
  const declared = Number(request.headers.get("content-length"));
  if (declared > maximum)
    throw new OrderRequestError("Cette demande est trop volumineuse.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new OrderRequestError("La demande est vide.", 422);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new OrderRequestError("Cette demande est trop volumineuse.", 413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new OrderRequestError("La demande est invalide.", 422);
  }
}

export function orderResponse(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export function orderErrorResponse(error: unknown) {
  if (error instanceof z.ZodError) {
    const fields = Object.fromEntries(
      error.issues.map((issue) => [
        String(issue.path[0] ?? "form"),
        issue.message,
      ]),
    );
    return orderResponse(
      { detail: "Vérifiez les informations de votre demande.", fields },
      422,
    );
  }
  if (error instanceof OrderRequestError || error instanceof RateLimitError)
    return orderResponse({ detail: error.message }, error.status);
  return orderResponse(
    {
      detail:
        "La demande n’a pas pu être enregistrée. Réessayez dans un instant avec la même page.",
    },
    503,
  );
}
