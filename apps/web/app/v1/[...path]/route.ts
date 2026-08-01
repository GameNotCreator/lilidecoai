import { dispatchApi } from "@/lib/server/api";
import { after } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ path: string[] }> };

async function handler(request: Request, context: Context): Promise<Response> {
  const { path } = await context.params;
  return dispatchApi(request, path, (task) => after(task));
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
