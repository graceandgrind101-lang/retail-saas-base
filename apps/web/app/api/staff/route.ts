import { permissionHandlers } from "@/lib/permissions/default";

export async function POST(request: Request): Promise<Response> {
  return permissionHandlers().createStaff(request);
}
