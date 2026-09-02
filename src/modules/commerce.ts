import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";

import { config } from "../config.js";
import { asObject, bearerToken, HttpError, randomToken, secureEqual, sha256, verifyAccessToken, withProviderMetrics } from "../platform.js";
import { quoteNational } from "../providers/skydropx.js";
import type { AppContext } from "../types.js";

function cartItem(row: any): any {
  return { ...row, line_total_mxn: Number(row.unit_price_mxn) * Number(row.quantity) };
}

function cartAccessToken(request: FastifyRequest): string | null {
  const value = request.headers["x-cart-access-token"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function authorizeCartAccess(context: AppContext, request: FastifyRequest, cart: any): Promise<void> {
  if (request.headers["x-internal-api-key"] === config.AUTH_INTERNAL_API_KEY) return;

  const accessToken = cartAccessToken(request);
  if (
    accessToken &&
    typeof cart.cart_access_token_hash === "string" &&
    secureEqual(sha256(accessToken), cart.cart_access_token_hash)
  ) {
    return;
  }

  const token = bearerToken(request);
  if (token && cart.account_id) {
    try {
      const actor = await verifyAccessToken(token);
      if (actor.accountId === cart.account_id) return;
    } catch {
      // A stale bearer token must not change the cart authorization result.
    }
  }

  throw new HttpError(403, "No tienes acceso a este carrito");
}

async function cartForAccess(context: AppContext, request: FastifyRequest, id: string, client: any = context.database): Promise<any> {
  const cart = (await client.query("select * from carts where id=$1", [id])).rows[0];
  if (!cart) throw new HttpError(404, "Carrito no encontrado");
  await authorizeCartAccess(context, request, cart);
  return cart;
}

function cartSummary(cart: any, items: any[]): any {
  const responseCart = { ...cart };
  delete responseCart.cart_access_token_hash;
  return { ...responseCart, total_items: items.reduce((sum, item) => sum + Number(item.quantity), 0), subtotal_mxn: items.reduce((sum, item) => sum + item.line_total_mxn, 0), items };
}

async function cartResponse(context: AppContext, request: FastifyRequest, id: string, client: any = context.database): Promise<any> {
  const cart = await cartForAccess(context, request, id, client);
  const items: any[] = (await client.query("select * from cart_items where cart_id=$1 order by created_at", [id])).rows.map(cartItem);
  return cartSummary(cart, items);
}

async function checkoutResponse(context: AppContext, request: FastifyRequest, id: string, client: any = context.database): Promise<any> {
  const checkout = (await client.query("select * from checkout_sessions where id=$1", [id])).rows[0];
  if (!checkout) throw new HttpError(404, "Checkout no encontrado");
  const cart = await cartResponse(context, request, checkout.cart_id, client);
  return { ...checkout, shipping_quotes: checkout.shipping_quotes ?? [], items: cart.items };
}

async function checkoutForPaymentAttempt(context: AppContext, request: FastifyRequest, attempt: any, client: any = context.database): Promise<any> {
  const checkout = (await client.query("select * from checkout_sessions where id=$1", [attempt.checkout_session_id])).rows[0];
  if (!checkout) throw new HttpError(404, "Checkout no encontrado");
  await cartForAccess(context, request, checkout.cart_id, client);
  return checkout;
}

function attemptResponse(row: any): any {
  const response = { ...row };
  delete response.metadata;
  delete response.client_secret;
  return { ...response, checkout_url: row.metadata?.checkout_url ?? null };
}

type CreatedOrder = {
  orderId: string;
  orderAccessToken: string | null;
};

function requiredText(value: unknown, field: string, maxLength = 120): string {
  if (typeof value !== "string") throw new HttpError(422, `${field} es requerido`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new HttpError(422, `${field} es inválido`);
  return normalized;
}

function optionalText(value: unknown, field: string, maxLength = 120): string {
  if (value === undefined || value === null || value === "") return "";
  return requiredText(value, field, maxLength);
}

function boundedPositiveInteger(value: unknown, field: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new HttpError(422, `${field} debe ser un entero entre 1 y ${max}`);
  }
  return parsed;
}

async function customizerUnitPrice(context: AppContext, imageCount: number, improveQuality: boolean): Promise<number> {
  const row = (await context.database.query<any>(`
    select base_price_mxn, per_image_price_mxn, included_images, max_images, quality_upgrade_price_mxn
    from customizer_pricing_configs where is_active=true order by created_at desc limit 1
  `)).rows[0];
  const basePrice = Number(row?.base_price_mxn ?? config.PRICING_DEFAULT_CUSTOMIZER_BASE_PRICE_MXN);
  const perImagePrice = Number(row?.per_image_price_mxn ?? config.PRICING_DEFAULT_CUSTOMIZER_PER_IMAGE_PRICE_MXN);
  const includedImages = Math.max(0, Number(row?.included_images ?? 0));
  const maxImages = Math.max(1, Number(row?.max_images ?? 10));
  const qualityUpgradePrice = Math.max(0, Number(row?.quality_upgrade_price_mxn ?? 0));
  if (!Number.isInteger(basePrice) || basePrice < 0 || !Number.isInteger(perImagePrice) || perImagePrice < 0) {
    throw new HttpError(503, "La configuración de precios no está disponible");
  }
  if (imageCount > maxImages) throw new HttpError(422, `Máximo ${maxImages} imágenes por personalización`);
  return basePrice + Math.max(0, imageCount - includedImages) * perImagePrice + (improveQuality ? qualityUpgradePrice : 0);
}

function inventoryKey(item: any): any[] {
  return [item.garment_type, item.garment_model ?? "", item.color, item.size, Number(item.grammage_g), item.fit ?? ""];
}

async function reserveStock(client: pg.PoolClient, items: any[], attemptId: string): Promise<any[]> {
  const reservations: any[] = [];
  for (const item of items) {
    const stock = await client.query<any>(`
      select * from inventory_items where garment_type=$1 and garment_model=$2 and color=$3 and size=$4 and grammage_g=$5 and fit=$6 for update
    `, inventoryKey(item));
    const inventory = stock.rows[0];
    if (!inventory || Number(inventory.quantity) < Number(item.quantity)) {
      throw new HttpError(409, `Stock insuficiente para ${item.color} ${item.size}`);
    }
    await client.query("update inventory_items set quantity=quantity-$2,updated_at=now() where id=$1", [inventory.id, item.quantity]);
    await client.query(`insert into inventory_movements(id,inventory_item_id,movement_type,quantity,reason,source_ref)
      values($1,$2,'payment_reserved',$3,'Reserva de pago',$4)`, [randomUUID(), inventory.id, -Number(item.quantity), attemptId]);
    reservations.push({ inventory_item_id: inventory.id, quantity: Number(item.quantity), cart_item_id: item.id });
  }
  return reservations;
}

async function releaseReservations(client: pg.PoolClient, attempt: any, reason: string): Promise<void> {
  if (attempt.metadata?.reservations_released) return;
  for (const reservation of attempt.metadata?.reservations ?? []) {
    await client.query("update inventory_items set quantity=quantity+$2,updated_at=now() where id=$1", [reservation.inventory_item_id, reservation.quantity]);
    await client.query(`insert into inventory_movements(id,inventory_item_id,movement_type,quantity,reason,source_ref)
      values($1,$2,'payment_released',$3,$4,$5)`, [randomUUID(), reservation.inventory_item_id, reservation.quantity, reason, attempt.id]);
  }
  const metadata = { ...(attempt.metadata ?? {}), reservations_released: true, release_reason: reason };
  await client.query("update payment_attempts set metadata=$2,updated_at=now() where id=$1", [attempt.id, metadata]);
}

async function replaceOrderAccessToken(client: pg.PoolClient, orderId: string): Promise<string> {
  const orderAccessToken = randomToken(32);
  await client.query(
    "update orders set customer_access_token_hash=$2,updated_at=now() where id=$1",
    [orderId, sha256(orderAccessToken)]
  );
  return orderAccessToken;
}

async function createOrder(client: pg.PoolClient, checkout: any, attempt: any): Promise<CreatedOrder> {
  const existing = await client.query<{ id: string }>("select id from orders where checkout_session_id=$1", [checkout.id]);
  if (existing.rows[0]) {
    return {
      orderId: existing.rows[0].id,
      orderAccessToken: await replaceOrderAccessToken(client, existing.rows[0].id)
    };
  }
  const items = (await client.query("select * from cart_items where cart_id=$1 order by created_at", [checkout.cart_id])).rows;
  const primaryDrop = items.find((item) => item.drop_id)?.drop_id ?? null;
  let dropNumber: number | null = null;
  if (primaryDrop) {
    const counter = await client.query<{ last_number: number }>(`
      insert into drop_counters(drop_id,last_number) values($1,1)
      on conflict(drop_id) do update set last_number=drop_counters.last_number+1,updated_at=now() returning last_number
    `, [primaryDrop]);
    dropNumber = counter.rows[0]?.last_number ?? null;
  }
  const orderId = randomUUID();
  const orderAccessToken = randomToken(32);
  await client.query(`insert into orders(
    id,checkout_session_id,payment_attempt_id,payment_reference,customer_email,customer_phone,shipping_method,
    shipping_cost_mxn,subtotal_mxn,total_mxn,currency,address,status,drop_id,drop_number,drop_total_limit,customer_access_token_hash)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'paid',$13,$14,$15,$16)`,
  [orderId, checkout.id, attempt.id, attempt.provider_charge_id ?? attempt.provider_payment_intent_id ?? attempt.id,
    checkout.email, checkout.phone, checkout.shipping_method, checkout.shipping_cost_mxn, checkout.subtotal_mxn,
    checkout.total_mxn, checkout.currency, checkout.address, primaryDrop, dropNumber,
    items.find((item) => item.drop_total_limit)?.drop_total_limit ?? null, sha256(orderAccessToken)]);
  for (const item of items) {
    const orderItemId = randomUUID();
    await client.query(`insert into order_items(id,order_id,cart_item_id,item_type,publication_id,publication_slug,design_variant_id,
      garment_type,garment_model,color,size,grammage_g,fit,quantity,unit_price_mxn,drop_id,drop_total_limit,snapshot)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [orderItemId, orderId, item.id, item.item_type, item.publication_id, item.publication_slug, item.design_variant_id,
      item.garment_type, item.garment_model, item.color, item.size, item.grammage_g, item.fit, item.quantity,
      item.unit_price_mxn, item.drop_id, item.drop_total_limit, { ...item, line_total_mxn: item.quantity * item.unit_price_mxn }]);
    await client.query("insert into work_orders(id,order_id,order_item_id,status) values($1,$2,$3,'pending')", [randomUUID(), orderId, orderItemId]);
    await client.query(`insert into sales_pings(id,event_ref,order_id,payment_attempt_id,publication_id,publication_slug,drop_id,item_type,
      garment_type,garment_model,color,size,grammage_g,fit,quantity,amount_mxn,shipping_method,shipping_provider,state_code,payload)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) on conflict(event_ref) do nothing`,
    [randomUUID(), `sale:${orderId}:${item.id}`, orderId, attempt.id, item.publication_id, item.publication_slug, item.drop_id,
      item.item_type, item.garment_type, item.garment_model, item.color, item.size, item.grammage_g, item.fit,
      item.quantity, item.unit_price_mxn * item.quantity, checkout.shipping_method, checkout.shipping_provider,
      checkout.address?.state ?? null, { order_id: orderId }]);
  }
  await client.query("insert into order_state_history(id,order_id,new_status,source) values($1,$2,'paid','payment')", [randomUUID(), orderId]);
  await client.query("update checkout_sessions set status='paid',paid_at=now(),order_id=$2,updated_at=now() where id=$1", [checkout.id, orderId]);
  await client.query("update carts set status='checked_out',updated_at=now() where id=$1", [checkout.cart_id]);
  await client.query(`insert into notification_deliveries(template_key,channel,recipient,payload,status)
    values('order_confirmation','email',$1,$2,$3)`, [checkout.email, { order_id: orderId, total_mxn: checkout.total_mxn }, config.NOTIFICATION_DEV_MODE ? "delivered" : "pending"]);
  await client.query(`insert into analytics_events(id,event_ref,event_type,order_id,payment_attempt_id,status,amount_mxn,occurred_at,payload)
    values($1,$2,'sale_confirmed',$3,$4,'paid',$5,now(),$6) on conflict(event_ref) do nothing`,
  [randomUUID(), `order:${orderId}:confirmed`, orderId, attempt.id, checkout.total_mxn, { shipping_method: checkout.shipping_method }]);
  return { orderId, orderAccessToken };
}

export async function authorizeOrderAccess(context: AppContext, request: FastifyRequest, order: any): Promise<void> {
  if (request.headers["x-internal-api-key"] === config.AUTH_INTERNAL_API_KEY) return;

  const orderAccessToken = request.headers["x-order-access-token"];
  if (
    typeof orderAccessToken === "string" &&
    typeof order.customer_access_token_hash === "string" &&
    secureEqual(sha256(orderAccessToken), order.customer_access_token_hash)
  ) {
    return;
  }

  const token = bearerToken(request);
  if (token) {
    try {
      const actor = await verifyAccessToken(token);
      const account = await context.database.query<{ primary_email: string | null }>(
        "select primary_email from accounts where id=$1",
        [actor.accountId]
      );
      if (
        account.rows[0]?.primary_email &&
        account.rows[0].primary_email.toLowerCase() === String(order.customer_email ?? "").toLowerCase()
      ) {
        return;
      }
    } catch {
      // A missing or stale bearer token must not change the resource authorization result.
    }
  }

  throw new HttpError(403, "No tienes acceso a este pedido");
}

async function orderResponse(context: AppContext, request: FastifyRequest, where: string, value: string): Promise<any> {
  const order = (await context.database.query(`select * from orders where ${where}=$1`, [value])).rows[0];
  if (!order) throw new HttpError(404, "Pedido no encontrado");
  await authorizeOrderAccess(context, request, order);
  const items = (await context.database.query("select * from order_items where order_id=$1 order by created_at", [order.id])).rows;
  const responseOrder = { ...order };
  delete responseOrder.customer_access_token_hash;
  return { ...responseOrder, email: order.customer_email, phone: order.customer_phone, drop_label: order.drop_number ? `#${order.drop_number}` : null, items };
}

async function stripeCheckout(context: AppContext, checkout: any, attemptId: string, returnOrigin?: string): Promise<any> {
  let origin = config.corsOrigins[0] ?? "http://localhost:4200";
  if (typeof returnOrigin === "string") {
    try {
      const candidate = new URL(returnOrigin).origin;
      if (config.corsOrigins.includes(candidate)) origin = candidate;
    } catch {
      // Use the configured frontend origin when a caller supplies an invalid return target.
    }
  }
  const checkoutPath = `/checkout?payment=success&payment_attempt=${encodeURIComponent(attemptId)}&checkout_id=${encodeURIComponent(checkout.id)}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelPath = `/checkout?checkout=cancel&payment_attempt=${encodeURIComponent(attemptId)}&checkout_id=${encodeURIComponent(checkout.id)}`;
  return withProviderMetrics("stripe", () => context.stripe.checkout.sessions.create({
    mode: "payment",
    success_url: `${origin}${checkoutPath}`,
    cancel_url: `${origin}${cancelPath}`,
    customer_email: checkout.email,
    line_items: [{ quantity: 1, price_data: { currency: "mxn", unit_amount: Number(checkout.total_mxn) * 100, product_data: { name: `Pedido SAUT ${checkout.id}` } } }],
    metadata: { checkout_session_id: checkout.id }
  }));
}

export async function expirePaymentReservations(context: AppContext): Promise<void> {
  const expired = await context.database.query<any>("select * from payment_attempts where status='pending' and created_at < now()-interval '30 minutes' limit 100");
  for (const attempt of expired.rows) {
    const client = await context.database.connect();
    try { await client.query("begin"); await releaseReservations(client, attempt, "expired"); await client.query("update payment_attempts set status='expired',updated_at=now() where id=$1", [attempt.id]); await client.query("commit"); }
    catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
}

export async function registerCommerce(app: FastifyInstance, context: AppContext): Promise<void> {
  app.post("/cart/sessions", async (request, reply) => {
    const body = asObject(request.body);
    const bearer = bearerToken(request);
    const accountId = bearer ? (await verifyAccessToken(bearer)).accountId : null;
    const guestSessionId = typeof body.guest_session_id === "string"
      ? body.guest_session_id.trim().slice(0, 128) || null
      : null;
    const id = randomUUID();
    const accessToken = randomToken(32);
    const cart = (await context.database.query(`
      insert into carts(id,status,guest_session_id,account_id,cart_access_token_hash)
      values($1,'active',$2,$3,$4) returning *
    `, [id, guestSessionId, accountId, sha256(accessToken)])).rows[0];
    reply.status(201);
    return { ...cartSummary(cart, []), cart_access_token: accessToken };
  });
  app.get<{Params:{cart_id:string}}>("/cart/sessions/:cart_id",async(request)=>cartResponse(context,request,request.params.cart_id));
  app.post<{Params:{cart_id:string}}>("/cart/sessions/:cart_id/items/predesigned",async(request,reply)=>{
    await cartForAccess(context,request,request.params.cart_id);
    const body=asObject(request.body);
    const publication=(await context.database.query<any>(`
      select * from publications
      where (slug=$1 or id::text=$2) and is_active=true and visibility in ('public','visible') limit 1
    `,[body.publication_slug,body.publication_id??null])).rows[0];
    if(!publication)throw new HttpError(404,"Publicación no encontrada");
    const designVariantId=body.design_variant_id===undefined||body.design_variant_id===null||body.design_variant_id===""?null:requiredText(body.design_variant_id,"design_variant_id",64);
    if(designVariantId){
      const variant=(await context.database.query("select id from design_variants where id::text=$1 and design_id=$2 and is_active=true",[designVariantId,publication.design_id])).rows[0];
      if(!variant)throw new HttpError(422,"La variante no pertenece a la publicación");
    }
    const quantity=boundedPositiveInteger(body.quantity,"quantity",25);
    const color=requiredText(body.color,"color",64);
    const size=requiredText(body.size,"size",32);
    const grammage=boundedPositiveInteger(body.grammage_g,"grammage_g",1_000);
    const fit=optionalText(body.fit,"fit",64);
    const drop=(await context.database.query("select d.* from drops d join drop_items di on di.drop_id=d.id where di.publication_id=$1 and d.status='active' order by d.starts_at desc nulls last limit 1",[publication.id])).rows[0];
    await context.database.query(`insert into cart_items(id,cart_id,item_type,publication_id,publication_slug,design_variant_id,garment_type,garment_model,color,size,grammage_g,fit,quantity,unit_price_mxn,drop_id,drop_total_limit,meta)
      values($1,$2,'predesigned',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[randomUUID(),request.params.cart_id,publication.id,publication.slug,designVariantId,publication.garment_type,publication.garment_model??"",color,size,grammage,fit,quantity,Number(publication.price_mxn),drop?.id??null,drop?.capacity_total??null,body.meta??null]);
    reply.status(201);return cartResponse(context,request,request.params.cart_id);
  });
  app.post<{Params:{cart_id:string}}>("/cart/sessions/:cart_id/items/customized",async(request,reply)=>{
    await cartForAccess(context,request,request.params.cart_id);
    const body=asObject(request.body);const front=Array.isArray(body.front_assets)?body.front_assets:[];const back=Array.isArray(body.back_assets)?body.back_assets:[];
    const improveQuality=Boolean(body.improve_quality);
    const unitPrice=await customizerUnitPrice(context,front.length+back.length,improveQuality);
    const quantity=boundedPositiveInteger(body.quantity,"quantity",25);
    await context.database.query(`insert into cart_items(id,cart_id,item_type,garment_type,garment_model,color,size,grammage_g,fit,quantity,unit_price_mxn,custom_front,custom_back,custom_note,improve_quality,meta)
      values($1,$2,'customized',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[randomUUID(),request.params.cart_id,requiredText(body.garment_type,"garment_type",64),optionalText(body.garment_model,"garment_model",64),requiredText(body.color,"color",64),requiredText(body.size,"size",32),boundedPositiveInteger(body.grammage_g,"grammage_g",1_000),optionalText(body.fit,"fit",64),quantity,unitPrice,JSON.stringify(front),JSON.stringify(back),body.note??null,improveQuality,body.meta??null]);
    reply.status(201);return cartResponse(context,request,request.params.cart_id);
  });
  app.delete<{Params:{cart_id:string;item_id:string}}>("/cart/sessions/:cart_id/items/:item_id",async(request)=>{await cartForAccess(context,request,request.params.cart_id);await context.database.query("delete from cart_items where id=$1 and cart_id=$2",[request.params.item_id,request.params.cart_id]);return cartResponse(context,request,request.params.cart_id);});

  app.post("/checkout/sessions", async (request, reply) => {
    const body = asObject(request.body);
    const cart = await cartResponse(context, request, String(body.cart_id));
    if (cart.items.length === 0) throw new HttpError(400, "El carrito está vacío");
    const local = String(body.address?.city ?? "").toLowerCase().includes("torre");
    const quotes = local
      ? [{ quote_id: "local-standard", provider: "saut-local", service: "local", price_mxn: config.LOCAL_SHIPPING_COST_MXN, eta_days: 1 }]
      : await quoteNational(asObject(body.address), String(body.cart_id));
    const selected = quotes.find((quote) => quote.quote_id === body.selected_quote_id) ?? quotes[0]!;
    const id = randomUUID();
    await context.database.query(`
      insert into checkout_sessions(id,cart_id,status,email,phone,address,shipping_method,shipping_quote_id,shipping_provider,shipping_service,shipping_cost_mxn,shipping_quotes,subtotal_mxn,total_mxn,currency)
      values($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'MXN')
    `, [id, cart.id, body.email, body.phone, body.address, local ? "local" : "national", selected.quote_id, selected.provider, selected.service, selected.price_mxn, JSON.stringify(quotes), cart.subtotal_mxn, cart.subtotal_mxn + selected.price_mxn]);
    reply.status(201);
    return checkoutResponse(context, request, id);
  });
  app.get<{Params:{checkout_id:string}}>("/checkout/sessions/:checkout_id", async (request) => checkoutResponse(context, request, request.params.checkout_id));
  app.post<{Params:{checkout_id:string}}>("/checkout/sessions/:checkout_id/shipping/select", async (request) => {
    const checkout = await checkoutResponse(context, request, request.params.checkout_id);
    const quote = (checkout.shipping_quotes ?? []).find((item: any) => item.quote_id === asObject(request.body).quote_id);
    if (!quote) throw new HttpError(400, "Cotización no encontrada");
    await context.database.query(
      "update checkout_sessions set shipping_quote_id=$2,shipping_provider=$3,shipping_service=$4,shipping_cost_mxn=$5,total_mxn=subtotal_mxn+$5,updated_at=now() where id=$1",
      [request.params.checkout_id, quote.quote_id, quote.provider, quote.service, quote.price_mxn]
    );
    return checkoutResponse(context, request, request.params.checkout_id);
  });
  app.get<{Params:{checkout_id:string}}>("/internal/checkout/sessions/:checkout_id/payable", async (request) => checkoutResponse(context, request, request.params.checkout_id));
  app.post<{Params:{checkout_id:string}}>("/internal/checkout/sessions/:checkout_id/mark-paid", async (request) => {
    const body = asObject(request.body);
    await context.database.query("update checkout_sessions set status='paid',paid_at=now(),payment_attempt_id=$2,order_id=$3,updated_at=now() where id=$1", [request.params.checkout_id, body.payment_attempt_id, body.order_id ?? null]);
    return checkoutResponse(context, request, request.params.checkout_id);
  });

  app.post("/payments/attempts", async (request, reply) => {
    const body = asObject(request.body);
    const client = await context.database.connect();
    try {
      await client.query("begin");
      const checkout = (await client.query("select * from checkout_sessions where id=$1 for update", [body.checkout_session_id])).rows[0];
      if (!checkout) throw new HttpError(404, "Checkout no encontrado");
      await cartForAccess(context, request, checkout.cart_id, client);
      if (checkout.status !== "pending") throw new HttpError(409, "Checkout no disponible para pago");
      if (checkout.payment_attempt_id) {
        const existing = (await client.query("select * from payment_attempts where id=$1", [checkout.payment_attempt_id])).rows[0];
        if (existing && (existing.status === "pending" || existing.status === "succeeded")) {
          await client.query("commit");
          reply.status(200);
          return attemptResponse(existing);
        }
      }
      const items = (await client.query("select * from cart_items where cart_id=$1", [checkout.cart_id])).rows;
      const id = randomUUID();
      const reservations = await reserveStock(client, items, id);
      const provider = config.STRIPE_MODE === "live" ? "stripe" : "mock";
      let providerId = `mock_${id}`;
      let clientSecret = `mock_secret_${id}`;
      let checkoutUrl: null | string = null;
      if (config.STRIPE_MODE === "live") {
        const stripeSession = await stripeCheckout(context, checkout, id, body.return_origin);
        providerId = stripeSession.id;
        clientSecret = String(stripeSession.client_secret ?? "");
        checkoutUrl = stripeSession.url;
      }
      const metadata = { reservations, checkout_url: checkoutUrl, reservations_released: false };
      const attempt = (await client.query(`
        insert into payment_attempts(id,checkout_session_id,status,amount_mxn,currency,provider,provider_payment_intent_id,client_secret,metadata)
        values($1,$2,'pending',$3,$4,$5,$6,$7,$8) returning *
      `, [id, checkout.id, checkout.total_mxn, checkout.currency, provider, providerId, clientSecret, metadata])).rows[0];
      await client.query("update checkout_sessions set payment_attempt_id=$2,updated_at=now() where id=$1", [checkout.id, id]);
      await client.query("commit");
      reply.status(201);
      return attemptResponse(attempt);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });
  app.get<{Params:{attempt_id:string}}>("/payments/attempts/:attempt_id", async (request) => {
    const attempt = (await context.database.query("select * from payment_attempts where id=$1", [request.params.attempt_id])).rows[0];
    if (!attempt) throw new HttpError(404, "Intento de pago no encontrado");
    await checkoutForPaymentAttempt(context, request, attempt);
    return attemptResponse(attempt);
  });
  app.post<{Params:{attempt_id:string}}>("/payments/attempts/:attempt_id/cancel", async (request) => {
    const client = await context.database.connect();
    try {
      await client.query("begin");
      const attempt = (await client.query("select * from payment_attempts where id=$1 for update", [request.params.attempt_id])).rows[0];
      if (!attempt) throw new HttpError(404, "Intento de pago no encontrado");
      await checkoutForPaymentAttempt(context, request, attempt, client);
      if (attempt.status === "pending") {
        if (config.STRIPE_MODE === "live" && attempt.provider_payment_intent_id) {
          await withProviderMetrics("stripe", () => context.stripe.checkout.sessions.expire(attempt.provider_payment_intent_id)).catch(() => undefined);
        }
        await releaseReservations(client, attempt, "cancelled");
      }
      const row = (await client.query("update payment_attempts set status='cancelled',updated_at=now() where id=$1 returning *", [attempt.id])).rows[0];
      await client.query("commit");
      return attemptResponse(row);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });
  app.post<{Params:{attempt_id:string}}>("/payments/attempts/:attempt_id/confirm", async (request) => {
    const client = await context.database.connect();
    try {
      await client.query("begin");
      let attempt = (await client.query("select * from payment_attempts where id=$1 for update", [request.params.attempt_id])).rows[0];
      if (!attempt) throw new HttpError(404, "Intento de pago no encontrado");
      const checkout = await checkoutForPaymentAttempt(context, request, attempt, client);
      if (attempt.status === "succeeded") {
        const order = (await client.query("select id from orders where payment_attempt_id=$1", [attempt.id])).rows[0];
        if (!order) throw new HttpError(409, "El pago no tiene un pedido asociado");
        const orderAccessToken = await replaceOrderAccessToken(client, order.id);
        await client.query("commit");
        return { attempt: attemptResponse(attempt), order_id: order.id, order_access_token: orderAccessToken, refunded_oversell: false };
      }
      if (attempt.status !== "pending") throw new HttpError(409, "Intento no confirmable");
      let chargeId = `mock_charge_${attempt.id}`;
      if (config.STRIPE_MODE === "live") {
        const session = await withProviderMetrics("stripe", () => context.stripe.checkout.sessions.retrieve(attempt.provider_payment_intent_id));
        if (session.payment_status !== "paid") throw new HttpError(409, "El pago aún no está confirmado");
        chargeId = typeof session.payment_intent === "string" ? session.payment_intent : String((session.payment_intent as any)?.id ?? session.id);
      }
      if (!Array.isArray(attempt.metadata?.reservations) || attempt.metadata.reservations_released) {
        if (config.STRIPE_MODE === "live" && chargeId) await withProviderMetrics("stripe", () => context.stripe.refunds.create({ payment_intent: chargeId })).catch(() => undefined);
        attempt = (await client.query("update payment_attempts set status='refunded',failure_reason='oversell',updated_at=now() where id=$1 returning *", [attempt.id])).rows[0];
        await client.query("commit");
        return { attempt: attemptResponse(attempt), order_id: null, order_access_token: null, refunded_oversell: true };
      }
      attempt = (await client.query("update payment_attempts set status='succeeded',provider_charge_id=$2,updated_at=now() where id=$1 returning *", [attempt.id, chargeId])).rows[0];
      await client.query(`
        insert into payment_transactions(id,payment_attempt_id,checkout_session_id,status,amount_mxn,currency,provider,provider_charge_id)
        values($1,$2,$3,'succeeded',$4,$5,$6,$7)
      `, [randomUUID(), attempt.id, attempt.checkout_session_id, attempt.amount_mxn, attempt.currency, attempt.provider, chargeId]);
      const createdOrder = await createOrder(client, checkout, attempt);
      await client.query("commit");
      for (const socket of context.sockets) if (socket.readyState === 1) socket.send(JSON.stringify({ type: "sale_confirmed", order_id: createdOrder.orderId, amount_mxn: attempt.amount_mxn }));
      return { attempt: attemptResponse(attempt), order_id: createdOrder.orderId, order_access_token: createdOrder.orderAccessToken, refunded_oversell: false };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get<{Params:{order_id:string}}>("/orders/:order_id",async(request)=>orderResponse(context,request,"id",request.params.order_id));
  app.get<{Params:{checkout_id:string}}>("/orders/by-checkout/:checkout_id",async(request)=>orderResponse(context,request,"checkout_session_id",request.params.checkout_id));
  app.get("/orders/lookup",async(request)=>{const query=asObject(request.query);const email=String(query.email??"").toLowerCase();const orders=(await context.database.query("select * from orders where lower(customer_email)=$1 order by created_at desc",[email])).rows;const order=orders.find(row=>row.id.replaceAll("-","").slice(0,8).toUpperCase()===String(query.order_code??"").replaceAll("-","").toUpperCase());if(!order)throw new HttpError(404,"Pedido no encontrado");await authorizeOrderAccess(context,request,order);return{id:order.id,status:order.status,shipping_method:order.shipping_method,order_code:order.id.replaceAll("-","").slice(0,8).toUpperCase()};});
  app.post("/internal/orders/from-checkout",async(request)=>{const body=asObject(request.body);const existing=(await context.database.query("select id from orders where checkout_session_id=$1",[body.checkout_session_id])).rows[0];return{order_id:existing?.id??null};});
  app.get("/internal/orders/lookup",async(request)=>{const query=asObject(request.query);return orderResponse(context,request,"id",String(query.order_id));});
}
