import { Hono } from "hono";
import { auth } from "./auth.js";
import { sqliteClient } from "./database.js";
import { fetchZillowZestimate } from "./zillow.js";

export const realEstateRouter = new Hono();

function validZillowUrl(value:string):boolean { try { const url=new URL(value.trim()); return url.protocol==="https:"&&["zillow.com","www.zillow.com"].includes(url.hostname); } catch { return false; } }
function validRedfinUrl(value:string):boolean { try { const url=new URL(value.trim()); return url.protocol==="https:"&&["redfin.com","www.redfin.com"].includes(url.hostname); } catch { return false; } }

async function userId(request: Request): Promise<string | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user.id ?? null;
}

realEstateRouter.get("/", async (context) => {
  context.header("Cache-Control", "no-store");
  const owner = await userId(context.req.raw);
  if (!owner) return context.json({ error: "Authentication required." }, 401);
  const properties = sqliteClient.prepare(`
    SELECT c.id, c.address, c.latitude, c.longitude, c.zillow_url AS zillowUrl, c.redfin_url AS redfinUrl, c.created_at AS createdAt,
      e.id AS estimateId, e.provider, e.amount, e.created_at AS estimateAt, e.source_notes AS sourceNotes
    FROM real_estate_connection c
    LEFT JOIN real_estate_estimate e ON e.connection_id=c.id AND e.user_id=c.user_id
    WHERE c.user_id=? ORDER BY c.created_at DESC, e.created_at DESC
  `).all(owner) as Array<{id:string;address:string;latitude:number;longitude:number;zillowUrl:string|null;redfinUrl:string|null;createdAt:number;estimateId:string|null;provider:"manual"|"zillow"|"redfin"|null;amount:number|null;estimateAt:number|null;sourceNotes:string|null}>;
  const grouped = new Map<string, {id:string;address:string;latitude:number;longitude:number;zillowUrl:string|null;redfinUrl:string|null;createdAt:number;estimates:Array<{id:string;provider:"manual"|"zillow"|"redfin";amount:number;createdAt:number;sourceNotes:string|null}>}>();
  for (const row of properties) {
    let property = grouped.get(row.id);
    if (!property) { property={id:row.id,address:row.address,latitude:row.latitude,longitude:row.longitude,zillowUrl:row.zillowUrl,redfinUrl:row.redfinUrl,createdAt:row.createdAt,estimates:[]}; grouped.set(row.id,property); }
    if (row.estimateId && row.provider && row.amount !== null && row.estimateAt !== null) property.estimates.push({id:row.estimateId,provider:row.provider,amount:row.amount,createdAt:row.estimateAt,sourceNotes:row.sourceNotes});
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
  const {address,latitude,longitude,amount,zillowUrl,redfinUrl,sourceNotes}=value;
  const isManual=typeof amount==="number"&&Number.isFinite(amount)&&amount>=0;
  const isZillow=typeof zillowUrl==="string"&&validZillowUrl(zillowUrl);
  const isRedfin=typeof redfinUrl==="string"&&validRedfinUrl(redfinUrl);
  const manualFieldProvided=Object.hasOwn(value,"amount");
  const zillowFieldProvided=Object.hasOwn(value,"zillowUrl");
  const redfinFieldProvided=Object.hasOwn(value,"redfinUrl");
  if (typeof address!=="string" || !address.trim() || address.length>500 || typeof latitude!=="number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || typeof longitude!=="number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || (!manualFieldProvided&&!zillowFieldProvided&&!redfinFieldProvided) || (manualFieldProvided&&!isManual) || (zillowFieldProvided&&!isZillow) || (redfinFieldProvided&&!isRedfin) || (sourceNotes!==undefined&&(typeof sourceNotes!=="string"||sourceNotes.length>2000))) return context.json({error:"Provide an address, map location, and at least one valid estimate source."},400);

  let estimateAmount:number|undefined;
  let provider:"manual"|"zillow"|undefined;
  if (isZillow) {
    try { estimateAmount=await fetchZillowZestimate(zillowUrl as string); }
    catch(error) { return context.json({error:error instanceof Error?error.message:"Unable to retrieve Zillow estimate."},422); }
    provider="zillow";
  }
  if(isManual) { estimateAmount=amount as number; provider="manual"; }

  const id=crypto.randomUUID();
  const createdAt=Date.now();
  const save=sqliteClient.transaction(() => {
    sqliteClient.prepare("INSERT INTO real_estate_connection(id,user_id,address,latitude,longitude,zillow_url,redfin_url) VALUES(?,?,?,?,?,?,?)").run(id,owner,address.trim(),latitude,longitude,isZillow?String(zillowUrl).trim():null,isRedfin?String(redfinUrl).trim():null);
    if(isZillow)sqliteClient.prepare("INSERT INTO real_estate_estimate(id,connection_id,user_id,provider,amount,created_at,source_notes) VALUES(?,?,?,'zillow',?,?,NULL)").run(crypto.randomUUID(),id,owner,estimateAmount,createdAt);
    if(isManual)sqliteClient.prepare("INSERT INTO real_estate_estimate(id,connection_id,user_id,provider,amount,created_at,source_notes) VALUES(?,?,?,'manual',?,?,?)").run(crypto.randomUUID(),id,owner,amount,createdAt,typeof sourceNotes==="string"?sourceNotes.trim()||null:null);
  });
  save();
  return context.json({id,provider,amount:estimateAmount,createdAt},201);
});

realEstateRouter.post("/:id/zillow", async (context) => {
  context.header("Cache-Control", "no-store");
  const owner=await userId(context.req.raw);
  if (!owner) return context.json({error:"Authentication required."},401);
  const propertyId=context.req.param("id");
  const property=sqliteClient.prepare("SELECT zillow_url AS zillowUrl FROM real_estate_connection WHERE id=? AND user_id=?").get(propertyId,owner) as {zillowUrl:string|null}|undefined;
  if (!property) return context.json({error:"Property not found."},404);
  const body:unknown=await context.req.json().catch(()=>null);
  const zillowUrl=body&&typeof body==="object"?(body as Record<string,unknown>).zillowUrl:property.zillowUrl;
  if (typeof zillowUrl!=="string"||!validZillowUrl(zillowUrl)) return context.json({error:"Provide a Zillow property-page URL."},400);
  let amount:number;
  try { amount=await fetchZillowZestimate(zillowUrl); }
  catch(error) { return context.json({error:error instanceof Error?error.message:"Unable to retrieve Zillow estimate."},422); }
  const createdAt=Date.now();
  const estimateId=crypto.randomUUID();
  sqliteClient.prepare("INSERT INTO real_estate_estimate(id,connection_id,user_id,provider,amount,created_at) VALUES(?,?,?,'zillow',?,?)").run(estimateId,propertyId,owner,amount,createdAt);
  sqliteClient.prepare("UPDATE real_estate_connection SET zillow_url=? WHERE id=? AND user_id=?").run(zillowUrl,propertyId,owner);
  return context.json({id:estimateId,provider:"zillow",amount,createdAt},201);
});

realEstateRouter.post("/:id/estimates", async (context) => {
  const owner=await userId(context.req.raw);
  if (!owner) return context.json({error:"Authentication required."},401);
  const id=context.req.param("id");
  const body: unknown=await context.req.json().catch(()=>null);
  const amount=body && typeof body==="object" ? (body as Record<string,unknown>).amount : null;
  const sourceNotes=body&&typeof body==="object"?(body as Record<string,unknown>).sourceNotes:undefined;
  if (typeof amount!=="number" || !Number.isFinite(amount) || amount<0 || (sourceNotes!==undefined&&(typeof sourceNotes!=="string"||sourceNotes.length>2000))) return context.json({error:"Provide a non-negative manual estimate."},400);
  const exists=sqliteClient.prepare("SELECT 1 FROM real_estate_connection WHERE id=? AND user_id=?").get(id,owner);
  if (!exists) return context.json({error:"Property not found."},404);
  const result=sqliteClient.prepare("INSERT INTO real_estate_estimate(id,connection_id,user_id,provider,amount,created_at,source_notes) VALUES(?,?,?,'manual',?,?,?)").run(crypto.randomUUID(),id,owner,amount,Date.now(),typeof sourceNotes==="string"?sourceNotes.trim()||null:null);
  return context.json({id:result.lastInsertRowid},201);
});
