const MAX_ZILLOW_PAGE_BYTES = 8 * 1024 * 1024;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function readAttribute(tag: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

export function parseZillowZestimate(html: string): number | null {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const key = (readAttribute(tag, "property") ?? readAttribute(tag, "name") ?? "").toLowerCase();
    if (key !== "og:description" && key !== "description") continue;
    const content = readAttribute(tag, "content");
    if (!content) continue;
    const match = content.match(/\bThe\s+Zestimate\b[^$]{0,160}\$\s*([\d,]+)(?:\.\d{2})?/i);
    if (!match) continue;
    const amount = Number(match[1].replaceAll(",", ""));
    if (Number.isSafeInteger(amount) && amount >= 0) return amount;
  }
  return null;
}

export async function fetchZillowZestimate(
  pageUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    throw new Error("Enter a valid Zillow property-page URL.");
  }
  if (
    url.protocol !== "https:" ||
    !["www.zillow.com", "zillow.com"].includes(url.hostname.toLowerCase()) ||
    !url.pathname.startsWith("/homedetails/") ||
    url.username ||
    url.password
  ) {
    throw new Error("Only HTTPS Zillow home-details pages are supported.");
  }

  const response = await fetcher(url.toString(), {
    headers: { Accept: "text/html" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Zillow returned HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new Error("Zillow did not return a property page.");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_ZILLOW_PAGE_BYTES) {
    throw new Error("Zillow property page is larger than the supported limit.");
  }
  const html = await response.text();
  if (new TextEncoder().encode(html).byteLength > MAX_ZILLOW_PAGE_BYTES) {
    throw new Error("Zillow property page is larger than the supported limit.");
  }
  const amount = parseZillowZestimate(html);
  if (amount === null) {
    throw new Error("No Zestimate was found on the Zillow property page.");
  }
  return amount;
}
