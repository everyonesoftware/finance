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

export class UnsupportedPlaidDataFormatError extends Error {
  constructor() {
    super("Stored Plaid data has an unsupported encryption format.");
    this.name = "UnsupportedPlaidDataFormatError";
  }
}

export interface PlaidTransactionCursorRead {
  cursor: string | undefined;
  recovered: boolean;
}

export interface PlaidErrorLogContext {
  phase?: string;
  itemNumber?: number;
  itemCount?: number;
}

export interface PlaidErrorLogDetails {
  operation: string;
  errorName: string;
  errorSummary: string;
  phase?: string;
  itemNumber?: number;
  itemCount?: number;
  plaidErrorType?: string;
  plaidErrorCode?: string;
  requestId?: string;
  httpStatus?: number;
  networkCode?: string;
  internalCode?: string;
  stackFrames?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value)
    ? value
    : undefined;
}

function safeErrorSummary(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown non-Error exception; message withheld for safety.";
  if (error.message === "Plaid transaction references an account outside this item.") {
    return "Transaction account ownership validation failed.";
  }
  if (/^Transaction sync exceeded the \d+ page limit\.$/.test(error.message)) {
    return "Transaction pagination exceeded the configured safety limit.";
  }
  if (error.message === "Transaction sync exceeded the restart limit.") {
    return "Transaction pagination exceeded the retry limit.";
  }
  if (error.message === "Stored Plaid data has an unsupported encryption format.") {
    return "Stored Plaid data format is unsupported.";
  }
  if (error instanceof SyntaxError) return "Stored JSON data could not be parsed.";
  return "Unclassified error; message withheld for safety.";
}

function safeStackFrames(error: unknown): string[] | undefined {
  if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
  const frames = error.stack
    .split(String.fromCharCode(10))
    .map((frame) => frame.replaceAll(String.fromCharCode(13), ""))
    .slice(1, 9)
    .flatMap((frame) => {
      const match = frame.match(/^\s*at\s+(?:(.*?)\s+\()?(.+):(\d+):(\d+)\)?\s*$/);
      if (!match) return [];
      const filename = match[2]?.replace(/\\/g, "/").split("/").at(-1);
      const line = match[3];
      const column = match[4];
      if (!filename || !/^[A-Za-z0-9_.-]{1,100}$/.test(filename) || !line || !column) return [];
      const functionName = (match[1] ?? "").replace(/[^A-Za-z0-9_.$<>-]/g, "").slice(0, 80);
      return [`${functionName ? `${functionName} @ ` : ""}${filename}:${line}:${column}`];
    })
    .slice(0, 6);
  return frames.length > 0 ? frames : undefined;
}

export function getPlaidErrorLogDetails(
  operation: string,
  error: unknown,
  context?: PlaidErrorLogContext,
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
    errorSummary: safeErrorSummary(error),
  };
  const stackFrames = safeStackFrames(error);
  if (stackFrames) details.stackFrames = stackFrames;
  if (context?.phase && /^[A-Za-z][A-Za-z0-9 /_-]{0,79}$/.test(context.phase)) {
    details.phase = context.phase;
  }
  if (context && Number.isSafeInteger(context.itemNumber) && (context.itemNumber ?? 0) > 0) {
    details.itemNumber = context.itemNumber;
  }
  if (context && Number.isSafeInteger(context.itemCount) && (context.itemCount ?? -1) >= 0) {
    details.itemCount = context.itemCount;
  }
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
    if (/^SQLITE_[A-Za-z0-9_]+$/.test(networkCode)) details.internalCode = networkCode;
    else details.networkCode = networkCode;
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
    throw new UnsupportedPlaidDataFormatError();
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

export function readPlaidTransactionCursor(
  value: string | null,
  key: Buffer,
): PlaidTransactionCursorRead {
  if (value === null) return { cursor: undefined, recovered: false };

  try {
    return { cursor: decryptPlaidValue(value, key), recovered: false };
  } catch (error) {
    if (error instanceof UnsupportedPlaidDataFormatError) {
      return { cursor: undefined, recovered: true };
    }
    throw error;
  }
}
