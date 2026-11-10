import { createHash, createPublicKey, verify } from "node:crypto";
import { request } from "node:https";

export interface TellerSettings {
  applicationId: string;
  environment: "sandbox" | "development" | "production";
  certificate: string | null;
  privateKey: string | null;
  signingKey: string | null;
}
export type TellerTransport = (settings: TellerSettings, token: string, method: "GET" | "DELETE", path: string) => Promise<unknown>;
export class TellerConfigurationError extends Error {}
export class TellerDataError extends Error {}

export function validateTellerSettings(settings: TellerSettings): void {
  if (!settings.applicationId || !["sandbox", "development", "production"].includes(settings.environment)) throw new TellerConfigurationError("Teller settings are incomplete.");
  if (settings.environment !== "sandbox" && (!settings.certificate || !settings.privateKey || !settings.signingKey)) throw new TellerConfigurationError("Teller live credentials are incomplete.");
}

// Fixed origin, no provider-supplied links, no redirects, verified TLS, bounded body and wall-clock timeout.
export function createTellerTransport(httpRequest: typeof request = request): TellerTransport {
 return async (settings, token, method, path) => {
  validateTellerSettings(settings);
  if (!/^\/accounts(?:\/[A-Za-z0-9_-]+(?:\/(?:balances|transactions))?)?(?:\?count=500(?:&from_id=[A-Za-z0-9_-]+)?)?$/.test(path) || !/^[A-Za-z0-9_-]{1,1024}$/.test(token)) throw new TellerDataError("Invalid Teller request.");
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "api.teller.io", port: 443, path, method, rejectUnauthorized: true, minVersion: "TLSv1.2", agent: false,
      ...(settings.certificate && settings.privateKey ? { cert: settings.certificate, key: settings.privateKey } : {}),
      headers: { Authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}`, Accept: "application/json", "Teller-Version": "2020-10-12" },
    }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { response.destroy(); req.destroy(new Error("Teller response limit exceeded.")); return; }
        chunks.push(chunk);
      });
      response.on("error", () => reject(new Error("Teller response failed.")));
      response.on("aborted", () => reject(new Error("Teller response interrupted.")));
      response.on("end", () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) { reject(new Error("Teller request failed.")); return; }
        try { resolve(response.statusCode === 204 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new TellerDataError("Invalid Teller response.")); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Teller request timed out.")), 15000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => reject(new Error("Teller transport failed.")));
    req.end();
  });
 };
}
export const tellerRequest: TellerTransport = createTellerTransport();

export interface TellerEnrollment {
  accessToken: string;
  user: { id: string };
  enrollment: { id: string; institution: { name: string } };
  signatures: string[];
  nonce: string;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TellerDataError("Invalid Teller object.");
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new TellerDataError("Invalid Teller identifier.");
  return value;
}
export function parseEnrollment(value: unknown): TellerEnrollment {
  const body = record(value), user = record(body.user), enrollment = record(body.enrollment), institution = record(enrollment.institution);
  if (typeof body.accessToken !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(body.accessToken) || typeof body.nonce !== "string" || !/^[a-f0-9]{64}$/.test(body.nonce) || typeof institution.name !== "string" || institution.name.length < 1 || institution.name.length > 512 || !Array.isArray(body.signatures) || body.signatures.length > 10 || !body.signatures.every(s => typeof s === "string" && s.length <= 256)) throw new TellerDataError("Invalid Teller enrollment.");
  return { accessToken: body.accessToken, nonce: body.nonce, user: { id: identifier(user.id) }, enrollment: { id: identifier(enrollment.id), institution: { name: institution.name } }, signatures: body.signatures as string[] };
}
export function verifyEnrollmentSignature(enrollment: TellerEnrollment, settings: TellerSettings): boolean {
  if (!settings.signingKey) return settings.environment === "sandbox";
  try {
    const rawKey = settings.signingKey;
    const key = rawKey.includes("BEGIN PUBLIC KEY") ? createPublicKey(rawKey) : createPublicKey({key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(rawKey, /^[a-fA-F0-9]{64}$/.test(rawKey) ? "hex" : "base64")]),format:"der",type:"spki"});
    if (key.asymmetricKeyType !== "ed25519") return false;
    const message = [enrollment.nonce,enrollment.accessToken,enrollment.user.id,enrollment.enrollment.id,settings.environment].join(".");
    const digest = createHash("sha256").update(message).digest();
    return enrollment.signatures.some(signature => /^[A-Za-z0-9+/]+={0,2}$/.test(signature) && Buffer.from(signature,"base64").length === 64 && verify(null,digest,key,Buffer.from(signature,"base64")));
  } catch { return false; }
}
export function money(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new TellerDataError("Invalid Teller amount.");
  return Number(value);
}
export interface TellerAccount {
  id: string; enrollmentId: string; institutionId: string; institutionName: string; snapshot: Record<string, unknown>; closed: boolean;
}
export async function fetchTellerAccounts(settings: TellerSettings, token: string, enrollmentId: string, transport: TellerTransport): Promise<TellerAccount[]> {
  const response = await transport(settings,token,"GET","/accounts");
  if (!Array.isArray(response) || response.length > 1000) throw new TellerDataError("Invalid Teller accounts.");
  const ids = new Set<string>(); const accounts: TellerAccount[] = [];
  for (const value of response) {
    const account=record(value), id=identifier(account.id), institution=record(account.institution);
    if (account.enrollment_id !== enrollmentId || ids.has(id) || typeof account.name !== "string" || !["open","closed"].includes(String(account.status)) || !["depository","credit"].includes(String(account.type)) || typeof account.currency !== "string" || typeof institution.name !== "string") throw new TellerDataError("Teller account ownership validation failed.");
    ids.add(id);
    let currentBalance: number | null = null, availableBalance: number | null = null;
    if (account.status === "open") {
      const balances = record(await transport(settings,token,"GET",`/accounts/${id}/balances`));
      if (balances.account_id !== id) throw new TellerDataError("Teller balance ownership validation failed.");
      currentBalance=money(balances.ledger); availableBalance=money(balances.available);
      if (currentBalance === null && availableBalance === null) throw new TellerDataError("Missing Teller balances.");
    }
    accounts.push({id,enrollmentId,institutionId:identifier(institution.id),institutionName:institution.name,closed:account.status === "closed",snapshot:{name:account.name,officialName:null,type:account.type,subtype:typeof account.subtype === "string" ? account.subtype : null,mask:typeof account.last_four === "string" ? account.last_four : null,currentBalance,availableBalance,currencyCode:account.currency}});
  }
  return accounts;
}
export async function fetchTellerTransactions(settings: TellerSettings, token: string, account: TellerAccount, transport: TellerTransport): Promise<Array<Record<string, unknown>>> {
  const result: Array<Record<string, unknown>>=[]; const seen=new Set<string>(); let from: string | undefined;
  for (let page=0;page<100;page++) {
    const response=await transport(settings,token,"GET",`/accounts/${account.id}/transactions?count=500${from ? `&from_id=${from}` : ""}`);
    if (!Array.isArray(response) || response.length>500) throw new TellerDataError("Invalid Teller transaction page.");
    for(const value of response) {
      const tx=record(value), id=identifier(tx.id), amount=money(tx.amount);
      if(tx.account_id!==account.id || seen.has(id) || amount===null || typeof tx.date!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(tx.date) || typeof tx.description!=="string" || !["pending","posted"].includes(String(tx.status))) throw new TellerDataError("Invalid Teller transaction ownership or pagination.");
      seen.add(id); result.push({transaction_id:id,account_id:account.id,name:tx.description,date:tx.date,amount,iso_currency_code:account.snapshot.currencyCode,pending:tx.status==="pending"});
    }
    if(response.length<500) return result;
    from=identifier(record(response[response.length-1]).id);
  }
  throw new TellerDataError("Teller transaction page limit exceeded.");
}
