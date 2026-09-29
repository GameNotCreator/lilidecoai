import { after } from "next/server";
import { scheduleVercelRenderWorker } from "@/lib/server/vercel-render-worker";

export { runVercelRenderWorker as GET } from "@/lib/server/vercel-render-worker";
export function POST(request: Request): Response {
  return scheduleVercelRenderWorker(request, (task) => after(task));
}
export const runtime = "nodejs";
export const maxDuration = 800;
export const dynamic = "force-dynamic";
