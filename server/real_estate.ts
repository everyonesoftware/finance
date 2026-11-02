import { Hono } from "hono";
import { auth } from "./auth.js";
import { sqliteClient } from "./database.js";
import { fetchZillowZestimate } from "./zillow.js";

export const realEstateRouter = new Hono();

async function userId(request: Request): Promise<string | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user.id ?? null;
}

realEstateRouter.get("/", async (context) => {
  context.header("Cache-Control", "no-store");
  const owner = await userId(context.req.raw);
  if (!owner) return context.json({ error: "Authentication required." }, 401);
  const properties = sqliteClient.prepare(`
    SELECT c.id, c.address, c.latitude, c.longitude, c.created_at AS createdAt,
      e.id AS estimateId, e.provider, e.amount, e.created_at AS estimateAt
    FROM real_estate_connection c
    LEFT JOIN real_estate_estimate e ON e.connection_id=c.id AND e.user_id=c.user_id
    WHERE c.user_id=? ORDER BY c.created_at DESC, e.created_at DESC
  `).all(owner) as Array<{id:string;address:string;latitude:number;longitude:number;createdAt:number;estimateId:string|null;provider:"manual"|"zillow"|null;amount:number|null;estimateAt:number|null}>;
  const grouped = new Map<string, {id:string;address:string;latitude:number;longitude:number;createdAt:number;estimates:Array<{id:string;provider:"manual"|"zillow";amount:number;createdAt:number}>}>();
  for (const row of properties) {
    let property = grouped.get(row.id);
    if (!property) { property={id:row.id,address:row.address,latitude:row.latitude,longitude:row.longitude,createdAt:row.createdAt,estimates:[]}; grouped.set(row.id,property); }
    if (row.estimateId && row.provider && row.amount !== null && row.estimateAt !== null) property.estimates.push({id:row.estimateId,provider:row.provider,amount:row.amount,createdAt:row.estimateAt});
  }
  return context.json({ properties:[...grouped.values()] });
});

realEstateRouter.delete("/:id", async (context) => {
  context.header("Cache-Control", "no-store");
  const owner = await userId(context.req.raw);
  if (!owner) return context.json({ error: "Authentication required." }, 401);
  const result = sqliteClient.prepare("DELETE FROM real_estate_connection WHERE id=? AND user_id=?").run(context.req.param("id"), owner);
  if (result.changes === 0) return context.json({ error: "Property not found." }, 404);
  return context.body(null, 204);
});

realEstateRouter.post("/", async (context) => {
  const owner = await userId(context.req.raw);
  if (!owner) return context.json({ error: "Authentication required." }, 401);
  const body: unknown = await context.req.json().catch(() => null);
  if (!body || typeof body !== "object") return context.json({error:"Invalid property."},400);
  const value=body as Record<string,unknown>;
  const {address,latitude,longitude,amount,zillowUrl}=value;
  const isManual=typeof amount==="number"&&Number.isFinite(amount)&&amount>=0;
  const isZillow=typeof zillowUrl==="string"&&zillowUrl.trim().length>0;
  const manualFieldProvided=Object.hasOwn(value,"amount");
  const zillowFieldProvided=Object.hasOwn(value,"zillowUrl");
  if (typeof address!=="string" || !address.trim() || address.length>500 || typeof latitude!=="number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || typeof longitude!=="number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || manualFieldProvided===zillowFieldProvided || (manualFieldProvided&&!isManual) || (zillowFieldProvided&&!isZillow)) return context.json({error:"Provide an address, map location, and either a manual estimate or Zillow property URL."},400);

  let estimateAmount:number;
  let provider:"manual"|"zillow";
  if (isZillow) {
    const requestedAt=Date.now();
    const reservation=sqliteClient.prepare(`
      INSERT INTO real_estate_zillow_request(user_id,requested_at) VALUES(?,?)
      ON CONFLICT(user_id) DO UPDATE SET requested_at=excluded.requested_at
      WHERE real_estate_zillow_request.requested_at<=?
    `).run(owner,requestedAt,requestedAt-86_400_000);
    if (reservation.changes===0) return context.json({error:"Zillow refresh is limited to one request per 24 hours."},429);
    try { estimateAmount=await fetchZillowZestimate(zillowUrl as string); }
    catch(error) { return context.json({error:error instanceof Error?error.message:"Unable to retrieve Zillow estimate."},422); }
    provider="zillow";
  } else {
    estimateAmount=amount as number;
    provider="manual";
  }

  const id=crypto.randomUUID();
  const createdAt=Date.now();
  const save=sqliteClient.transaction(() => {
    sqliteClient.prepare("INSERT INTO real_estate_connection(id,user_id,address,latitude,longitude) VALUES(?,?,?,?,?)").run(id,owner,address.trim(),latitude,longitude);
    sqliteClient.prepare("INSERT INTO real_estate_estimate(id,connection_id,user_id,provider,amount,created_at) VALUES(?,?,?,?,?,?)").run(crypto.randomUUID(),id,owner,provider,estimateAmount,createdAt);
  });
  save();
  return context.json({id,provider,amount:estimateAmount,createdAt},201);
});

