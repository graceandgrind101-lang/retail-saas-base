import { alertHandlers } from "@/lib/alerts/default";

export async function GET(request: Request): Promise<Response> {
  return alertHandlers().list(request);
}
