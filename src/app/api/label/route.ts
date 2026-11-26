import { keyFromRequest, verifyApiKey, type ApiKeyContext } from "@/lib/api-keys";
import { catalog } from "@/lib/catalog.generated";
import { shopSdk } from "@/lib/shopee";
import { db } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/label — returns the shipping labels (phiếu gửi hàng) of up to 50 orders as one PDF file.
 *
 * Body: { shop_id?: number, shipping_document_type?: string,
 *         order_list: [{ order_sn: string, package_number?: string, tracking_number?: string }] }
 * Headers: Authorization: Bearer smcp_…  (read + write key: creating a document is a write endpoint)
 *
 * Flow: create_shipping_document → poll get_shipping_document_result until READY → download_shipping_document.
 * The MCP endpoint can't return the PDF because tool results are capped at 100k characters.
 * Orders in one request must use the same courier (Shopee rule) and already have a tracking number.
 * Response: application/pdf. Header X-Label-Failed lists orders that could not be printed (JSON).
 */

type OrderRef = { order_sn: string; package_number?: string; tracking_number?: string };
type ResultItem = { order_sn: string; package_number?: string; status?: string; fail_error?: string; fail_message?: string };

const endpointsById = new Map(catalog.map((e) => [e.id, e]));
const DEFAULT_TYPE = "THERMAL_AIR_WAYBILL";
const POLL_MS = 1500;
const POLL_LIMIT_MS = 30_000;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Calls one catalog endpoint through the SDK with the same access checks and audit log as the MCP tools. */
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

function resultList(res: unknown): ResultItem[] {
  const r = res as { response?: { result_list?: ResultItem[] } };
  return r?.response?.result_list ?? [];
}

function ref(o: OrderRef) {
  return o.package_number ? { order_sn: o.order_sn, package_number: o.package_number } : { order_sn: o.order_sn };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = await verifyApiKey(keyFromRequest(request));
    if (!ctx) throw new HttpError(401, "Missing or invalid API key. Send 'Authorization: Bearer smcp_…'.");

    const body = (await request.json().catch(() => null)) as {
      shop_id?: number;
      shipping_document_type?: string;
      order_list?: OrderRef[];
    } | null;
    const orders = (body?.order_list ?? []).filter((o) => o && typeof o.order_sn === "string" && o.order_sn);
    if (!orders.length || orders.length > 50) throw new HttpError(400, "order_list must have 1–50 orders.");

    const shopId = body?.shop_id ?? (ctx.shopIds.length === 1 ? ctx.shopIds[0] : undefined);
    if (shopId === undefined) throw new HttpError(400, `shop_id is required; this key has shops ${ctx.shopIds.join(", ")}.`);
    if (!ctx.shopIds.includes(Number(shopId))) throw new HttpError(403, `Shop ${shopId} is not authorized for this key.`);
    const docType = body?.shipping_document_type || DEFAULT_TYPE;
    const failed: { order_sn: string; reason: string }[] = [];

    // 1. Tracking numbers (required by create_shipping_document).
    for (const o of orders) {
      if (o.tracking_number) continue;
      try {
        const t = (await callSdk(ctx, "logistics.get_tracking_number", shopId, ref(o))) as {
          response?: { tracking_number?: string };
        };
        o.tracking_number = t?.response?.tracking_number || undefined;
      } catch {
        /* handled below */
      }
    }
    // Orders without a tracking number are still sent: channels that allow "print before arrange shipment"
    // (preprint, e.g. instant/hỏa tốc) can print them; other channels fail and are reported in X-Label-Failed.
    const noTracking = new Set(orders.filter((o) => !o.tracking_number).map((o) => o.order_sn));
    const ready = orders;

    // 2. Create the document task. "Already created" style failures are fine: the result step decides.
    const created = await callSdk(ctx, "logistics.create_shipping_document", shopId, {
      order_list: ready.map((o) => ({
        ...ref(o),
        ...(o.tracking_number ? { tracking_number: o.tracking_number } : {}),
        shipping_document_type: docType,
      })),
    });
    const createFail = new Map(
      resultList(created)
        .filter((r) => r.fail_error)
        .map((r) => [
          r.order_sn,
          `${noTracking.has(r.order_sn) ? "Chưa có mã vận đơn (chưa chuẩn bị hàng). " : ""}${r.fail_error} ${r.fail_message ?? ""}`.trim(),
        ])
    );

    // 3. Wait until every document is READY (or FAILED).
    let pending = ready;
    const done: OrderRef[] = [];
    const deadline = Date.now() + POLL_LIMIT_MS;
    while (pending.length && Date.now() < deadline) {
      const res = await callSdk(ctx, "logistics.get_shipping_document_result", shopId, {
        order_list: pending.map((o) => ({ ...ref(o), shipping_document_type: docType })),
      });
      const byOrder = new Map(resultList(res).map((r) => [r.order_sn, r]));
      const still: OrderRef[] = [];
      for (const o of pending) {
        const r = byOrder.get(o.order_sn);
        if (r?.status === "READY") done.push(o);
        else if (r?.status === "FAILED" || (r?.fail_error && r?.status !== "PROCESSING")) {
          failed.push({ order_sn: o.order_sn, reason: createFail.get(o.order_sn) || `${r?.fail_error ?? ""} ${r?.fail_message ?? ""}`.trim() || "FAILED" });
        } else still.push(o);
      }
      pending = still;
      if (pending.length) await sleep(POLL_MS);
    }
    for (const o of pending) failed.push({ order_sn: o.order_sn, reason: "Quá thời gian chờ Shopee tạo phiếu" });
    if (!done.length) throw new HttpError(422, JSON.stringify({ failed }));

    // 4. Download one PDF for all ready orders.
    const file = await callSdk(ctx, "logistics.download_shipping_document", shopId, {
      shipping_document_type: docType,
      order_list: done.map(ref),
    });
    if (!Buffer.isBuffer(file)) throw new HttpError(502, `Shopee did not return a file: ${JSON.stringify(file).slice(0, 300)}`);

    return new Response(new Uint8Array(file), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="phieu-gui-hang-${shopId}-${Date.now()}.pdf"`,
        "X-Label-Count": String(done.length),
        "X-Label-Failed": encodeURIComponent(JSON.stringify(failed)),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const data = (err as { data?: unknown })?.data;
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: data ? JSON.stringify(data) : message }, { status });
  }
}

export function GET(): Response {
  return Response.json({ error: "Use POST with a JSON body." }, { status: 405, headers: { Allow: "POST" } });
}
