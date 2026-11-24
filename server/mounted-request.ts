// Pass explicit fields rather than using Hono's lazy HTTP Request as RequestInit.
export function mountedRequest(url: URL, source: Request): Request {
  const { method, headers, signal, body } = source;
  const init: RequestInit & { duplex?: "half" } = { method, headers, signal };
  if (body !== null) {
    init.body = body;
    init.duplex = "half";
  }
  return new Request(url, init);
}
