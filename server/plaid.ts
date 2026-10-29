import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} from "plaid";

export interface PlaidConnection {
  client: PlaidApi;
  encryptionKey: Buffer;
}

export class PlaidConfigurationError extends Error {}

export interface PlaidErrorLogDetails {
  operation: string;
  errorName: string;
  plaidErrorType?: string;
  plaidErrorCode?: string;
  requestId?: string;
  httpStatus?: number;
  networkCode?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value)
    ? value
    : undefined;
}

export function getPlaidErrorLogDetails(
  operation: string,
  error: unknown,
): PlaidErrorLogDetails {
  const errorRecord: Record<string, unknown> = isRecord(error) ? error : {};
  const response: Record<string, unknown> = isRecord(errorRecord["response"])
    ? errorRecord["response"]
    : {};
  const plaidError: Record<string, unknown> = isRecord(response["data"])
    ? response["data"]
    : {};
  const details: PlaidErrorLogDetails = {
    operation,
    errorName:
      error instanceof Error
        ? error.name.slice(0, 80)
        : "UnknownError",
  };
  const plaidErrorType: string | undefined = safeCode(
    plaidError["error_type"],
  );
  const plaidErrorCode: string | undefined = safeCode(
    plaidError["error_code"],
  );
  const requestId: string | undefined = safeCode(plaidError["request_id"]);
  const networkCode: string | undefined = safeCode(errorRecord["code"]);
  const httpStatus: unknown = response["status"];

  if (plaidErrorType) {
    details.plaidErrorType = plaidErrorType;
  }
  if (plaidErrorCode) {
    details.plaidErrorCode = plaidErrorCode;
  }
  if (requestId) {
    details.requestId = requestId;
  }
  if (typeof httpStatus === "number" && Number.isInteger(httpStatus)) {
    details.httpStatus = httpStatus;
  }
  if (networkCode) {
    details.networkCode = networkCode;
  }

  return details;
}

export function getPlaidConnection(): PlaidConnection | null {
  const clientId: string | undefined = process.env["PLAID_CLIENT_ID"];
  const secret: string | undefined = process.env["PLAID_SECRET"];
  const encryptionKeyValue: string | undefined =
    process.env["PLAID_TOKEN_ENCRYPTION_KEY"];
  const configuredValues: Array<string | undefined> = [
    clientId,
    secret,
    encryptionKeyValue,
  ];

  if (configuredValues.every((value): boolean => !value)) {
    return null;
  }

  if (!clientId || !secret || !encryptionKeyValue) {
    throw new PlaidConfigurationError(
      "PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_TOKEN_ENCRYPTION_KEY must all be set.",
    );
  }

  const environment: string = process.env["PLAID_ENV"] ?? "sandbox";
  const basePath: string | undefined =
    environment === "sandbox"
      ? PlaidEnvironments.sandbox
      : environment === "production"
        ? PlaidEnvironments.production
        : undefined;

  if (!basePath) {
    throw new PlaidConfigurationError(
      "PLAID_ENV must be either sandbox or production.",
    );
  }

  const encryptionKey: Buffer = Buffer.from(encryptionKeyValue, "base64");
  if (
    encryptionKey.length !== 32 ||
    encryptionKey.toString("base64") !== encryptionKeyValue
  ) {
    throw new PlaidConfigurationError(
      "PLAID_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
    );
  }

  const client: PlaidApi = new PlaidApi(
    new Configuration({
      basePath,
      baseOptions: {
        timeout: 15_000,
        headers: {
          "PLAID-CLIENT-ID": clientId,
          "PLAID-SECRET": secret,
        },
      },
    }),
  );

  return { client, encryptionKey };
}

export function encryptPlaidValue(value: string, key: Buffer): string {
  const iv: Buffer = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted: Buffer = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const authTag: Buffer = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

export function decryptPlaidValue(value: string, key: Buffer): string {
  const [version, ivValue, authTagValue, encryptedValue] = value.split(".");
  if (
    version !== "v1" ||
    !ivValue ||
    !authTagValue ||
    !encryptedValue
  ) {
    throw new Error("Stored Plaid data has an unsupported encryption format.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivValue, "base64"),
  );
  decipher.setAuthTag(Buffer.from(authTagValue, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
