import { escapeHtml } from "./html-utils.ts";
import { renderAppNavigation } from "./navigation.ts";
import { navigateTo } from "./router.ts";
import { renderRecentTransactionList } from "./transaction-list.ts";
import { renderRealEstateCards } from "./real-estate.ts";
import { renderManualAccountDialog, renderImportDialog, initializeManualAccountCreation, initializeAccountImport } from "./account-import.ts";
export {
  findReferencedAccount,
  formatTransactionAmount,
  renderLinkedTransactionName,
} from "./account-transaction-utils.ts";

export interface BankAccountsPageUser {
  displayName: string;
  username: string;
}

export interface BankAccount {
  id: string;
  itemId: string;
  providerAccountId?: string;
  institutionName: string;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  currentBalance: number | null;
  availableBalance: number | null;
  currencyCode: string | null;
  updatedAt: string;
  lastRetrievedAt?: string;
  source?: string;
  canImport?: boolean;
}

export interface BankConnection {
  itemId: string;
  institutionName: string;
  lastRetrievedAt: string;
  accountCount: number;
  accounts: BankAccount[];
}

interface AccountsResponse {
  configured: boolean;
  accounts: BankAccount[];
}

interface AccountDetailResponse {
  account: BankAccount;
  transactions: Array<Record<string, unknown>>;
  accounts: BankAccount[];
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isNullableNumber(value: unknown): value is number | null {
  return typeof value === "number" || value === null;
}

function isBankAccount(value: unknown): value is BankAccount {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return (
    "id" in value &&
    typeof value.id === "string" &&
    "itemId" in value &&
    typeof value.itemId === "string" &&
    "institutionName" in value &&
    typeof value.institutionName === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "officialName" in value &&
    isNullableString(value.officialName) &&
    "type" in value &&
    typeof value.type === "string" &&
    "subtype" in value &&
    isNullableString(value.subtype) &&
    "mask" in value &&
    isNullableString(value.mask) &&
    "currentBalance" in value &&
    isNullableNumber(value.currentBalance) &&
    "availableBalance" in value &&
    isNullableNumber(value.availableBalance) &&
    "currencyCode" in value &&
    isNullableString(value.currencyCode) &&
    "updatedAt" in value &&
    typeof value.updatedAt === "string" &&
    (!("lastRetrievedAt" in value) || typeof value.lastRetrievedAt === "string") &&
    (!("providerAccountId" in value) || typeof value.providerAccountId === "string")
  );
}

function isAccountsResponse(value: unknown): value is AccountsResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const accounts: unknown = "accounts" in value ? value.accounts : null;
  return (
    "configured" in value &&
    typeof value.configured === "boolean" &&
    Array.isArray(accounts) &&
    accounts.every(isBankAccount)
  );
}

function isAccountDetailResponse(value: unknown): value is AccountDetailResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "account" in value &&
    isBankAccount(value.account) &&
    "accounts" in value &&
    Array.isArray(value.accounts) &&
    value.accounts.every(isBankAccount) &&
    "transactions" in value &&
    Array.isArray(value.transactions) &&
    value.transactions.every(
      (transaction: unknown): transaction is Record<string, unknown> =>
        typeof transaction === "object" && transaction !== null,
    )
  );
}

function getErrorMessage(value: unknown, fallback: string): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return value.error;
  }
  return fallback;
}

function formatBalance(
  balance: number | null,
  currencyCode: string | null,
): string {
  if (balance === null) {
    return "Balance unavailable";
  }

  if (currencyCode) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currencyCode,
      }).format(balance);
    } catch {
      return `${balance.toFixed(2)} ${currencyCode}`;
    }
  }

  return balance.toFixed(2);
}

function isLiabilityAccount(account: BankAccount): boolean {
  const accountType: string = account.type.toLowerCase();
  return accountType === "credit" || accountType === "loan";
}

function formatAccountBalance(account: BankAccount): string {
  const balance: number | null = account.currentBalance;
  const signedBalance: number | null =
    balance !== null && isLiabilityAccount(account) && balance !== 0
      ? -Math.abs(balance)
      : balance;

  return formatBalance(signedBalance, account.currencyCode);
}

