import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { asObject, audit, HttpError, pagination } from "../platform.js";
import { deleteRow, insertRow, patchRow } from "../sql.js";
import type { AppContext } from "../types.js";

const publicationColumns = [
  "id", "slug", "title", "description", "garment_type", "garment_model", "design_id", "category",
  "visibility", "is_active", "is_seasonal", "sort_rank", "price_mxn", "cover_asset_id",
  "preview_front_asset_id", "preview_back_asset_id", "informative_image_id", "viewer_asset_id",
  "front_print_x_pct", "front_print_y_pct", "front_print_w_pct", "front_print_h_pct",
  "back_print_x_pct", "back_print_y_pct", "back_print_w_pct", "back_print_h_pct"
] as const;
const designColumns = ["id", "name", "has_variants", "default_front_design_url", "default_back_design_url"] as const;
const variantColumns = ["id", "design_id", "code", "label", "dtf_asset_id", "public_preview_asset_id", "front_design_url", "back_design_url", "is_active", "sort_rank"] as const;
const collectionColumns = ["id", "slug", "title", "description", "visibility", "cover_asset_id", "informative_image_id"] as const;
const dropColumns = ["id", "slug", "title", "description", "status", "starts_at", "ends_at", "capacity_total", "visibility", "cover_asset_id", "informative_image_id"] as const;
const informativeColumns = ["id", "scope_type", "scope_id", "asset_id"] as const;
const mockupColumns = ["variant_id", "garment_color", "view_side", "mockup_asset_id", "mockup_url"] as const;

function urlForAsset(id: string | null | undefined): string | null {
  return id ? `/assets/${id}/download` : null;
}

function decoratePublication(row: any): any {
  return {
    ...row,
    cover_url: urlForAsset(row.cover_asset_id),
    preview_front_url: urlForAsset(row.preview_front_asset_id),
    preview_back_url: urlForAsset(row.preview_back_asset_id),
    informative_image_url: row.informative_asset_id ? urlForAsset(row.informative_asset_id) : null,
    stock_qty: row.stock_qty === undefined ? null : Number(row.stock_qty),
    stock_units: row.stock_qty === undefined ? null : Number(row.stock_qty),
    inventory_qty: row.stock_qty === undefined ? null : Number(row.stock_qty)
  };
}

const publicationSelect = `
  select p.*, d.name as design_name, d.has_variants, d.default_front_design_url, d.default_back_design_url,
    ii.asset_id as informative_asset_id,
    (select coalesce(sum(i.quantity),0) from inventory_items i where i.garment_type=p.garment_type
      and (p.garment_model is null or i.garment_model=p.garment_model)) as stock_qty
  from publications p join designs d on d.id=p.design_id
  left join informative_images ii on ii.id=p.informative_image_id
`;

async function publicationBy(context: AppContext, column: "id" | "slug", value: string, publicOnly = false): Promise<any> {
  const visibility = publicOnly ? " and p.is_active=true and p.visibility in ('public','visible')" : "";
  const result = await context.database.query(`${publicationSelect} where p.${column}=$1${visibility}`, [value]);
  if (!result.rows[0]) throw new HttpError(404, "Publicación no encontrada");
  return decoratePublication(result.rows[0]);
}

async function publicationDetail(context: AppContext, column: "id" | "slug", value: string, publicOnly = false): Promise<any> {
  const publication = await publicationBy(context, column, value, publicOnly);
  const [design, variants, mockups] = await Promise.all([
    context.database.query("select * from designs where id=$1", [publication.design_id]),
    context.database.query(`select v.*, ${"'"}/assets/${"'"} || v.dtf_asset_id || '/download' as dtf_asset_url,
      case when v.public_preview_asset_id is null then null else '/assets/' || v.public_preview_asset_id || '/download' end as public_preview_url
      from design_variants v where design_id=$1${publicOnly ? " and is_active=true" : ""} order by sort_rank,id`, [publication.design_id]),
    context.database.query("select * from publication_mockups where publication_id=$1 order by created_at", [publication.id])
  ]);
  return { publication, design: design.rows[0], variants: variants.rows, mockups: mockups.rows.map((row) => ({ ...row, mockup_url: row.mockup_url ?? urlForAsset(row.mockup_asset_id) })) };
}

async function patchPublicationMockup(context: AppContext, publicationId: string, mockupId: string, input: Record<string, any>): Promise<any> {
  const keys = mockupColumns.filter((key) => input[key] !== undefined);
  if (keys.length === 0) throw new HttpError(400, "Payload vacío");
  const values = keys.map((key) => input[key]);
  values.push(mockupId, publicationId);
  const row = (await context.database.query(
    `update publication_mockups set ${keys.map((key, index) => `${key}=$${index + 1}`).join(",")}
      where id=$${values.length - 1} and publication_id=$${values.length} returning *`,
    values
  )).rows[0];
  if (!row) throw new HttpError(404, "Registro no encontrado");
  return row;
}

