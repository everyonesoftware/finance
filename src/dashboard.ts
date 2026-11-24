import { renderAppNavigation } from "./navigation.ts";
import { escapeHtml } from "./html-utils.ts";

export interface DashboardUser {
  displayName: string;
}

export interface NetWorthPoint { date: string; total: number; source?: "observed" | "reconstructed" }

const dayMs = 86_400_000;
const usd = (value: number): string => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD",
}).format(value);

function historyWindow(now: Date): { start: number; end: number } {
  const end = Date.parse(now.toISOString().slice(0, 10));
  return { start: end - 364 * dayMs, end };
}

function validPoints(points: NetWorthPoint[], now: Date): NetWorthPoint[] {
  const { start, end } = historyWindow(now);
  const days = new Map<string, NetWorthPoint>();
  for (const point of points) {
    if (!point || typeof point.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(point.date) || !Number.isFinite(point.total)) continue;
    const date = Date.parse(point.date);
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== point.date || date < start || date > end) continue;
    days.set(point.date, point);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function formatNetWorthChange(points: NetWorthPoint[]): string {
  if (points.length < 2) return "";
  const first = points[0].total;
  const change = Math.round(points[points.length - 1].total * 100) - Math.round(first * 100);
  const sign = change > 0 ? "+" : change < 0 ? "−" : "";
  const percentage = first > 0 ? ` (${sign}${(Math.abs(change) / (first * 100) * 100).toFixed(1)}%)` : "";
  return `${sign}${usd(Math.abs(change) / 100)}${percentage} since first history point`;
}

export function renderNetWorthHistory(records: NetWorthPoint[], now = new Date()): string {
  const points = validPoints(records, now);
  const reconstructedCount = points.filter(point => point.source === "reconstructed").length;
  const observationCount = points.length - reconstructedCount;
  const counts = `${observationCount} saved observation${observationCount === 1 ? "" : "s"}${reconstructedCount ? `; ${reconstructedCount} reconstructed estimated day${reconstructedCount === 1 ? "" : "s"}` : ""}.`;
  const reconstructionNote = "Reconstructed points assume complete posted imports and are not verified.";
  if (points.length < 2) return `<div class="overview-history-state"><h3>Not enough history yet</h3><p>History needs a dated verified balance plus complete posted imports for each supported cash, credit or loan account, or observations saved by opening Overview on two different days. Historical investment valuations are required for investment accounts.</p>${reconstructedCount ? `<p>${counts} ${reconstructionNote}</p>` : ""}</div>`;
  const { start, end } = historyWindow(now);
  const values = points.map(point => point.total);
  const low = Math.min(...values), high = Math.max(...values);
  const padding = Math.max((high - low) * 0.15, Math.abs(high) * 0.02, 1);
  const min = low - padding, max = high + padding;
  const y = (value: number): number => 150 - (value - min) / (max - min) * 140;
  const coordinates = points.map(point => `${((Date.parse(point.date) - start) / (end - start) * 700).toFixed(2).replace(/\.00$/, "")},${y(point.total).toFixed(2)}`).join(" ");
  const compact = (value: number): string => new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
  }).format(value);
  const ticks = [max, (min + max) / 2, min];
  const labels = Array.from({ length: 5 }, (_, i) => {
    const date = new Date(start + (end - start) * i / 4);
    return `<span>${new Intl.DateTimeFormat("en-GB", { month: "short", ...(i === 0 || i === 4 ? { year: "2-digit" as const } : {}), timeZone: "UTC" }).format(date)}</span>`;
  }).join("");
  const first = points[0], last = points[points.length - 1];
  const endpoint = (point: NetWorthPoint): string => `${point.date}, ${usd(point.total)}${point.source === "reconstructed" ? " (reconstructed estimate)" : " (observed)"}`;
  return `<p class="overview-chart-label">${reconstructedCount ? observationCount ? "Observed and reconstructed history" : "Reconstructed history (estimated)" : "Saved balance history"}</p><div class="overview-chart-plot${reconstructedCount ? " overview-chart-reconstructed" : ""}">
    <svg class="overview-chart" viewBox="0 0 700 160" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(`Net worth history from ${endpoint(first)}, to ${endpoint(last)}. ${counts} Lines across gaps connect history points.`)}" data-observation-count="${observationCount}" data-reconstructed-count="${reconstructedCount}">
      ${ticks.map(value => `<line x1="0" y1="${y(value)}" x2="700" y2="${y(value)}" class="overview-chart-grid"/>`).join("")}
      <polyline points="${coordinates}" class="overview-chart-line"/>
    </svg><div class="overview-chart-values" aria-hidden="true">${ticks.map(value => `<span>${compact(value)}</span>`).join("")}</div>
  </div><div class="overview-chart-dates" aria-hidden="true">${labels}</div><p class="overview-history-note">${reconstructedCount ? reconstructionNote : "Recorded when Overview opens; gaps connect saved observations."}</p>`;
}

interface NetWorthSummary {
  currencyCode: "USD";
  total: number | null;
  accountCount: number;
  includedAccountCount: number;
  excludedAccountCount: number;
  unknownBalanceCount: number;
  points: NetWorthPoint[];
  history?: { reconstructedPointCount: number; eligibleAccountCount: number; unsupportedAccountCount: number };
}

