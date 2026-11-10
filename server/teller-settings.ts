import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import { sqliteClient } from "./database.js";
import { decryptBankValue, encryptBankValue } from "./bank-crypto.js";

export interface TellerSettings {
  applicationId: string;
  environment: "sandbox" | "development" | "production";
  certificate: string | null;
  privateKey: string | null;
  signingKey: string | null;
}

export function getTellerSettings(userId: string): TellerSettings | null {
  const row = sqliteClient.prepare("SELECT encrypted_data FROM teller_settings WHERE user_id = ?").get(userId) as { encrypted_data: string } | undefined;
  return row ? JSON.parse(decryptBankValue(row.encrypted_data)) as TellerSettings : null;
}

export function getPublicTellerSettings(userId: string) {
  const value = getTellerSettings(userId);
  return {
    applicationId: value?.applicationId ?? "",
    environment: value?.environment ?? "sandbox",
    hasCertificate: Boolean(value?.certificate),
    hasPrivateKey: Boolean(value?.privateKey),
    signingKey: value?.signingKey ?? "",
    configured: Boolean(value?.applicationId && (value.environment === "sandbox" || (value.certificate && value.privateKey && value.signingKey))),
  };
}

export class TellerSettingsValidationError extends Error {
  constructor() {
    super("Invalid Teller settings. Check the application ID, environment, matching PEM credentials and Ed25519 public signing key.");
    this.name = "TellerSettingsValidationError";
  }
}

function validateSigningKey(value: string): void {
  let key;
  if (value.startsWith("-----BEGIN PUBLIC KEY-----")) {
    key = createPublicKey(value);
  } else {
    const bytes = /^[a-fA-F0-9]{64}$/.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
    if (bytes.length !== 32 || (!/^[a-fA-F0-9]{64}$/.test(value) && bytes.toString("base64") !== value)) throw new TellerSettingsValidationError();
    key = createPublicKey({key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]), format: "der", type: "spki"});
  }
  if (key.asymmetricKeyType !== "ed25519") throw new TellerSettingsValidationError();
}

export function saveTellerSettings(userId: string, input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TellerSettingsValidationError();
  const data = input as Record<string, unknown>;
  const fields = ["applicationId", "environment", "certificate", "privateKey", "signingKey", "clearCredentials"];
  if (!Object.keys(data).length || Object.keys(data).some(field => !fields.includes(field))) throw new TellerSettingsValidationError();
  for (const field of fields.filter(field => field !== "clearCredentials")) {
    if (data[field] !== undefined && typeof data[field] !== "string") throw new TellerSettingsValidationError();
  }
  if (data.clearCredentials !== undefined && typeof data.clearCredentials !== "boolean") throw new TellerSettingsValidationError();
  const existing = getTellerSettings(userId);
  const text = (field: string): string | undefined => typeof data[field] === "string" ? (data[field] as string).trim() : undefined;
  const environment = text("environment") ?? existing?.environment ?? "sandbox";
  if (environment !== "sandbox" && environment !== "development" && environment !== "production") throw new TellerSettingsValidationError();
  const value: TellerSettings = {
    applicationId: text("applicationId") ?? existing?.applicationId ?? "",
    environment,
    certificate: data.clearCredentials === true ? null : text("certificate") || existing?.certificate || null,
    privateKey: data.clearCredentials === true ? null : text("privateKey") || existing?.privateKey || null,
    signingKey: text("signingKey") ?? existing?.signingKey ?? null,
  };
  try {
    if (!value.applicationId || value.applicationId.length > 200 || /[\s\x00-\x1f\x7f]/.test(value.applicationId)) throw new TellerSettingsValidationError();
    if ((value.certificate?.length ?? 0) > 100_000 || (value.privateKey?.length ?? 0) > 100_000 || (value.signingKey?.length ?? 0) > 10_000) throw new TellerSettingsValidationError();
    if (value.signingKey) validateSigningKey(value.signingKey);
    if (value.certificate || value.privateKey) {
      if (!value.certificate || !value.privateKey || !value.certificate.startsWith("-----BEGIN CERTIFICATE-----") || !/^-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(value.privateKey)) throw new TellerSettingsValidationError();
      const certificate = new X509Certificate(value.certificate);
      if (!certificate.checkPrivateKey(createPrivateKey(value.privateKey))) throw new TellerSettingsValidationError();
      createSecureContext({cert: value.certificate, key: value.privateKey});
    }
    // Explicit clearing is allowed even for live environments, leaving them unconfigured.
    if (environment !== "sandbox" && data.clearCredentials !== true && (!value.certificate || !value.privateKey || !value.signingKey)) throw new TellerSettingsValidationError();
  } catch {
    // OpenSSL errors may contain user-supplied material; never propagate them.
    throw new TellerSettingsValidationError();
  }
  sqliteClient.prepare(`INSERT INTO teller_settings(user_id, encrypted_data) VALUES(?, ?)
    ON CONFLICT(user_id) DO UPDATE SET encrypted_data=excluded.encrypted_data, updated_at=unixepoch()`)
    .run(userId, encryptBankValue(JSON.stringify(value)));
}
