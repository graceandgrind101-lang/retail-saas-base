import { alertHandlers } from "@/lib/alerts/default";

export async function POST(request: Request): Promise<Response> {
  return alertHandlers().setStatus(request);
}
