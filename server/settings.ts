import { Hono } from "hono";
import { auth } from "./auth.js";
import { getPublicTellerSettings, saveTellerSettings, TellerSettingsValidationError } from "./teller-settings.js";

export const settingsRouter = new Hono();
const maximumBodyBytes = 128 * 1024;

function isTrustedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    // An Origin is not a URL with credentials, path, query or fragment.
    if (new URL(origin).origin !== origin) return false;
    return [process.env["ORIGIN_URL"] ? new URL(process.env["ORIGIN_URL"]!).origin : "", "http://localhost:5173", "http://127.0.0.1:5173"].includes(origin);
  } catch { return false; }
}

class RequestBodyTooLargeError extends Error {}

async function readBoundedJson(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumBodyBytes)) {
    await request.body?.cancel();
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) throw new SyntaxError("Missing request body.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBodyBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks)));
}

settingsRouter.use("*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  await next();
});

// Keep all error responses generic and do not log credential-bearing exceptions.
settingsRouter.onError((_error, context) => context.json({error: "Unable to access Teller settings."}, 500));

settingsRouter.get("/teller", async context => {
  const session = await auth.api.getSession({headers: context.req.raw.headers});
  if (!session?.user.id) return context.json({error: "Authentication required."}, 401);
  return context.json(getPublicTellerSettings(session.user.id));
});

settingsRouter.put("/teller", async context => {
  const session = await auth.api.getSession({headers: context.req.raw.headers});
  if (!session?.user.id) return context.json({error: "Authentication required."}, 401);
  if (!isTrustedOrigin(context.req.header("Origin"))) return context.json({error: "Untrusted request origin."}, 403);
  let input: unknown;
  try { input = await readBoundedJson(context.req.raw); }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError) return context.json({error: "Request body exceeds 128 KiB."}, 413);
    return context.json({error: "Invalid JSON request body."}, 400);
  }
  try { saveTellerSettings(session.user.id, input); }
  catch (error) {
    if (error instanceof TellerSettingsValidationError) return context.json({error: error.message}, 400);
    throw error;
  }
  return context.json(getPublicTellerSettings(session.user.id));
});
