import { authHandlers } from "@/lib/auth/default";

export async function POST(request: Request): Promise<Response> {
  return authHandlers().shops(request);
}
