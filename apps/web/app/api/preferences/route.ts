import { preferenceHandlers } from "@/lib/preferences/default";

export async function POST(request: Request): Promise<Response> {
  return preferenceHandlers().set(request);
}
