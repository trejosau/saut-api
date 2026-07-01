import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type pg from "pg";

import { config } from "../config.js";
import { asObject, HttpError } from "../platform.js";
import { quoteNational } from "../providers/skydropx.js";
import type { AppContext } from "../types.js";

function cartItem(row: any): any {
  return { ...row, line_total_mxn: Number(row.unit_price_mxn) * Number(row.quantity) };
}

async function cartResponse(context: AppContext, id: string, client: pg.Pool | pg.PoolClient = context.pool): Promise<any> {
  const cart = (await client.query("select * from carts where id=$1", [id])).rows[0];
  if (!cart) throw new HttpError(404, "Carrito no encontrado");
  const items = (await client.query("select * from cart_items where cart_id=$1 order by created_at", [id])).rows.map(cartItem);
  return { ...cart, total_items: items.reduce((sum, item) => sum + Number(item.quantity), 0), subtotal_mxn: items.reduce((sum, item) => sum + item.line_total_mxn, 0), items };
}

async function checkoutResponse(context: AppContext, id: string, client: pg.Pool | pg.PoolClient = context.pool): Promise<any> {
  const checkout = (await client.query("select * from checkout_sessions where id=$1", [id])).rows[0];
  if (!checkout) throw new HttpError(404, "Checkout no encontrado");
  const cart = await cartResponse(context, checkout.cart_id, client);
  return { ...checkout, shipping_quotes: checkout.shipping_quotes ?? [], items: cart.items };
}