function normalizeVisibility(value: unknown): unknown {
  if (value === "visible") return "public";
  if (value === "hidden") return "hidden";
  return value;
}

function normalizedInput(input: Record<string, any>): Record<string, any> {
  return { ...input, ...(input.visibility !== undefined ? { visibility: normalizeVisibility(input.visibility) } : {}) };
}

async function listGeneric(context: AppContext, table: string, query: Record<string, any>, searchColumn: string, filters: string[]): Promise<any[]> {
  const values: any[] = []; const where: string[] = [];
  if (query.q) { values.push(`%${query.q}%`); where.push(`${searchColumn} ilike $${values.length}`); }
  for (const filter of filters) if (query[filter] !== undefined) { values.push(normalizeVisibility(query[filter])); where.push(`${filter}=$${values.length}`); }
  const { limit, offset } = pagination(query); values.push(limit, offset);
  return (await context.database.query(`select * from ${table} ${where.length ? `where ${where.join(" and ")}` : ""} order by created_at desc limit $${values.length - 1} offset $${values.length}`, values)).rows;
}

export async function registerCatalog(app: FastifyInstance, context: AppContext): Promise<void> {
  app.get("/catalog/publications", async (request) => {
    const query = asObject(request.query); const values: any[] = []; const where = ["p.is_active=true", "p.visibility in ('public','visible')"];
    for (const key of ["category", "garment_type"]) if (query[key]) { values.push(query[key]); where.push(`p.${key}=$${values.length}`); }
    const sort = query.sort === "az" ? "p.title asc" : query.sort === "za" ? "p.title desc" : query.sort === "price_desc" ? "p.price_mxn desc" : query.sort === "price_asc" ? "p.price_mxn asc" : "p.sort_rank desc,p.created_at desc";
    const rows = (await context.database.query(`${publicationSelect} where ${where.join(" and ")} order by ${sort}`, values)).rows;
    const result = [];
    for (const row of rows) {
      const variants = await context.database.query("select id,code,label,front_design_url,back_design_url,sort_rank from design_variants where design_id=$1 and is_active=true order by sort_rank", [row.design_id]);
      result.push({ ...decoratePublication(row), variants_preview: variants.rows });
    }
    return result;
  });
  app.get<{ Params: { slug: string } }>("/catalog/publications/:slug", async (request) => publicationDetail(context, "slug", request.params.slug, true));
  app.get("/catalog/collections", async () => {
    const rows = (await context.database.query(`select c.*,case when c.cover_asset_id is null then null else '/assets/'||c.cover_asset_id||'/download' end cover_url,
      case when ii.asset_id is null then null else '/assets/'||ii.asset_id||'/download' end informative_image_url
      from collections_sets c left join informative_images ii on ii.id=c.informative_image_id where c.visibility in ('public','visible') order by c.created_at desc`)).rows; return rows;
  });
  app.get<{ Params: { slug: string } }>("/catalog/collections/:slug", async (request) => {
    const collection = (await context.database.query("select * from collections_sets where slug=$1 and visibility in ('public','visible')", [request.params.slug])).rows[0];
    if (!collection) throw new HttpError(404, "Colección no encontrada");
    const items = (await context.database.query(`${publicationSelect} join collection_set_items ci on ci.publication_id=p.id where ci.collection_id=$1 and p.is_active=true and p.visibility in ('public','visible') order by ci.position_index`, [collection.id])).rows.map(decoratePublication);
    return { collection: { ...collection, cover_url: urlForAsset(collection.cover_asset_id), informative_image_url: null }, items };
  });
  app.get("/catalog/drops", async (request) => {
    const query = asObject(request.query); const values: any[]=[]; const where:string[]=[];
    where.push("visibility in ('public','visible')");
    if(query.status){values.push(query.status);where.push(`status=$${values.length}`);}
    return (await context.database.query(`select *,case when cover_asset_id is null then null else '/assets/'||cover_asset_id||'/download' end cover_url from drops ${where.length?`where ${where.join(" and ")}`:""} order by created_at desc`,values)).rows;
  });
  app.get<{ Params: { slug: string } }>("/catalog/drops/:slug", async (request) => {
    const drop=(await context.database.query("select * from drops where slug=$1 and visibility in ('public','visible')",[request.params.slug])).rows[0]; if(!drop)throw new HttpError(404,"Drop no encontrado");
    const items=(await context.database.query(`${publicationSelect} join drop_items di on di.publication_id=p.id where di.drop_id=$1 and p.is_active=true and p.visibility in ('public','visible') order by di.position_index`,[drop.id])).rows.map(decoratePublication);
    return {drop:{...drop,cover_url:urlForAsset(drop.cover_asset_id),informative_image_url:null},items};
  });
  app.get("/catalog/season", async () => (await context.database.query("select is_enabled,updated_at from season_config where id=1")).rows[0] ?? { is_enabled:false });
  app.get<{ Params: { id: string } }>("/internal/catalog/drops/:id/eligibility", async (request) => {
    const drop=(await context.database.query("select * from drops where id=$1",[request.params.id])).rows[0]; if(!drop)throw new HttpError(404,"Drop no encontrado");
    const sold=Number((await context.database.query("select count(*) from orders where drop_id=$1",[drop.id])).rows[0]?.count??0); return {eligible:drop.status==="active"&&(!drop.capacity_total||sold<drop.capacity_total),sold,capacity_total:drop.capacity_total};
  });

  app.get("/admin/catalog/publications", async (request) => {
    const query=asObject(request.query);const values:any[]=[];const where:string[]=[];
    if(query.q){values.push(`%${query.q}%`);where.push(`(p.title ilike $${values.length} or p.slug ilike $${values.length})`);} for(const key of ["garment_type","category","is_active"])if(query[key]!==undefined){values.push(query[key]);where.push(`p.${key}=$${values.length}`);} if(query.visibility){values.push(normalizeVisibility(query.visibility));where.push(`p.visibility=$${values.length}`);} const {limit,offset}=pagination(query);values.push(limit,offset);
    return (await context.database.query(`${publicationSelect} ${where.length?`where ${where.join(" and ")}`:""} order by p.created_at desc limit $${values.length-1} offset $${values.length}`,values)).rows.map(decoratePublication);
  });
  app.post("/admin/catalog/publications",async(request,reply)=>{const body=normalizedInput(asObject(request.body));const row=await insertRow<any>(context.database,"publications",{...body,id:randomUUID()},publicationColumns,{visibility:"public",is_active:true,is_seasonal:false,sort_rank:0,price_mxn:0});await audit(request,"catalog.publication_created","publication",row.id,body);reply.status(201);return decoratePublication(row);});
  app.get<{Params:{id:string}}>("/admin/catalog/publications/:id",async(request)=>publicationDetail(context,"id",request.params.id));
  const updatePublication=async(request:any)=>{const row=await patchRow<any>(context.database,"publications",request.params.id,normalizedInput(asObject(request.body)),publicationColumns);await audit(request,"catalog.publication_updated","publication",row.id,request.body);return decoratePublication(row);};
  app.patch("/admin/catalog/publications/:id",updatePublication);app.post("/admin/catalog/publications/:id",updatePublication);
  app.delete<{Params:{id:string}}>("/admin/catalog/publications/:id",async(request,reply)=>{await deleteRow(context.database,"publications",request.params.id);await audit(request,"catalog.publication_deleted","publication",request.params.id);reply.status(204).send();});
  app.post<{Params:{id:string}}>("/admin/catalog/publications/:id/publish",async(request)=>{const row=(await context.database.query("update publications set is_active=true,visibility='public',updated_at=now() where id=$1 returning *",[request.params.id])).rows[0];if(!row)throw new HttpError(404,"Publicación no encontrada");await audit(request,"catalog.publication_published","publication",request.params.id);return decoratePublication(row);});
  app.post<{Params:{id:string}}>("/admin/catalog/publications/:id/unpublish",async(request)=>{const row=(await context.database.query("update publications set is_active=false,visibility='hidden',updated_at=now() where id=$1 returning *",[request.params.id])).rows[0];if(!row)throw new HttpError(404,"Publicación no encontrada");await audit(request,"catalog.publication_unpublished","publication",request.params.id);return decoratePublication(row);});
  app.get<{Params:{id:string}}>("/admin/catalog/publications/:id/mockups",async(request)=>(await context.database.query("select * from publication_mockups where publication_id=$1 order by created_at",[request.params.id])).rows);
  app.post<{Params:{id:string}}>("/admin/catalog/publications/:id/mockups",async(request,reply)=>{const row=await insertRow<any>(context.database,"publication_mockups",{...asObject(request.body),id:randomUUID(),publication_id:request.params.id},["id","publication_id","variant_id","garment_color","view_side","mockup_asset_id","mockup_url"],{view_side:"front"});reply.status(201);return row;});
  app.patch<{Params:{id:string;mockup_id:string}}>("/admin/catalog/publications/:id/mockups/:mockup_id",async(request)=>patchPublicationMockup(context,request.params.id,request.params.mockup_id,asObject(request.body)));
  app.delete<{Params:{id:string;mockup_id:string}}>("/admin/catalog/publications/:id/mockups/:mockup_id",async(request,reply)=>{const result=await context.database.query("delete from publication_mockups where id=$1 and publication_id=$2",[request.params.mockup_id,request.params.id]);if(!result.rowCount)throw new HttpError(404,"Registro no encontrado");reply.status(204).send();});

  const registerCrud=(base:string,table:string,columns:readonly string[],search:string,filters:string[]=[],touchUpdatedAt=true)=>{
    app.get(base,async(request)=>listGeneric(context,table,asObject(request.query),search,filters));
    app.post(base,async(request,reply)=>{const row=await insertRow<any>(context.database,table,{...normalizedInput(asObject(request.body)),id:randomUUID()},columns);await audit(request,`${table}.created`,table,row.id,request.body);reply.status(201);return row;});
    app.get<{Params:{id:string}}>(`${base}/:id`,async(request)=>{const row=(await context.database.query(`select * from ${table} where id=$1`,[request.params.id])).rows[0];if(!row)throw new HttpError(404,"Registro no encontrado");return row;});
    app.patch<{Params:{id:string}}>(`${base}/:id`,async(request)=>{const row=await patchRow<any>(context.database,table,request.params.id,normalizedInput(asObject(request.body)),columns,touchUpdatedAt);await audit(request,`${table}.updated`,table,row.id,request.body);return row;});
    app.delete<{Params:{id:string}}>(`${base}/:id`,async(request,reply)=>{await deleteRow(context.database,table,request.params.id);await audit(request,`${table}.deleted`,table,request.params.id);reply.status(204).send();});
  };
  registerCrud("/admin/catalog/designs","designs",designColumns,"name");
  registerCrud("/admin/catalog/design-variants","design_variants",variantColumns,"label",["design_id","is_active"]);
  registerCrud("/admin/catalog/informative-images","informative_images",informativeColumns,"scope_type",["scope_type","scope_id"],false);
  registerCrud("/admin/catalog/collections","collections_sets",collectionColumns,"title",["visibility"]);
  registerCrud("/admin/catalog/drops","drops",dropColumns,"title",["status","visibility"]);

  app.put<{Params:{id:string}}>("/admin/catalog/collections/:id/items",async(request)=>{const ids=(asObject(request.body).publication_ids??asObject(request.body).items??[]) as any[];const client=await context.database.connect();try{await client.query("begin");await client.query("delete from collection_set_items where collection_id=$1",[request.params.id]);for(let i=0;i<ids.length;i++){const value=typeof ids[i]==="string"?ids[i]:ids[i].publication_id;await client.query("insert into collection_set_items(id,collection_id,publication_id,position_index) values($1,$2,$3,$4)",[randomUUID(),request.params.id,value,i]);}await client.query("commit");}catch(error){await client.query("rollback");throw error;}finally{client.release();}await audit(request,"catalog.collection_items_updated","collection",request.params.id,{count:ids.length});return{collection_id:request.params.id,items_count:ids.length};});
  app.put<{Params:{id:string}}>("/admin/catalog/drops/:id/items",async(request)=>{const ids=(asObject(request.body).publication_ids??asObject(request.body).items??[]) as any[];const client=await context.database.connect();try{await client.query("begin");await client.query("delete from drop_items where drop_id=$1",[request.params.id]);for(let i=0;i<ids.length;i++){const value=typeof ids[i]==="string"?ids[i]:ids[i].publication_id;await client.query("insert into drop_items(id,drop_id,publication_id,position_index) values($1,$2,$3,$4)",[randomUUID(),request.params.id,value,i]);}await client.query("commit");}catch(error){await client.query("rollback");throw error;}finally{client.release();}await audit(request,"catalog.drop_items_updated","drop",request.params.id,{count:ids.length});return{drop_id:request.params.id,items_count:ids.length};});
  const toggle=async(request:any)=>{const enabled=asObject(request.body).is_enabled;const current=(await context.database.query("select is_enabled from season_config where id=1")).rows[0];const next=typeof enabled==="boolean"?enabled:!current?.is_enabled;const row=(await context.database.query("insert into season_config(id,is_enabled) values(1,$1) on conflict(id) do update set is_enabled=excluded.is_enabled,updated_at=now() returning *",[next])).rows[0];await audit(request,"catalog.season_toggled","season","1",row);return row;};
  app.post("/admin/catalog/season:toggle",toggle);app.post("/admin/catalog/season/toggle",toggle);
}
