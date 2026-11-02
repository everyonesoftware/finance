import { Hono } from "hono";
import { auth } from "./auth.js";
import { sqliteClient } from "./database.js";

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
      e.id AS estimateId, e.amount, e.created_at AS estimateAt
    FROM real_estate_connection c
    LEFT JOIN real_estate_estimate e ON e.connection_id=c.id AND e.user_id=c.user_id
    WHERE c.user_id=? ORDER BY c.created_at DESC, e.created_at DESC
  `).all(owner) as Array<{id:string;address:string;latitude:number;longitude:number;createdAt:number;estimateId:string|null;amount:number|null;estimateAt:number|null}>;
  const grouped = new Map<string, {id:string;address:string;latitude:number;longitude:number;createdAt:number;estimates:Array<{id:string;provider:"manual";amount:number;createdAt:number}>}>();
  for (const row of properties) {
    let property = grouped.get(row.id);
    if (!property) { property={id:row.id,address:row.address,latitude:row.latitude,longitude:row.longitude,createdAt:row.createdAt,estimates:[]}; grouped.set(row.id,property); }
    if (row.estimateId && row.amount !== null && row.estimateAt !== null) property.estimates.push({id:row.estimateId,provider:"manual",amount:row.amount,createdAt:row.estimateAt});
  }
  return context.json({ properties:[...grouped.values()] });
});

realEstateRouter.post("/", async (context) => {
  const owner = await userId(context.req.raw);
  if (!owner) return context.json({ error: "Authentication required." }, 401);
  const body: unknown = await context.req.json().catch(() => null);
  if (!body || typeof body !== "object") return context.json({error:"Invalid property."},400);
  const value=body as Record<string,unknown>;
  const {address,latitude,longitude,amount}=value;
  if (typeof address!=="string" || !address.trim() || address.length>500 || typeof latitude!=="number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || typeof longitude!=="number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || typeof amount!=="number" || !Number.isFinite(amount) || amount<0) return context.json({error:"Provide an address, map location, and non-negative manual estimate."},400);
  const id=crypto.randomUUID();
  const save=sqliteClient.transaction(() => {
    sqliteClient.prepare("INSERT INTO real_estate_connection(id,user_id,address,latitude,longitude) VALUES(?,?,?,?,?)").run(id,owner,address.trim(),latitude,longitude);
    sqliteClient.prepare("INSERT INTO real_estate_estimate(id,connection_id,user_id,provider,amount,created_at) VALUES(?,?,?,'manual',?,?)").run(crypto.randomUUID(),id,owner,amount,Date.now());
  });
  save();
  return context.json({id},201);
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
