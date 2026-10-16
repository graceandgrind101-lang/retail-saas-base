import { deviceHandlers } from "@/lib/devices/default";

export async function GET(request: Request): Promise<Response> {
  return deviceHandlers().deviceStatus(request);
}