function attemptResponse(row: any): any {
  return { ...row, checkout_url: row.metadata?.checkout_url ?? null };
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

async function createOrder(client: pg.PoolClient, checkout: any, attempt: any): Promise<string> {
  const existing = await client.query<{ id: string }>("select id from orders where checkout_session_id=$1", [checkout.id]);
  if (existing.rows[0]) return existing.rows[0].id;
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
  await client.query(`insert into orders(
    id,checkout_session_id,payment_attempt_id,payment_reference,customer_email,customer_phone,shipping_method,
    shipping_cost_mxn,subtotal_mxn,total_mxn,currency,address,status,drop_id,drop_number,drop_total_limit)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'paid',$13,$14,$15)`,
  [orderId, checkout.id, attempt.id, attempt.provider_charge_id ?? attempt.provider_payment_intent_id ?? attempt.id,
    checkout.email, checkout.phone, checkout.shipping_method, checkout.shipping_cost_mxn, checkout.subtotal_mxn,
    checkout.total_mxn, checkout.currency, checkout.address, primaryDrop, dropNumber,
    items.find((item) => item.drop_total_limit)?.drop_total_limit ?? null]);
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
  return orderId;
}

async function orderResponse(context: AppContext, where: string, value: string): Promise<any> {
  const order = (await context.pool.query(`select * from orders where ${where}=$1`, [value])).rows[0];
  if (!order) throw new HttpError(404, "Pedido no encontrado");
  const items = (await context.pool.query("select * from order_items where order_id=$1 order by created_at", [order.id])).rows;
  return { ...order, email: order.customer_email, phone: order.customer_phone, drop_label: order.drop_number ? `#${order.drop_number}` : null, items };
}

async function stripeCheckout(context: AppContext, checkout: any, returnOrigin?: string): Promise<any> {
  const origin = typeof returnOrigin === "string" && /^https?:\/\//.test(returnOrigin) ? returnOrigin : "http://localhost:4200";
  return context.stripe.checkout.sessions.create({
    mode: "payment",
    success_url: `${origin}/checkout?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/checkout?payment=cancelled`,
    customer_email: checkout.email,
    line_items: [{ quantity: 1, price_data: { currency: "mxn", unit_amount: Number(checkout.total_mxn) * 100, product_data: { name: `Pedido SAUT ${checkout.id}` } } }],
    metadata: { checkout_session_id: checkout.id }
  });
}

export async function expirePaymentReservations(context: AppContext): Promise<void> {
  const expired = await context.pool.query<any>("select * from payment_attempts where status='pending' and created_at < now()-interval '30 minutes' limit 100");
  for (const attempt of expired.rows) {
    const client = await context.pool.connect();
    try { await client.query("begin"); await releaseReservations(client, attempt, "expired"); await client.query("update payment_attempts set status='expired',updated_at=now() where id=$1", [attempt.id]); await client.query("commit"); }
    catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
}

export async function registerCommerce(app: FastifyInstance, context: AppContext): Promise<void> {
  app.post("/cart/sessions", async (request, reply) => {
    const body=asObject(request.body);const id=randomUUID();await context.pool.query("insert into carts(id,status,guest_session_id,account_id) values($1,'active',$2,$3)",[id,body.guest_session_id??null,body.account_id??null]);reply.status(201);return cartResponse(context,id);
  });
  app.get<{Params:{cart_id:string}}>("/cart/sessions/:cart_id",async(request)=>cartResponse(context,request.params.cart_id));
  app.post<{Params:{cart_id:string}}>("/cart/sessions/:cart_id/items/predesigned",async(request,reply)=>{
    const body=asObject(request.body);const publication=(await context.pool.query("select * from publications where slug=$1 or id=$2 limit 1",[body.publication_slug,body.publication_id??null])).rows[0];if(!publication)throw new HttpError(404,"Publicación no encontrada");
    const drop=(await context.pool.query("select d.* from drops d join drop_items di on di.drop_id=d.id where di.publication_id=$1 and d.status='active' order by d.starts_at desc nulls last limit 1",[publication.id])).rows[0];
    await context.pool.query(`insert into cart_items(id,cart_id,item_type,publication_id,publication_slug,design_variant_id,garment_type,garment_model,color,size,grammage_g,fit,quantity,unit_price_mxn,drop_id,drop_total_limit,meta)
      values($1,$2,'predesigned',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[randomUUID(),request.params.cart_id,publication.id,publication.slug,body.design_variant_id??null,body.garment_type??publication.garment_type,body.garment_model??publication.garment_model??"",body.color,body.size,body.grammage_g,body.fit??"",body.quantity,body.unit_price_mxn??publication.price_mxn,drop?.id??null,drop?.capacity_total??null,body.meta??null]);reply.status(201);return cartResponse(context,request.params.cart_id);
  });
  app.post<{Params:{cart_id:string}}>("/cart/sessions/:cart_id/items/customized",async(request,reply)=>{
    const body=asObject(request.body);const front=Array.isArray(body.front_assets)?body.front_assets:[];const back=Array.isArray(body.back_assets)?body.back_assets:[];if(front.length+back.length>10)throw new HttpError(400,"Máximo 10 imágenes por personalización");
    await context.pool.query(`insert into cart_items(id,cart_id,item_type,garment_type,garment_model,color,size,grammage_g,fit,quantity,unit_price_mxn,custom_front,custom_back,custom_note,improve_quality,meta)
      values($1,$2,'customized',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[randomUUID(),request.params.cart_id,body.garment_type,body.garment_model??"",body.color,body.size,body.grammage_g,body.fit??"",body.quantity,body.unit_price_mxn,JSON.stringify(front),JSON.stringify(back),body.note??null,Boolean(body.improve_quality),body.meta??null]);reply.status(201);return cartResponse(context,request.params.cart_id);
  });
  app.delete<{Params:{cart_id:string;item_id:string}}>("/cart/sessions/:cart_id/items/:item_id",async(request)=>{await context.pool.query("delete from cart_items where id=$1 and cart_id=$2",[request.params.item_id,request.params.cart_id]);return cartResponse(context,request.params.cart_id);});

  app.post("/checkout/sessions",async(request,reply)=>{const body=asObject(request.body);const cart=await cartResponse(context,String(body.cart_id));if(cart.items.length===0)throw new HttpError(400,"El carrito está vacío");const local=String(body.address?.city??"").toLowerCase().includes("torre");const quotes=local?[{quote_id:"local-standard",provider:"saut-local",service:"local",price_mxn:config.LOCAL_SHIPPING_COST_MXN,eta_days:1}]:await quoteNational(asObject(body.address),String(body.cart_id));const selected=quotes.find(q=>q.quote_id===body.selected_quote_id)??quotes[0]!;const id=randomUUID();await context.pool.query(`insert into checkout_sessions(id,cart_id,status,email,phone,address,shipping_method,shipping_quote_id,shipping_provider,shipping_service,shipping_cost_mxn,shipping_quotes,subtotal_mxn,total_mxn,currency)
    values($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'MXN')`,[id,cart.id,body.email,body.phone,body.address,local?"local":"national",selected.quote_id,selected.provider,selected.service,selected.price_mxn,JSON.stringify(quotes),cart.subtotal_mxn,cart.subtotal_mxn+selected.price_mxn]);reply.status(201);return checkoutResponse(context,id);});
  app.get<{Params:{checkout_id:string}}>("/checkout/sessions/:checkout_id",async(request)=>checkoutResponse(context,request.params.checkout_id));
  app.post<{Params:{checkout_id:string}}>("/checkout/sessions/:checkout_id/shipping/select",async(request)=>{const body=asObject(request.body);const row=(await context.pool.query("select shipping_quotes from checkout_sessions where id=$1",[request.params.checkout_id])).rows[0];if(!row)throw new HttpError(404,"Checkout no encontrado");const quote=(row.shipping_quotes??[]).find((item:any)=>item.quote_id===body.quote_id);if(!quote)throw new HttpError(400,"Cotización no encontrada");await context.pool.query("update checkout_sessions set shipping_quote_id=$2,shipping_provider=$3,shipping_service=$4,shipping_cost_mxn=$5,total_mxn=subtotal_mxn+$5,updated_at=now() where id=$1",[request.params.checkout_id,quote.quote_id,quote.provider,quote.service,quote.price_mxn]);return checkoutResponse(context,request.params.checkout_id);});
  app.get<{Params:{checkout_id:string}}>("/internal/checkout/sessions/:checkout_id/payable",async(request)=>checkoutResponse(context,request.params.checkout_id));
  app.post<{Params:{checkout_id:string}}>("/internal/checkout/sessions/:checkout_id/mark-paid",async(request)=>{const body=asObject(request.body);await context.pool.query("update checkout_sessions set status='paid',paid_at=now(),payment_attempt_id=$2,order_id=$3,updated_at=now() where id=$1",[request.params.checkout_id,body.payment_attempt_id,body.order_id??null]);return checkoutResponse(context,request.params.checkout_id);});

  app.post("/payments/attempts",async(request,reply)=>{const body=asObject(request.body);const client=await context.pool.connect();try{await client.query("begin");const checkout=(await client.query("select * from checkout_sessions where id=$1 for update",[body.checkout_session_id])).rows[0];if(!checkout)throw new HttpError(404,"Checkout no encontrado");if(checkout.status!=="pending")throw new HttpError(409,"Checkout no disponible para pago");const items=(await client.query("select * from cart_items where cart_id=$1",[checkout.cart_id])).rows;const id=randomUUID();const reservations=await reserveStock(client,items,id);let providerId=`mock_${id}`;let clientSecret=`mock_secret_${id}`;let checkoutUrl:null|string=null;if(config.STRIPE_MODE==="live"){const stripeSession=await stripeCheckout(context,checkout,body.return_origin);providerId=stripeSession.id;clientSecret=String(stripeSession.client_secret??"");checkoutUrl=stripeSession.url;}const metadata={reservations,checkout_url:checkoutUrl,reservations_released:false};const attempt=(await client.query(`insert into payment_attempts(id,checkout_session_id,status,amount_mxn,currency,provider,provider_payment_intent_id,client_secret,metadata)
      values($1,$2,'pending',$3,$4,'stripe',$5,$6,$7) returning *`,[id,checkout.id,checkout.total_mxn,checkout.currency,providerId,clientSecret,metadata])).rows[0];await client.query("update checkout_sessions set payment_attempt_id=$2,updated_at=now() where id=$1",[checkout.id,id]);await client.query("commit");reply.status(201);return attemptResponse(attempt);}catch(error){await client.query("rollback");throw error;}finally{client.release();}});
  app.get<{Params:{attempt_id:string}}>("/payments/attempts/:attempt_id",async(request)=>{const row=(await context.pool.query("select * from payment_attempts where id=$1",[request.params.attempt_id])).rows[0];if(!row)throw new HttpError(404,"Intento de pago no encontrado");return attemptResponse(row);});
  app.post<{Params:{attempt_id:string}}>("/payments/attempts/:attempt_id/cancel",async(request)=>{const client=await context.pool.connect();try{await client.query("begin");const attempt=(await client.query("select * from payment_attempts where id=$1 for update",[request.params.attempt_id])).rows[0];if(!attempt)throw new HttpError(404,"Intento de pago no encontrado");if(attempt.status==="pending"){if(config.STRIPE_MODE==="live"&&attempt.provider_payment_intent_id)await context.stripe.checkout.sessions.expire(attempt.provider_payment_intent_id).catch(()=>undefined);await releaseReservations(client,attempt,"cancelled");}const row=(await client.query("update payment_attempts set status='cancelled',updated_at=now() where id=$1 returning *",[attempt.id])).rows[0];await client.query("commit");return attemptResponse(row);}catch(error){await client.query("rollback");throw error;}finally{client.release();}});
  app.post<{Params:{attempt_id:string}}>("/payments/attempts/:attempt_id/confirm",async(request)=>{const client=await context.pool.connect();try{await client.query("begin");let attempt=(await client.query("select * from payment_attempts where id=$1 for update",[request.params.attempt_id])).rows[0];if(!attempt)throw new HttpError(404,"Intento de pago no encontrado");if(attempt.status==="succeeded"){const order=(await client.query("select id from orders where payment_attempt_id=$1",[attempt.id])).rows[0];await client.query("commit");return{attempt:attemptResponse(attempt),order_id:order?.id??null,refunded_oversell:false};}if(attempt.status!=="pending")throw new HttpError(409,"Intento no confirmable");let chargeId=`mock_charge_${attempt.id}`;if(config.STRIPE_MODE==="live"){const session=await context.stripe.checkout.sessions.retrieve(attempt.provider_payment_intent_id);if(session.payment_status!=="paid")throw new HttpError(409,"El pago aún no está confirmado");chargeId=typeof session.payment_intent==="string"?session.payment_intent:String((session.payment_intent as any)?.id??session.id);}if(!Array.isArray(attempt.metadata?.reservations)||attempt.metadata.reservations_released){if(config.STRIPE_MODE==="live"&&chargeId)await context.stripe.refunds.create({payment_intent:chargeId}).catch(()=>undefined);attempt=(await client.query("update payment_attempts set status='refunded',failure_reason='oversell',updated_at=now() where id=$1 returning *",[attempt.id])).rows[0];await client.query("commit");return{attempt:attemptResponse(attempt),order_id:null,refunded_oversell:true};}attempt=(await client.query("update payment_attempts set status='succeeded',provider_charge_id=$2,updated_at=now() where id=$1 returning *",[attempt.id,chargeId])).rows[0];await client.query(`insert into payment_transactions(id,payment_attempt_id,checkout_session_id,status,amount_mxn,currency,provider,provider_charge_id)
      values($1,$2,$3,'succeeded',$4,$5,$6,$7)`,[randomUUID(),attempt.id,attempt.checkout_session_id,attempt.amount_mxn,attempt.currency,attempt.provider,chargeId]);const checkout=(await client.query("select * from checkout_sessions where id=$1 for update",[attempt.checkout_session_id])).rows[0];const orderId=await createOrder(client,checkout,attempt);await client.query("commit");for(const socket of context.sockets)if(socket.readyState===1)socket.send(JSON.stringify({type:"sale_confirmed",order_id:orderId,amount_mxn:attempt.amount_mxn}));return{attempt:attemptResponse(attempt),order_id:orderId,refunded_oversell:false};}catch(error){await client.query("rollback");throw error;}finally{client.release();}});

  app.get<{Params:{order_id:string}}>("/orders/:order_id",async(request)=>orderResponse(context,"id",request.params.order_id));
  app.get<{Params:{checkout_id:string}}>("/orders/by-checkout/:checkout_id",async(request)=>orderResponse(context,"checkout_session_id",request.params.checkout_id));
  app.get("/orders/lookup",async(request)=>{const query=asObject(request.query);const email=String(query.email??"").toLowerCase();const orders=(await context.pool.query("select * from orders where lower(customer_email)=$1 order by created_at desc",[email])).rows;const order=orders.find(row=>row.id.replaceAll("-","").slice(0,8).toUpperCase()===String(query.order_code??"").replaceAll("-","").toUpperCase());if(!order)throw new HttpError(404,"Pedido no encontrado");return{id:order.id,email:order.customer_email,phone:order.customer_phone,status:order.status,shipping_method:order.shipping_method,order_code:order.id.replaceAll("-","").slice(0,8).toUpperCase()};});
  app.post("/internal/orders/from-checkout",async(request)=>{const body=asObject(request.body);const existing=(await context.pool.query("select id from orders where checkout_session_id=$1",[body.checkout_session_id])).rows[0];return{order_id:existing?.id??null};});
  app.get("/internal/orders/lookup",async(request)=>{const query=asObject(request.query);return orderResponse(context,"id",String(query.order_id));});
}