export function renderAccountDetail(
  account: BankAccount,
  transactions: Array<Record<string, unknown>>,
  accounts: BankAccount[] = [account],
): string {
  const accountType = [account.type, account.subtype]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const mask = account.mask ? `•••• ${escapeHtml(account.mask)}` : "Account number hidden";
  const updatedAt = new Date(account.updatedAt);
  const updatedLabel = Number.isNaN(updatedAt.getTime())
    ? "Update time unavailable"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(updatedAt);
  const transactionRows = transactions.length > 0
    ? renderRecentTransactionList(transactions, accounts, 50)
    : `<div class="account-empty">No transactions are available for this account yet.</div>`;

  return `
    <a class="account-back-link" href="/accounts">← Back to accounts</a>
    <section class="account-detail-snapshot panel">
      <div class="account-detail-heading">
        <p class="eyebrow">${escapeHtml(account.institutionName)}</p>
        <h1>${escapeHtml(account.name)}</h1>
        <p>${escapeHtml(accountType)} · ${mask}</p>
        ${account.officialName ? `<span>${escapeHtml(account.officialName)}</span>` : ""}
      </div>
      <div class="account-detail-balances">
        <div><span>Current balance</span><strong>${escapeHtml(formatAccountBalance(account))}</strong></div>
        <div><span>Available balance</span><strong>${escapeHtml(formatBalance(account.availableBalance, account.currencyCode))}</strong></div>
      </div>
      <p class="account-detail-updated">${account.source === "manual" ? "Manually maintained account · Updated" : "Account details retrieved"} ${escapeHtml(updatedLabel)}</p>
    </section>
    <section class="panel account-detail-transactions">
      <div class="panel-heading"><div><h2>Transactions</h2><p>Recent activity for this account</p></div>${account.canImport ? `<button id="import-transactions" class="primary-button" type="button">Import transactions</button>` : ""}</div>
      <p id="account-import-message" class="auth-message success" role="status" hidden></p>
      <div class="account-transaction-list">${transactionRows}</div>
    </section>
    ${account.canImport ? renderImportDialog(account) : ""}
  `;
}

export function renderAccounts(accounts: BankAccount[]): string {
  if (accounts.length === 0) {
    return `
      <div class="accounts-empty">
        <div class="empty-icon" aria-hidden="true">▣</div>
        <strong>No accounts yet</strong>
        <span>Add an account to start importing your transactions.</span>
      </div>
    `;
  }

  const groups: Map<string, BankAccount[]> = new Map();
  for (const account of accounts) {
    const bankKey = account.institutionName.trim().toLowerCase();
    const group: BankAccount[] = groups.get(bankKey) ?? [];
    group.push(account);
    groups.set(bankKey, group);
  }

  return [...groups.entries()]
    .map(([, group]): string => {
      const institutionName: string = escapeHtml(group[0]?.institutionName.trim() || "Bank");
      const latestTimestamp = group.reduce((latest, account) => {
        const timestamp = new Date(
          account.source === "manual" ? account.updatedAt : account.lastRetrievedAt ?? account.updatedAt,
        ).getTime();
        return Number.isNaN(timestamp) ? latest : Math.max(latest, timestamp);
      }, -Infinity);
      const lastRetrievedAt = new Date(latestTimestamp);
      const manual = group.every(account => account.source === "manual");
      const hasManual = group.some(account => account.source === "manual");
      const sourceLabel = manual
        ? `MANUAL ACCOUNT${group.length === 1 ? "" : "S"}`
        : hasManual ? "ACCOUNTS" : "SAVED INSTITUTION";
      const updateLabel: string = Number.isNaN(lastRetrievedAt.getTime())
        ? `${hasManual ? "Update" : "Last retrieved"} time unavailable`
        : `${hasManual ? "Updated" : "Last retrieved"} ${escapeHtml(
            new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(lastRetrievedAt),
          )}`;
      const accountRows: string = group
        .map((account): string => {
          const accountType: string = [
            account.type,
            account.subtype,
          ]
            .filter((part): part is string => Boolean(part))
            .join(" · ");
          const mask: string = account.mask
            ? `•••• ${escapeHtml(account.mask)}`
            : "Account number hidden";
          const liabilityClass: string =
            isLiabilityAccount(account) && account.currentBalance !== null
              ? " liability-balance"
              : "";

          return `
            <a class="connected-account-link" href="/accounts/${escapeHtml(encodeURIComponent(account.id))}">
              <article class="connected-account">
                <div class="connected-account-icon" aria-hidden="true">▣</div>
                <div class="connected-account-info">
                  <strong>${escapeHtml(account.name)}</strong>
                  <span>${escapeHtml(accountType)} · ${mask}</span>
                </div>
                <strong class="connected-account-balance${liabilityClass}">
                  ${escapeHtml(formatAccountBalance(account))}
                </strong>
              </article>
            </a>
          `;
        })
        .join("");

      return `
        <section class="institution-card" aria-label="${institutionName} accounts">
          <header class="institution-heading">
            <div>
              <p class="eyebrow">${sourceLabel}</p>
              <h2>${institutionName}</h2>
            </div>
            <div class="institution-actions">
              <span class="institution-account-count">${group.length} ${group.length === 1 ? "account" : "accounts"}</span>
              <span class="institution-last-retrieved">${updateLabel}</span>
            </div>
          </header>
          <div class="connected-account-list">${accountRows}</div>
        </section>
      `;
    })
    .join("");
}

