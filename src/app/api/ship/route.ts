import { keyFromRequest, verifyApiKey, type ApiKeyContext } from "@/lib/api-keys";
import { catalog } from "@/lib/catalog.generated";
import { shopSdk } from "@/lib/shopee";
import { db } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/ship — "Chuẩn bị hàng" (arrange shipment, pickup) for up to 50 orders of one shop.
 *
 * Body: { shop_id?: number, dry_run?: boolean, order_list: [{ order_sn: string, package_number?: string }] }
 * Headers: Authorization: Bearer smcp_…  (read + write key)
 *
 * For each order: get_shipping_parameter → pick the pickup address (flag pickup_address > default_address > first)
 * and time slot (flag recommended > first) → ship_order with { pickup: { address_id, pickup_time_id } }.
 * Done server-side because get_shipping_parameter can list hundreds of drop-off branches, which the MCP
 * endpoint truncates at 100k characters. Orders without a pickup option are skipped and reported.
 * dry_run: only returns the chosen pickup, does not ship.
 * Response: { results: [{ order_sn, ok, pickup?, error? }] }
 */

type OrderRef = { order_sn: string; package_number?: string };
type Slot = { pickup_time_id?: string | number; flags?: string[] };
type Address = { address_id: number; address?: string; address_flag?: string[]; time_slot_list?: Slot[] };

const endpointsById = new Map(catalog.map((e) => [e.id, e]));
const CONCURRENCY = 5;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function callSdk(ctx: ApiKeyContext, endpointId: string, shopId: number, params: Record<string, unknown>) {
  const entry = endpointsById.get(endpointId);
  if (!entry) throw new HttpError(500, `Unknown endpoint ${endpointId}`);
  if (entry.access === "write" && ctx.access !== "read_write") {
    throw new HttpError(403, `${endpointId} needs a read + write key.`);
  }
  const sdk = shopSdk(ctx.region, shopId);
  const manager = (sdk as unknown as Record<string, Record<string, unknown>>)[entry.sdkProperty];
  const method = manager?.[entry.sdkMethod];
  if (typeof method !== "function") throw new HttpError(500, `SDK has no method for ${endpointId}`);

  const started = Date.now();
  let ok = false;
  let errorMessage: string | null = null;
  try {
    const result = await (method as (p: unknown) => Promise<unknown>).call(manager, params);
    ok = true;
    return result;
  } catch (err) {
    const data = (err as { data?: unknown })?.data;
    errorMessage = data ? JSON.stringify(data) : String(err);
    throw err;
  } finally {
    await db()
      .from("audit_log")
      .insert({
        api_key_id: ctx.id,
        shop_id: shopId,
        endpoint: endpointId,
        access: entry.access,
        ok,
        error: errorMessage?.slice(0, 1000) ?? null,
        duration_ms: Date.now() - started,
      })
      .then(undefined, () => undefined);
  }
}

function errText(err: unknown): string {
  const data = (err as { data?: unknown })?.data;
  if (data) return JSON.stringify(data).slice(0, 300);
  return err instanceof Error ? err.message : String(err);
}

function ref(o: OrderRef) {
  return o.package_number ? { order_sn: o.order_sn, package_number: o.package_number } : { order_sn: o.order_sn };
}

async function shipOne(ctx: ApiKeyContext, shopId: number, o: OrderRef, dryRun: boolean) {
  try {
    const p = (await callSdk(ctx, "logistics.get_shipping_parameter", shopId, ref(o))) as {
      response?: { info_needed?: { pickup?: string[] }; pickup?: { address_list?: Address[] } };
    };
    const list = p?.response?.pickup?.address_list ?? [];
    if (!p?.response?.info_needed?.pickup || !list.length) {
      return { order_sn: o.order_sn, ok: false, error: "Kênh không có lấy hàng tận nơi — chuẩn bị hàng trên Kênh Người bán" };
    }
    const addr =
      list.find((a) => a.address_flag?.includes("pickup_address")) ??
      list.find((a) => a.address_flag?.includes("default_address")) ??
      list[0];
    const slots = addr.time_slot_list ?? [];
    const slot = slots.find((s) => s.flags?.includes("recommended")) ?? slots[0];
    if (!slot?.pickup_time_id) return { order_sn: o.order_sn, ok: false, error: "Không có khung giờ lấy hàng" };
    const pickup = { address_id: addr.address_id, pickup_time_id: String(slot.pickup_time_id) };
    if (dryRun) return { order_sn: o.order_sn, ok: true, dry_run: true, pickup, address: addr.address };

    await callSdk(ctx, "logistics.ship_order", shopId, { ...ref(o), pickup });
    return { order_sn: o.order_sn, ok: true, pickup };
  } catch (err) {
    return { order_sn: o.order_sn, ok: false, error: errText(err) };
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = await verifyApiKey(keyFromRequest(request));
    if (!ctx) throw new HttpError(401, "Missing or invalid API key. Send 'Authorization: Bearer smcp_…'.");
    if (ctx.access !== "read_write") throw new HttpError(403, "Chuẩn bị hàng cần key đọc + ghi.");

    const body = (await request.json().catch(() => null)) as {
      shop_id?: number;
      dry_run?: boolean;
      order_list?: OrderRef[];
    } | null;
    const orders = (body?.order_list ?? []).filter((o) => o && typeof o.order_sn === "string" && o.order_sn);
    if (!orders.length || orders.length > 50) throw new HttpError(400, "order_list must have 1–50 orders.");

    const shopId = body?.shop_id ?? (ctx.shopIds.length === 1 ? ctx.shopIds[0] : undefined);
    if (shopId === undefined) throw new HttpError(400, `shop_id is required; this key has shops ${ctx.shopIds.join(", ")}.`);
    if (!ctx.shopIds.includes(Number(shopId))) throw new HttpError(403, `Shop ${shopId} is not authorized for this key.`);
    const dryRun = body?.dry_run === true;

    const results: Awaited<ReturnType<typeof shipOne>>[] = new Array(orders.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, orders.length) }, async () => {
        while (next < orders.length) {
          const i = next++;
          results[i] = await shipOne(ctx, Number(shopId), orders[i], dryRun);
        }
      })
    );
    return Response.json({ dry_run: dryRun, results }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    return Response.json({ error: errText(err) }, { status });
  }
}

export function GET(): Response {
  return Response.json({ error: "Use POST with a JSON body." }, { status: 405, headers: { Allow: "POST" } });
}