function isNetWorthSummary(value: unknown): value is NetWorthSummary {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  const validCount = (count: unknown): boolean => typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  if (body.history !== undefined) {
    if (!body.history || typeof body.history !== "object") return false;
    const history = body.history as Record<string, unknown>;
    if (![history.reconstructedPointCount, history.eligibleAccountCount, history.unsupportedAccountCount].every(validCount)) return false;
  }
  return body.currencyCode === "USD" && (body.total === null || typeof body.total === "number" && Number.isFinite(body.total)) &&
    [body.accountCount, body.includedAccountCount, body.excludedAccountCount, body.unknownBalanceCount].every(validCount) &&
    Array.isArray(body.points) && body.points.length <= 365 && body.points.every(point => point && typeof point.date === "string" && typeof point.total === "number" && Number.isFinite(point.total) && (point.source === undefined || point.source === "observed" || point.source === "reconstructed"));
}

export async function initializeOverviewNetWorth(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const root = document.querySelector<HTMLElement>("#overview-net-worth");
  if (!root) return;
  const total = root.querySelector<HTMLElement>("#overview-total-balance");
  const history = root.querySelector<HTMLElement>("#overview-net-worth-chart");
  const coverage = root.querySelector<HTMLElement>("#overview-net-worth-coverage");
  const change = root.querySelector<HTMLElement>("#overview-net-worth-change");
  const active = (): boolean => !signal?.aborted && root.isConnected !== false;
  try {
    const response = await fetch("/api/accounts/net-worth", { cache: "no-store", credentials: "same-origin", signal });
    if (!response.ok) throw new Error("Net-worth request failed.");
    const body: unknown = await response.json();
    if (!active()) return;
    if (!isNetWorthSummary(body)) throw new Error("Invalid net-worth response.");
    if (total) total.textContent = body.total === null ? body.accountCount === 0 ? "No accounts yet" : "Balance unavailable" : usd(body.total);
    const notices: string[] = [];
    if (body.excludedAccountCount) notices.push(`${body.excludedAccountCount} non-USD or unknown-currency account${body.excludedAccountCount === 1 ? "" : "s"} excluded.`);
    if (body.unknownBalanceCount) notices.push(`${body.unknownBalanceCount} USD account balance${body.unknownBalanceCount === 1 ? " is" : "s are"} missing; no observation saved.`);
    if (body.history?.unsupportedAccountCount) notices.push(`${body.history.unsupportedAccountCount} included USD account${body.history.unsupportedAccountCount === 1 ? " cannot" : "s cannot"} be reconstructed: cash, credit and loan accounts need a dated verified balance and complete posted imports; investment accounts need historical investment valuations. Aggregate reconstruction requires history for all included USD accounts; saved observations remain available.`);
    if (coverage) coverage.textContent = notices.join(" ");
    const points = validPoints(body.points, new Date());
    if (change) change.textContent = formatNetWorthChange(points);
    if (history) history.innerHTML = body.accountCount === 0
      ? `<div class="overview-history-state"><h3>Your history starts here</h3><p>Add an account and its current balance to start tracking your net worth.</p><a class="text-button" href="/accounts">Add an account →</a></div>`
      : renderNetWorthHistory(points);
  } catch {
    if (!active()) return;
    if (total) total.textContent = "Unavailable";
    if (change) change.textContent = "";
    if (coverage) coverage.textContent = "";
    if (history) {
      history.innerHTML = `<div class="overview-history-state"><h3>History unavailable</h3><p>Couldn't load net worth. Your saved accounts and transactions are unchanged.</p><button type="button" class="text-button" id="retry-overview-net-worth">Try again</button></div>`;
      history.querySelector<HTMLButtonElement>("#retry-overview-net-worth")?.addEventListener("click", event => {
        if (!active()) return;
        (event.currentTarget as HTMLButtonElement).disabled = true;
        void initializeOverviewNetWorth(signal);
      }, { once: true });
    }
  }
}

export function renderDashboard(user: DashboardUser): string {
  return `
  <div class="app-shell">
    ${renderAppNavigation(user, "overview")}

    <main class="main-content overview-content" id="overview">

      <p id="settings-message" class="auth-message" role="status" hidden></p>


      <header class="overview-heading">
        <h1>Overview</h1>
      </header>

      <section class="overview-hero" id="overview-net-worth" aria-label="Financial summary">
        <div class="overview-balance-copy">
          <h2>Net worth</h2>
          <div class="overview-total" id="overview-total-balance" aria-live="polite">Loading…</div>
          <p class="overview-scope">Tracked USD accounts minus liabilities · Property excluded</p>
          <p id="overview-net-worth-coverage" class="overview-coverage"></p>
          <div class="overview-trend"><span id="overview-net-worth-change"></span><span>Past 365 days</span></div>
        </div>
        <div class="overview-history" id="overview-net-worth-chart" aria-live="polite"><p class="overview-history-state">Loading net-worth history…</p></div>
      </section>

      <section class="content-grid">
        <article class="panel transactions-panel" id="transactions">
          <div class="panel-heading">
            <h2>Recent transactions</h2>
            <a class="text-button" href="/transactions">See all</a>
          </div>
          <div id="transaction-list" class="transaction-empty" aria-live="polite">Loading transactions…</div>
        </article>

        <article class="panel accounts-panel" id="accounts">
          <div class="panel-heading">
            <h2>Bank accounts</h2>
            <a class="text-button" href="/accounts">See all</a>
          </div>
          <div id="overview-bank-accounts" aria-live="polite">
            <div class="account-empty">Loading your bank accounts…</div>
          </div>

        </article>
      </section>


    </main>
  </div>
  `;
}