export function renderConnections(connections: BankConnection[]): string {
  if (connections.length === 0) return `<div class="accounts-empty"><strong>No saved bank connections</strong><span>No previously saved connections are available.</span></div>`;
  return connections.map((connection) => {
    const institutionName = escapeHtml(connection.institutionName);
    const retrieved = new Date(connection.lastRetrievedAt);
    const updateLabel = Number.isNaN(retrieved.getTime()) ? "Last retrieved time unavailable" : `Last retrieved ${escapeHtml(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(retrieved))}`;
    const accountRows = connection.accounts.map((account) => {
      const accountType = [account.type, account.subtype].filter((part): part is string => Boolean(part)).join(" · ");
      const mask = account.mask ? `•••• ${escapeHtml(account.mask)}` : "Account number hidden";
      return `<a class="connected-account-link" href="/accounts/${escapeHtml(encodeURIComponent(account.id))}"><article class="connected-account"><div class="connected-account-icon" aria-hidden="true">▣</div><div class="connected-account-info"><strong>${escapeHtml(account.name)}</strong><span>${escapeHtml(accountType)} · ${mask}</span></div><strong class="connected-account-balance${isLiabilityAccount(account) && account.currentBalance !== null ? " liability-balance" : ""}">${escapeHtml(formatAccountBalance(account))}</strong></article></a>`;
    }).join("");
    return `<details class="connection-card"><summary class="connection-heading"><span class="connected-account-icon" aria-hidden="true">↔</span><span class="connection-title"><span class="eyebrow">SAVED BANK DATA</span><strong>${institutionName}</strong><span>${connection.accountCount} ${connection.accountCount === 1 ? "account" : "accounts"} · ${updateLabel}</span></span></summary><div class="connection-accounts">${accountRows || `<p class="account-empty">No saved accounts are available for this institution.</p>`}</div></details>`;
  }).join("");
}

export function renderConnectionsPage(user: BankAccountsPageUser): string {
  return `<div class="app-shell">${renderAppNavigation(user, "real-estate")}<main class="main-content accounts-content"><section class="page-heading accounts-page-heading"><div><p class="eyebrow">YOUR FINANCES</p><h1>Real Estate</h1><p class="subheading">Track property values and estimate history.</p></div><button class="primary-button" id="add-property" type="button">＋ Add Real Estate</button></section><section class="panel inline-property-form" id="new-property-panel" hidden><h2>New property</h2><form id="add-property-form"><label>Address<input id="property-address" name="address" required maxlength="500" autocomplete="off" placeholder="Enter an address"></label><div id="address-suggestions" role="listbox"></div><div id="zillow-url-field" hidden><label>Zillow URL<input id="zillow-property-url" name="zillowUrl" type="url" required placeholder="https://www.zillow.com/homedetails/…"></label></div><div class="property-form-actions"><button class="primary-button" id="done-property" type="submit" disabled>Done</button></div><p id="property-form-message" role="status"></p></form></section><div id="real-estate-properties" class="connected-accounts" aria-live="polite"><div class="panel accounts-loading">Loading properties…</div></div></main></div>`;
}

