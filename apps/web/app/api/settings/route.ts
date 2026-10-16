import { settingsHandlers } from "@/lib/settings/default";

export async function GET(request: Request): Promise<Response> {
  return settingsHandlers().list(request);
}

export async function POST(request: Request): Promise<Response> {
  return settingsHandlers().save(request);
}
