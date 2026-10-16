import { deviceHandlers } from "@/lib/devices/default";

export async function POST(request: Request): Promise<Response> {
  return deviceHandlers().revokeDevice(request);
}