export function renderOverviewBankAccounts(accounts: BankAccount[]): string {
  const container: string = accounts.length === 0
    ? `<div class="account-empty">
        <span>No accounts yet. Add one from the Accounts page.</span>
      </div>`
    : accounts
        .slice(0, 4)
        .map((account): string => {
          const accountType: string = [
            account.subtype ?? account.type,
            account.mask ? `•••• ${account.mask}` : "",
          ]
            .filter((part): boolean => part.length > 0)
            .join(" · ");

          return `
            <a class="overview-account-link" href="/accounts/${escapeHtml(encodeURIComponent(account.id))}">
              <div class="account-row">
                <div class="account-icon checking" aria-hidden="true">▣</div>
                <div class="account-info">
                  <strong>${escapeHtml(account.name)}</strong>
                  <span>${escapeHtml(account.institutionName)}${accountType ? ` · ${escapeHtml(accountType)}` : ""}</span>
                </div>
                <strong class="account-balance">${escapeHtml(formatBalance(account.currentBalance, account.currencyCode))}</strong>
              </div>
            </a>
          `;
        })
        .join("");

  const additionalCount: number = Math.max(0, accounts.length - 4);
  const additionalLink: string = additionalCount > 0
    ? `<a class="overview-more-accounts" href="/accounts">+${additionalCount} more account${additionalCount === 1 ? "" : "s"}</a>`
    : "";

  return `${container}${additionalLink}`;
}

export function getTotalBalance(accounts: BankAccount[]): number {
  return accounts.reduce(
    (total: number, account: BankAccount): number => {
      const balance: number = account.currentBalance ?? 0;

      return total + (isLiabilityAccount(account) ? -Math.abs(balance) : balance);
    },
    0,
  );
}

export async function initializeOverviewBankAccounts(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const container: HTMLDivElement | null =
    document.querySelector<HTMLDivElement>("#overview-bank-accounts");
  if (!container) {
    return;
  }

  const totalBalanceElement: HTMLDivElement | null =
    document.querySelector<HTMLDivElement>("#overview-total-balance");
  const isActive = (): boolean => !signal?.aborted && container.isConnected !== false;

  try {
    const response: Response = await fetch("/api/accounts", {
      cache: "no-store",
    });
    const payload: unknown = await readJson(response);
    if (!isActive()) return;
    if (!response.ok) {
      throw new Error(getErrorMessage(payload, "Unable to load bank accounts."));
    }
    if (!isAccountsResponse(payload)) {
      throw new Error("The server returned an invalid bank-account response.");
    }
    container.innerHTML = renderOverviewBankAccounts(payload.accounts);
    if (totalBalanceElement) {
      totalBalanceElement.textContent = formatBalance(
        getTotalBalance(payload.accounts),
        "USD",
      );
    }
  } catch {
    if (!isActive()) return;
    if (totalBalanceElement) {
      totalBalanceElement.textContent = "Balance unavailable";
    }
    container.innerHTML = `
      <div class="account-empty">
        <span>Bank accounts couldn't be loaded.</span>
        <button class="text-button" id="retry-overview-bank-accounts" type="button">Try again</button>
      </div>
    `;
    container
      .querySelector<HTMLButtonElement>("#retry-overview-bank-accounts")
      ?.addEventListener("click", (): void => {
        if (isActive()) void initializeOverviewBankAccounts(signal);
      });
  }
}

