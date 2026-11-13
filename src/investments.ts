import type { BankAccount } from "./bank_accounts.ts";
import { escapeHtml as e } from "./html-utils.ts";

// Keep Node's renderer tests usable; Vite includes this stylesheet in the browser.
if (typeof document !== "undefined") void import("./investments.css");

export interface InvestmentHolding {
  symbol: string; name: string; quantity: number | null; price: number | null;
  marketValue: number; costBasis: number | null; isCash: boolean;
}
export interface InvestmentInput {
  valuationDate: string; source: string; accountValue: number; cashBalance: number;
  holdings: InvestmentHolding[];
}
export interface InvestmentSnapshot extends InvestmentInput { id: string; createdAt: string }
type Tx = Record<string, unknown>;
type Tab = "summary" | "holdings" | "activity" | "income";
const tabs: Tab[] = ["summary", "holdings", "activity", "income"];
const title = (s: string) => s[0].toUpperCase() + s.slice(1);
const cents = (n: number) => Math.round(n * 100);
function money(n: number | null, account: BankAccount): string {
  if (n === null) return "Not supplied";
  if (!account.currencyCode) return `${n.toFixed(2)} (currency unknown)`;
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: account.currencyCode ?? "USD" }).format(n); }
  catch { return `${n.toFixed(2)} ${account.currencyCode ?? "USD"}`; }
}
const num = (n: number | null) => n === null ? "Not supplied" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(n);
const metric = (label: string, value: string, note = "") => `<div class="investment-metric"><span>${e(label)}</span><strong>${e(value)}</strong>${note ? `<small>${e(note)}</small>` : ""}</div>`;
const empty = (text: string) => `<p class="investment-empty">${e(text)}</p>`;
const canWrite = (account: BankAccount) => account.source === "manual" && account.canImport === true;
export function investmentTotals(snapshot: InvestmentInput) {
  const invested = snapshot.holdings.filter(h => !h.isCash).reduce((n, h) => n + cents(h.marketValue), 0);
  const coreCash = snapshot.holdings.filter(h => h.isCash).reduce((n, h) => n + cents(h.marketValue), cents(snapshot.cashBalance));
  return { invested: invested / 100, coreCash: coreCash / 100, total: (invested + coreCash) / 100, difference: (cents(snapshot.accountValue) - invested - coreCash) / 100 };
}
function reconciliation(account: BankAccount, snapshot: InvestmentInput): string {
  const totals = investmentTotals(snapshot);
  return `<dl class="investment-facts"><div><dt>Source</dt><dd>${e(snapshot.source)}</dd></div><div><dt>Valuation date</dt><dd>${e(snapshot.valuationDate)}</dd></div><div><dt>Invested holdings</dt><dd>${e(money(totals.invested, account))}</dd></div><div><dt>Core cash positions + separate cash</dt><dd>${e(money(totals.coreCash, account))}</dd></div><div><dt>Holdings + cash total</dt><dd>${e(money(totals.total, account))}</dd></div><div><dt>Source account value</dt><dd>${e(money(snapshot.accountValue, account))}</dd></div><div><dt>Difference (source minus holdings + cash)</dt><dd>${e(money(totals.difference, account))}</dd></div></dl><p class="investment-note">Core cash positions are counted once. Separate cash must exclude cash already represented by a holding. Differences are disclosed, not adjusted away.</p>`;
}
export function renderInvestmentSummary(account: BankAccount, snapshot: InvestmentSnapshot | null): string {
  if (!snapshot) return `${empty("No holdings snapshot yet. Your saved balance is not a holdings valuation.")}${metric("Saved account balance", money(account.currentBalance, account), "Separate from source snapshot valuations")}${canWrite(account) ? '<p>Add a dated holdings snapshot using the exact CSV template above.</p>' : '<p>This saved account is read-only. No holdings have been supplied.</p>'}`;
  const totals = investmentTotals(snapshot);
  return `<div class="investment-metrics">${metric("Account value", money(snapshot.accountValue, account), `Source valuation · ${snapshot.valuationDate}`)}${metric("Invested holdings", money(totals.invested, account), "Excludes core cash")}${metric("Core cash", money(totals.coreCash, account), "Cash positions + separate cash")}</div><div class="investment-summary-source"><p>${e(snapshot.source)} · ${e(snapshot.valuationDate)}</p><button type="button" id="investment-snapshot-details">Snapshot details</button></div><div class="investment-secondary">${metric("Saved account balance", money(account.currentBalance, account), "Independently maintained; may differ from this dated valuation")}${metric("Reconciliation difference", money(totals.difference, account), "Source value minus holdings and cash")}</div><p class="investment-note">A valuation is an observation, not an investment return. Activity imports alone do not establish holdings, performance, or complete history.</p>`;
}
export function renderInvestmentHoldings(account: BankAccount, snapshot: InvestmentSnapshot | null, search = ""): string {
  if (!snapshot) return empty("Add a holdings snapshot to see positions. Transaction-history imports do not establish current holdings.");
  const rows = snapshot.holdings.map((h, index) => ({ h, index })).filter(({ h }) => `${h.symbol} ${h.name}`.toLowerCase().includes(search.toLowerCase()));
  return `<p class="investment-note">Source prices and quantities as of ${e(snapshot.valuationDate)}. No live market prices. Weights use source account value, including cash.</p><div class="investment-holdings">${rows.length ? rows.map(({h,index}) => `<button class="investment-holding" type="button" data-holding-index="${index}" aria-label="View ${e(h.symbol || h.name)} holding"><span class="investment-position"><strong>${e(h.symbol || "—")}</strong><span>${e(h.name)}${h.isCash ? " · Core cash" : ""}</span></span><span class="investment-position-secondary"><small>Quantity / source price</small>${e(num(h.quantity))} / ${e(money(h.price, account))}</span><span class="investment-position-secondary"><small>Cost basis</small>${e(money(h.costBasis, account))}</span><span class="investment-position-value"><strong>${e(money(h.marketValue, account))}</strong><small>${snapshot.accountValue > 0 ? `${(h.marketValue / snapshot.accountValue * 100).toFixed(2)}% of account` : "Weight unavailable"}</small></span></button>`).join("") : empty("No holdings match your search.")}</div><p class="investment-note">Separate cash: ${e(money(snapshot.cashBalance, account))}. Open a holding for details and supplied cost basis.</p>`;
}
function metadata(tx: Tx): Record<string, unknown> | null {
  const value = tx.investmentActivity;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function kind(tx: Tx): string {
  const value = metadata(tx)?.kind;
  return typeof value === "string" && ["trade", "income", "transfer", "fee", "other"].includes(value) ? value : "unclassified";
}
export function investmentIncome(account: BankAccount, transactions: Tx[]) {
  const sums = { total: 0n, cash: 0n, reinvested: 0n, unknown: 0n };
  let count = 0, excluded = 0;
  for (const tx of transactions) {
    const code = tx.iso_currency_code ?? tx.unofficial_currency_code;
    if (kind(tx) !== "income" || tx.pending === true || !account.currencyCode || code !== account.currencyCode || typeof tx.amount !== "number" || !Number.isFinite(tx.amount) || Math.abs(tx.amount) > 1e12) { excluded++; continue; }
    const signedCents = -cents(tx.amount);
    if (!Number.isSafeInteger(signedCents)) { excluded++; continue; }
    // Intermediate sums may exceed Number precision even when reversals leave a cent.
    const amount = BigInt(signedCents);
    const distribution = metadata(tx)?.distribution;
    sums.total += amount;
    if (distribution === "cash") sums.cash += amount;
    else if (distribution === "reinvested") sums.reinvested += amount;
    else sums.unknown += amount;
    count++;
  }
  // Guard each final value independently; an in-range net can hide oversized buckets.
  const supported = (n: bigint): number | null => n >= -100_000_000_000_000n && n <= 100_000_000_000_000n ? Number(n) : null;
  return { total: supported(sums.total), cash: supported(sums.cash), reinvested: supported(sums.reinvested), unknown: supported(sums.unknown), count, excluded };
}
export function renderInvestmentActivity(account: BankAccount, transactions: Tx[], filter = "all", search = ""): string {
  const rows = transactions.filter(tx => (filter === "all" || kind(tx) === filter) && `${String(tx.name ?? "")} ${String(metadata(tx)?.symbol ?? "")}`.toLowerCase().includes(search.toLowerCase()));
  return `<p class="investment-note">Imported activity only · Cash outflows are positive; inflows are negative. Older cash-only entries remain unclassified; no security or income classification is inferred.</p><div class="investment-activity-list">${rows.length ? rows.map(tx => {
    const meta = metadata(tx); const code = tx.iso_currency_code ?? tx.unofficial_currency_code;
    const amount = typeof tx.amount === "number" && Number.isFinite(tx.amount) ? (typeof code === "string" ? money(tx.amount, {...account, currencyCode: code}) : `${num(tx.amount)} (currency unknown)`) : "Amount unavailable";
    return `<article class="investment-activity-row"><div><strong>${e(String(tx.name ?? "Unnamed activity"))}</strong><small>${e(String(tx.date ?? "Date unavailable"))} · ${kind(tx) === "unclassified" ? "Unclassified cash activity" : title(kind(tx))}${tx.pending === true ? " · Pending" : ""}${meta?.symbol ? ` · ${e(String(meta.symbol))}` : ""}</small>${meta && (typeof meta.quantity === "number" || typeof meta.price === "number") ? `<small>Quantity ${e(num(typeof meta.quantity === "number" ? meta.quantity : null))} · Price ${e(money(typeof meta.price === "number" ? meta.price : null, {...account, currencyCode: typeof code === "string" ? code : null}))}</small>` : ""}</div><strong>${e(amount)}</strong></article>`;
  }).join("") : empty("No activity matches this view.")}</div>`;
}
export function renderInvestmentIncome(account: BankAccount, transactions: Tx[]): string {
  const income = investmentIncome(account, transactions);
  const display = (n: number | null) => n === null ? "Unavailable" : money(n / 100, account);
  const rangeNote = [income.total, income.cash, income.reinvested, income.unknown].includes(null) ? '<p class="investment-note">Unavailable totals or treatment subtotals exceed the supported range of ±1,000,000,000,000 currency units. All classified, posted entries above remain counted; in-range totals are shown independently.</p>' : "";
  return `<p class="investment-note">Imported activity only · ${income.count} classified, posted income entries in ${e(account.currencyCode ?? "an unknown account currency")}. Net recorded distributions include reversals; this is not a yield or a complete-period total.</p><div class="investment-metrics">${metric("Net recorded distributions", display(income.total))}${metric("Paid to cash", display(income.cash))}${metric("Reinvested", display(income.reinvested))}${metric("Unknown treatment", display(income.unknown))}</div><p class="investment-note">${income.excluded} other entries excluded: unclassified cash-only activity, non-income activity, pending items, unavailable or unsupported amounts, and foreign or unknown currency. Older imports may lack metadata. Unknown treatment is not assumed paid to cash. Distributions are not added to account value.</p>${rangeNote}${income.count === 0 ? empty("No verified income activity is available in the account currency.") : ""}`;
}
function snapshotForm(): string {
  return `<dialog id="investment-snapshot-dialog" class="investment-dialog" aria-labelledby="investment-snapshot-title"><form id="investment-snapshot-form" method="post"><h2 id="investment-snapshot-title">Add holdings snapshot</h2><p>Local copy only · No brokerage changes</p><div class="investment-form-grid"><label>Valuation date<input name="valuationDate" type="date" required></label><label>Source<input name="source" maxlength="200" placeholder="Statement or export name" required></label><label>Account value<input name="accountValue" type="number" min="0" step="0.01" required></label><label>Separate cash<input name="cashBalance" type="number" min="0" step="0.01" value="0" required></label></div><p class="investment-note">Separate cash excludes all cash positions included in the CSV. Only import a single-currency holdings valuation in this account’s currency.</p><label>Holdings CSV<input name="csv" type="file" accept=".csv,text/csv" required></label><p class="investment-note">Maximum file size: 1 MB. Exact template headers required: <code>symbol,name,quantity,price,marketValue,costBasis,isCash</code>. Leave unknown quantity, price or cost basis blank. Set isCash to true or false. A transaction-history CSV is not a holdings file.</p><button id="investment-download-template" type="button">Download blank template</button><div id="investment-preview" aria-live="polite"></div><p id="investment-snapshot-message" role="status" aria-live="polite"></p><footer><button type="button" id="investment-snapshot-cancel">Cancel</button><button type="submit" id="investment-preview-button">Preview snapshot</button><button type="button" id="investment-confirm" disabled>Confirm save</button></footer></form></dialog>`;
}
export function renderInvestmentDetail(account: BankAccount, _transactions: Tx[], _accounts: BankAccount[]): string {
  return `<section id="investment-detail" class="investment-detail panel" aria-label="Brokerage information"><header class="investment-heading"><div><p class="eyebrow">BROKERAGE · READ-ONLY VIEWS</p><h2>Your investments</h2><p>Source snapshots and imported activity. No trading or live price requests.</p></div>${canWrite(account) ? '<button type="button" id="investment-add-snapshot">Add snapshot</button>' : '<span class="investment-note">Saved account · Read-only</span>'}</header>
    <div class="investment-tabs" role="tablist" aria-label="Investment views">${tabs.map(tab => `<button id="investment-tab-${tab}" role="tab" type="button" aria-selected="${tab === "summary"}" aria-controls="investment-panel-${tab}" tabindex="${tab === "summary" ? 0 : -1}" data-investment-tab="${tab}">${title(tab)}</button>`).join("")}</div>
    <p id="investment-load-status" role="status">Loading holdings snapshots…</p><button type="button" id="investment-retry" hidden>Retry snapshots</button>
    ${tabs.map(tab => `<section id="investment-panel-${tab}" role="tabpanel" aria-labelledby="investment-tab-${tab}"${tab !== "summary" ? " hidden" : ""}>
      ${tab === "holdings" || tab === "activity" ? `<div class="investment-tools"><label>Search ${tab}<input type="search" id="investment-${tab}-search" autocomplete="off"></label><button type="button" data-clear-search="${tab}">Clear search</button>${tab === "activity" ? '<label>Activity type<select id="investment-activity-filter" aria-label="Activity type"><option value="all">All activity</option><option value="trade">Trades</option><option value="income">Income</option><option value="transfer">Transfers</option><option value="fee">Fees</option><option value="other">Other</option><option value="unclassified">Unclassified</option></select></label>' : ""}</div>` : ""}<div data-investment-content="${tab}"></div></section>`).join("")}
    <dialog id="investment-details-dialog" class="investment-dialog" aria-labelledby="investment-details-title"><h2 id="investment-details-title">Details</h2><div id="investment-details-body"></div><button type="button" id="investment-details-close">Close</button></dialog>${canWrite(account) ? snapshotForm() : ""}</section>`;
}
function validInput(value: unknown): value is InvestmentInput {
  if (!value || typeof value !== "object") return false;
  const s = value as InvestmentInput;
  return typeof s.valuationDate === "string" && typeof s.source === "string" && Number.isFinite(s.accountValue) && Number.isFinite(s.cashBalance) && Array.isArray(s.holdings) && s.holdings.every(h => h && typeof h.symbol === "string" && typeof h.name === "string" && typeof h.isCash === "boolean" && Number.isFinite(h.marketValue) && [h.quantity, h.price, h.costBasis].every(n => n === null || Number.isFinite(n)));
}
export async function initializeInvestmentDetail(account: BankAccount, transactions: Tx[], _accounts: BankAccount[], onReload: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  const root = document.querySelector<HTMLElement>("#investment-detail");
  if (!root || signal?.aborted) return;
  const active = () => root.isConnected && !signal?.aborted;
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  let snapshots: InvestmentSnapshot[] = [];
  let latest: InvestmentSnapshot | null = null;
  let loading = false;
  let origin: HTMLElement | null = null;
  const details = q<HTMLDialogElement>("#investment-details-dialog");
  function openDetails(trigger: HTMLElement, heading: string, body: string) {
    if (!active()) return;
    origin = trigger; q("#investment-details-title").textContent = heading;
    q("#investment-details-body").innerHTML = body; details.showModal();
  }
  details.addEventListener("close", () => { if (active() && origin?.isConnected) origin.focus(); }, { signal });
  q("#investment-details-close").addEventListener("click", () => details.close(), { signal });
  function render() {
    if (!active()) return;
    q('[data-investment-content="summary"]').innerHTML = renderInvestmentSummary(account, latest) + (snapshots.length ? `<details class="investment-history"><summary>Saved snapshots (${snapshots.length})</summary>${snapshots.map((s, i) => `<button type="button" data-snapshot-index="${i}">${e(s.valuationDate)} · ${e(s.source)} · ${e(money(s.accountValue, account))}</button>`).join("")}<p class="investment-note">Immutable source observations. The latest valuation date is shown above; older imports do not replace a newer valuation.</p></details>` : "");
    q('[data-investment-content="holdings"]').innerHTML = renderInvestmentHoldings(account, latest, q<HTMLInputElement>("#investment-holdings-search").value);
    q('[data-investment-content="activity"]').innerHTML = renderInvestmentActivity(account, transactions, q<HTMLSelectElement>("#investment-activity-filter").value, q<HTMLInputElement>("#investment-activity-search").value);
    q('[data-investment-content="income"]').innerHTML = renderInvestmentIncome(account, transactions);
  }
  function select(tab: Tab, focus = false) {
    for (const name of tabs) {
      const button = q<HTMLButtonElement>(`#investment-tab-${name}`);
      button.setAttribute("aria-selected", String(name === tab)); button.tabIndex = name === tab ? 0 : -1;
      q(`#investment-panel-${name}`).hidden = name !== tab;
      if (focus && name === tab) button.focus();
    }
  }
  root.addEventListener("keydown", event => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-investment-tab]");
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.indexOf(tab.dataset.investmentTab as Tab);
    select(event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[3] : tabs[(index + (event.key === "ArrowRight" ? 1 : 3)) % 4], true);
  }, { signal });
  root.addEventListener("click", event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("button");
    if (!target || !active()) return;
    if (target.dataset.investmentTab) select(target.dataset.investmentTab as Tab);
    if (target.dataset.clearSearch) { const input = q<HTMLInputElement>(`#investment-${target.dataset.clearSearch}-search`); input.value = ""; render(); input.focus(); }
    if (target.id === "investment-snapshot-details" && latest) openDetails(target, "Snapshot details", reconciliation(account, latest));
    if (target.dataset.snapshotIndex !== undefined) { const snapshot = snapshots[Number(target.dataset.snapshotIndex)]; if (snapshot) openDetails(target, "Snapshot details", reconciliation(account, snapshot)); }
    if (target.dataset.holdingIndex !== undefined && latest) {
      const h = latest.holdings[Number(target.dataset.holdingIndex)]; if (!h) return;
      openDetails(target, `${h.symbol} · ${h.name}`, `<p>Source valuation · ${e(latest.valuationDate)}</p><dl class="investment-facts">${[["Market value",money(h.marketValue,account)],["Quantity",num(h.quantity)],["Source price",money(h.price,account)],["Cost basis",money(h.costBasis,account)],["Unrealized gain / loss",h.costBasis === null ? "Unavailable without cost basis" : money((cents(h.marketValue)-cents(h.costBasis))/100,account)],["Account weight",latest.accountValue > 0 ? `${(h.marketValue/latest.accountValue*100).toFixed(2)}%` : "Unavailable"]].map(([label,value])=>`<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join("")}</dl><p class="investment-note">${h.isCash ? "Core cash position, counted once in core cash." : "Position-level values only; underlying sector exposure is unknown."}</p>`);
    }
  }, { signal });
  for (const id of ["#investment-holdings-search", "#investment-activity-search", "#investment-activity-filter"]) q(id).addEventListener("input", render, { signal });
  async function load(): Promise<void> {
    if (!active() || loading) return;
    loading = true; q("#investment-load-status").textContent = "Loading holdings snapshots…"; q("#investment-retry").hidden = true;
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(account.id)}/investments`, { credentials: "same-origin", cache: "no-store", signal });
      const result = await response.json(); if (!active()) return;
      if (!response.ok || !Array.isArray(result.snapshots) || !result.snapshots.every((s: unknown) => validInput(s) && typeof (s as InvestmentSnapshot).id === "string" && typeof (s as InvestmentSnapshot).createdAt === "string")) throw new Error("Invalid snapshot response");
      snapshots = result.snapshots.slice().sort((a: InvestmentSnapshot,b: InvestmentSnapshot) => b.valuationDate.localeCompare(a.valuationDate) || b.createdAt.localeCompare(a.createdAt)); latest = snapshots[0] ?? null;
      q("#investment-load-status").textContent = latest ? `Latest source snapshot · ${latest.valuationDate}` : "No saved holdings snapshots."; render();
    } catch { if (active()) { q("#investment-load-status").textContent = "Unable to load holdings snapshots. Saved balance and imported activity are still separate."; q("#investment-retry").hidden = false; } }
    finally { loading = false; }
  }
  q("#investment-retry").addEventListener("click", () => { void load(); }, { signal });
  render();
  if (canWrite(account)) {
    const dialog = q<HTMLDialogElement>("#investment-snapshot-dialog");
    const form = q<HTMLFormElement>("#investment-snapshot-form");
    const confirm = q<HTMLButtonElement>("#investment-confirm");
    const message = q("#investment-snapshot-message");
    let preview: InvestmentInput | null = null; let busy = false; let uncertain = false;
    const setBusy = (value: boolean) => { busy = value; for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")) control.disabled = value; confirm.disabled = value || !preview || uncertain; };
    const invalidate = () => { preview = null; confirm.disabled = true; q("#investment-preview").innerHTML = ""; };
    form.addEventListener("input", invalidate, { signal });
    q("#investment-add-snapshot").addEventListener("click", () => { if (active() && !busy) dialog.showModal(); }, { signal });
    q("#investment-snapshot-cancel").addEventListener("click", () => { if (!busy) dialog.close(); }, { signal });
    dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); }, { signal });
    dialog.addEventListener("close", () => { if (active()) q("#investment-add-snapshot").focus(); }, { signal });
    q("#investment-download-template").addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob(["symbol,name,quantity,price,marketValue,costBasis,isCash\r\n"], {type:"text/csv;charset=utf-8"}));
      const link = document.createElement("a"); link.href = url; link.download = "holdings-template.csv"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, { signal });
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (!active() || busy || uncertain || !form.reportValidity()) return;
      invalidate(); message.textContent = "";
      const data = new FormData(form); const file = data.get("csv");
      if (!(file instanceof File) || file.size === 0 || file.size > 1024 * 1024) { message.textContent = "Choose a nonempty holdings CSV no larger than 1 MB."; return; }
      setBusy(true);
      try {
        const csv = await file.text(); if (!active()) return;
        const response = await fetch(`/api/accounts/${encodeURIComponent(account.id)}/investments/preview`, { method: "POST", credentials:"same-origin", headers:{"Content-Type":"application/json"}, signal, body:JSON.stringify({valuationDate:data.get("valuationDate"),source:data.get("source"),accountValue:Number(data.get("accountValue")),cashBalance:Number(data.get("cashBalance")),csv}) });
        const result = await response.json(); if (!active()) return;
        if (!response.ok || !validInput(result.snapshot)) { message.textContent = typeof result.error === "string" ? result.error : "Unable to preview this file. Check the exact template and source values."; return; }
        preview = result.snapshot; q("#investment-preview").innerHTML = `<h3>Review before saving</h3>${reconciliation(account, result.snapshot)}<p class="investment-note">Saving creates an immutable local snapshot. Only the latest dated snapshot updates the manual account balance. No brokerage changes.</p>`;
        message.textContent = "Preview only. Nothing has been saved.";
      } catch { if (active()) message.textContent = "Unable to preview this file. Nothing was submitted for saving."; }
      finally { if (active()) setBusy(false); }
    }, { signal });
    confirm.addEventListener("click", async () => {
      if (!active() || busy || !preview || uncertain) return;
      setBusy(true); message.textContent = "Saving snapshot…";
      let saved: InvestmentSnapshot | null = null;
      try {
        const response = await fetch(`/api/accounts/${encodeURIComponent(account.id)}/investments`, {method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},signal,body:JSON.stringify({snapshot:preview})});
        const result = await response.json(); if (!active()) return;
        if (!response.ok || !validInput(result.snapshot) || typeof result.snapshot.id !== "string") throw new Error("Unconfirmed write");
        saved = result.snapshot;
        // Keep the write locked through fresh readback, not just the POST.
        const readback = await fetch(`/api/accounts/${encodeURIComponent(account.id)}/investments`, { credentials:"same-origin",cache:"no-store",signal });
        const verified = await readback.json(); if (!active()) return;
        if (!readback.ok || !Array.isArray(verified.snapshots) || !verified.snapshots.some((s: unknown) => validInput(s) && (s as InvestmentSnapshot).id === saved!.id)) throw new Error("Unconfirmed readback");
        invalidate(); dialog.close();
        try { await onReload(); } catch { if (active()) q("#investment-load-status").textContent = "Snapshot saved and verified. Reload the account to refresh its balance."; }
      } catch {
        if (active()) { uncertain = true; message.textContent = saved ? "Save response received, but readback could not confirm the snapshot. Reload and check saved snapshots before retrying." : "Unable to confirm whether this snapshot was saved. Reload this account and check saved snapshots before trying again; resubmitting could create a duplicate."; }
      } finally { if (active()) setBusy(false); }
    }, { signal });
  }
  await load();
}