realEstateRouter.post("/:id/zillow", async (context) => {
  context.header("Cache-Control", "no-store");
  const owner=await userId(context.req.raw);
  if (!owner) return context.json({error:"Authentication required."},401);
  const propertyId=context.req.param("id");
  const property=sqliteClient.prepare("SELECT 1 FROM real_estate_connection WHERE id=? AND user_id=?").get(propertyId,owner);
  if (!property) return context.json({error:"Property not found."},404);
  const body:unknown=await context.req.json().catch(()=>null);
  const zillowUrl=body&&typeof body==="object"?(body as Record<string,unknown>).zillowUrl:null;
  if (typeof zillowUrl!=="string"||!zillowUrl.trim()) return context.json({error:"Provide a Zillow property-page URL."},400);
  const requestedAt=Date.now();
  const reservation=sqliteClient.prepare(`
    INSERT INTO real_estate_zillow_request(user_id,requested_at) VALUES(?,?)
    ON CONFLICT(user_id) DO UPDATE SET requested_at=excluded.requested_at
    WHERE real_estate_zillow_request.requested_at<=?
  `).run(owner,requestedAt,requestedAt-86_400_000);
  if (reservation.changes===0) return context.json({error:"Zillow refresh is limited to one request per 24 hours."},429);
  let amount:number;
  try { amount=await fetchZillowZestimate(zillowUrl); }
  catch(error) { return context.json({error:error instanceof Error?error.message:"Unable to retrieve Zillow estimate."},422); }
  const createdAt=Date.now();
  const estimateId=crypto.randomUUID();
  sqliteClient.prepare("INSERT INTO real_estate_estimate(id,connection_id,user_id,provider,amount,created_at) VALUES(?,?,?,'zillow',?,?)").run(estimateId,propertyId,owner,amount,createdAt);
  return context.json({id:estimateId,provider:"zillow",amount,createdAt},201);
});

realEstateRouter.post("/:id/estimates", async (context) => {
  const owner=await userId(context.req.raw);
  if (!owner) return context.json({error:"Authentication required."},401);
  const id=context.req.param("id");
  const body: unknown=await context.req.json().catch(()=>null);
  const amount=body && typeof body==="object" ? (body as Record<string,unknown>).amount : null;
  if (typeof amount!=="number" || !Number.isFinite(amount) || amount<0) return context.json({error:"Provide a non-negative manual estimate."},400);
  const exists=sqliteClient.prepare("SELECT 1 FROM real_estate_connection WHERE id=? AND user_id=?").get(id,owner);
  if (!exists) return context.json({error:"Property not found."},404);
  const result=sqliteClient.prepare("INSERT INTO real_estate_estimate(id,connection_id,user_id,provider,amount,created_at) VALUES(?,?,?,'manual',?,?)").run(crypto.randomUUID(),id,owner,amount,Date.now());
  return context.json({id:result.lastInsertRowid},201);
});