function setAccountsMessage(element: HTMLParagraphElement | null, message: string, isError: boolean): void {
  if (element) {
    element.textContent = message;
    element.hidden = message.length === 0;
    element.classList.toggle("error", isError);
    element.classList.toggle("success", !isError);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function refreshAccounts(container: HTMLDivElement | null, message: HTMLParagraphElement | null, signal?: AbortSignal): Promise<void> {
  const isActive = (): boolean => !signal?.aborted && container?.isConnected !== false;
  if (!container || !isActive()) {
    return;
  }

  try {
    const response: Response = await fetch("/api/accounts", {
      cache: "no-store",
    });
    const payload: unknown = await readJson(response);

    if (!isActive()) return;
    if (!response.ok) {
      throw new Error(
        getErrorMessage(payload, "Unable to load bank accounts."),
      );
    }
    if (!isAccountsResponse(payload)) {
      throw new Error("The server returned an invalid bank-account response.");
    }

    container.innerHTML = renderAccounts(payload.accounts);
  } catch (error: unknown) {
    if (!isActive()) return;
    container.innerHTML = `
      <div class="accounts-error">
        <strong>We couldn't load your bank accounts.</strong>
        <button class="text-button" id="retry-accounts" type="button">Try again</button>
      </div>
    `;
    container
      .querySelector<HTMLButtonElement>("#retry-accounts")
      ?.addEventListener("click", (): void => {
        if (isActive()) void refreshAccounts(container, message, signal);
      });
    setAccountsMessage(
      message,
      error instanceof Error ? error.message : "Unable to load bank accounts.",
      true,
    );
  }
}

export function renderBankAccountsPage(user: BankAccountsPageUser): string {
  return `
    <div class="app-shell">
      ${renderAppNavigation(user, "accounts")}

      <main class="main-content accounts-content">

        <p id="accounts-message" class="auth-message" role="status" hidden></p>

        <section class="page-heading accounts-page-heading">
          <div>
            <p class="eyebrow">YOUR FINANCES</p>
            <h1>Accounts</h1>
            <p class="subheading">Your accounts, balances, and imported activity.</p>
          </div>
          <button class="primary-button" id="add-account" type="button">＋ Add account</button>
        </section>

        <p class="bank-data-notice">Add accounts manually and import CSV, OFX, or QFX transactions. Automatic bank syncing is unavailable; previously saved data remains available.</p>

        <div id="connected-accounts" class="connected-accounts" aria-live="polite">
          <div class="panel accounts-loading">Loading accounts…</div>
        </div>
        ${renderManualAccountDialog()}


      </main>
    </div>
  `;
}

export function renderBankAccountDetailPage(user: BankAccountsPageUser): string {
  return `
    <div class="app-shell">
      ${renderAppNavigation(user, "accounts")}
      <main class="main-content accounts-content">

        <section class="page-heading accounts-page-heading">
          <div><p class="eyebrow">YOUR ACCOUNT</p><h1>Account details</h1><p class="subheading">Account balances and transaction history.</p></div>
          <div class="account-detail-actions">
            <a class="text-button account-all-link" href="/accounts">All accounts</a>
          </div>
        </section>
        <p class="bank-data-notice" role="status">Add accounts manually and import CSV, OFX, or QFX transactions. Automatic bank syncing is unavailable; previously saved data remains available.</p>
        <div id="account-detail-content" class="account-detail-content" aria-live="polite">
          <div class="panel accounts-loading">Loading account details and transactions…</div>
        </div>

      </main>
    </div>
  `;
}

export async function initializeAccountDetailPage(accountId: string, signal?: AbortSignal): Promise<void> {
  const container = document.querySelector<HTMLDivElement>("#account-detail-content");
  if (!container || signal?.aborted) return;
  const isActive = (): boolean => !signal?.aborted && container.isConnected !== false;

  const load = async (): Promise<void> => {
    if (!isActive()) return;
    try {
      const response = await fetch(
        `/api/accounts/${encodeURIComponent(accountId)}/transactions`,
        { cache: "no-store", credentials: "same-origin" },
      );
      const payload: unknown = await readJson(response);
      if (!isActive()) return;
      if (!response.ok || !isAccountDetailResponse(payload)) {
        throw new Error(getErrorMessage(payload, "Unable to load this account."));
      }
      container.innerHTML = renderAccountDetail(payload.account, payload.transactions, payload.accounts);
      if (payload.account.canImport) initializeAccountImport(payload.account, async result => {
        if (!isActive()) return;
        await load();
        if (!isActive()) return;
        const message = container.querySelector<HTMLElement>("#account-import-message");
        if (message) {
          message.textContent = `Imported ${result.imported} transaction${result.imported === 1 ? "" : "s"}. Skipped ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"}.`;
          message.hidden = false;
        }
      }, signal);
    } catch (error: unknown) {
      if (!isActive()) return;
      const message = error instanceof Error ? error.message : "Unable to load this account.";
      container.innerHTML = `
        <section class="panel account-detail-error" role="alert">
          <strong>This account could not be loaded.</strong>
          <span>${escapeHtml(message)}</span>
          <a class="text-button" href="/accounts">Back to accounts</a>
        </section>
      `;
    }
  };
  await load();
}

export function initializeBankAccountsPage(signal?: AbortSignal): void {
  if (signal?.aborted) return;
  const container = document.querySelector<HTMLDivElement>("#connected-accounts");
  const message = document.querySelector<HTMLParagraphElement>("#accounts-message");
  initializeManualAccountCreation(async account => {
    if (signal?.aborted || !container || container.isConnected === false) return;
    navigateTo(`/accounts/${encodeURIComponent(account.id)}`);
  });
  void refreshAccounts(container, message, signal);
}

export async function initializeConnectionsPage(signal?: AbortSignal): Promise<void> {
 if(signal?.aborted)return;
 const container=document.querySelector<HTMLDivElement>("#real-estate-properties"); if(!container)return;
 const isActive=()=>!signal?.aborted&&container.isConnected!==false;
 const refresh=async()=>{if(!isActive())return;const response=await fetch("/api/real-estate",{cache:"no-store",credentials:"same-origin"});const payload=await readJson(response);if(!isActive())return;if(!response.ok||typeof payload!=="object"||payload===null||!("properties" in payload)||!Array.isArray(payload.properties))throw new Error("Unable to load properties.");container.innerHTML=renderRealEstateCards(payload.properties as Parameters<typeof renderRealEstateCards>[0]);};
 const address=document.querySelector<HTMLInputElement>("#property-address"), suggestions=document.querySelector<HTMLElement>("#address-suggestions"), zillowField=document.querySelector<HTMLElement>("#zillow-url-field"), done=document.querySelector<HTMLButtonElement>("#done-property"), panel=document.querySelector<HTMLElement>("#new-property-panel"); let selected:{address:string;latitude:number;longitude:number}|null=null, timer=0;
 signal?.addEventListener("abort",()=>{if(timer)window.clearTimeout(timer);},{once:true});
 document.querySelector("#add-property")?.addEventListener("click",()=>{if(panel)panel.hidden=false;address?.focus();});
 address?.addEventListener("input",()=>{if(!isActive())return;selected=null;window.clearTimeout(timer);if(zillowField)zillowField.hidden=true;if(done)done.disabled=true;if(suggestions)suggestions.replaceChildren();const q=address.value.trim();if(q.length<4)return;timer=window.setTimeout(async()=>{if(!isActive())return;try{const r=await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`,{headers:{Accept:"application/json"}});const places=await r.json() as Array<{display_name:string;lat:string;lon:string}>;if(!isActive()||address.value.trim()!==q)return;if(suggestions)suggestions.innerHTML=places.map((p,i)=>`<button type="button" role="option" data-place="${i}">${escapeHtml(p.display_name)}</button>`).join("");suggestions?.querySelectorAll<HTMLButtonElement>("button").forEach(b=>b.addEventListener("click",()=>{if(!isActive())return;const p=places[Number(b.dataset.place)];if(!p)return;selected={address:p.display_name,latitude:Number(p.lat),longitude:Number(p.lon)};if(address)address.value=p.display_name;if(suggestions)suggestions.replaceChildren();if(zillowField)zillowField.hidden=false;}));}catch{if(isActive()&&suggestions&&address.value.trim()===q)suggestions.textContent="Address suggestions are unavailable.";}},350);});
 document.querySelector<HTMLInputElement>("#zillow-property-url")?.addEventListener("input",event=>{if(done)done.disabled=!selected||!(event.currentTarget as HTMLInputElement).value.trim();});
 const propertyMessage=document.querySelector<HTMLElement>("#property-form-message");
 document.querySelector<HTMLFormElement>("#add-property-form")?.addEventListener("submit",async(event)=>{event.preventDefault();if(!isActive())return;const form=event.currentTarget as HTMLFormElement;const data=new FormData(form);const message=propertyMessage;const submit=form.querySelector<HTMLButtonElement>("button[type=submit]");if(submit)submit.disabled=true;try{const query=String(data.get("address")??"");const geo=await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`,{headers:{Accept:"application/json"}});const places=await geo.json() as Array<{display_name:string;lat:string;lon:string}>;if(!isActive())return;if(!places[0])throw new Error("Address not found.");const response=await fetch("/api/real-estate",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({address:places[0].display_name,latitude:Number(places[0].lat),longitude:Number(places[0].lon),zillowUrl:String(data.get("zillowUrl")??"")})});const result=await readJson(response);if(!isActive())return;if(!response.ok)throw new Error(getErrorMessage(result,"Unable to save property."));form.reset();if(message)message.textContent="Property added.";await refresh();}catch(error){if(isActive()&&message)message.textContent=error instanceof Error?error.message:"Unable to save property.";}finally{if(isActive()&&submit)submit.disabled=false;}});
 try{await refresh();}catch{if(!isActive())return;container.innerHTML=`<div class="accounts-error">We couldn't load properties. <button id="retry-real-estate" class="text-button" type="button">Try again</button></div>`;container.querySelector("#retry-real-estate")?.addEventListener("click",()=>{if(isActive())void initializeConnectionsPage(signal);});}
}
