import { authHandlers } from "@/lib/auth/default";

export async function GET(request: Request): Promise<Response> {
  return authHandlers().me(request);
}
