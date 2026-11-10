import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export class UnsupportedBankDataFormatError extends Error {
  constructor() {
    super("Stored bank data has an unsupported encryption format.");
    this.name = "UnsupportedBankDataFormatError";
  }
}

export function getBankEncryptionKey(): Buffer {
  const secret = process.env["BETTER_AUTH_SECRET"];
  if (!secret || secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be set to at least 32 characters.");
  return Buffer.from(hkdfSync("sha256", secret, "finance-bank-storage-v1", "finance/bank/encryption/v1", 32));
}

export function encryptBankValue(value: string, key: Buffer = getBankEncryptionKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptBankValue(value: string, key: Buffer = getBankEncryptionKey()): string {
  const parts = value.split(".");
  const validBase64 = (part: string): boolean => Buffer.from(part, "base64").toString("base64") === part;
  if (parts.length !== 4 || parts[0] !== "v1" || !parts.slice(1).every(validBase64)) throw new UnsupportedBankDataFormatError();
  const iv = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new UnsupportedBankDataFormatError();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64")), decipher.final()]).toString("utf8");
}
