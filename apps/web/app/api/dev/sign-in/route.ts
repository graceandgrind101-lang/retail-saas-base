import { devSignIn } from "@/lib/auth/dev-default";

export async function POST(request: Request): Promise<Response> {
  return devSignIn()(request);
}
