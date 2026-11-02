import { appVersion } from "./app-version.ts";
import { escapeHtml } from "./html-utils.ts";
import { renderMainNavigation } from "./navigation.ts";
import { renderTransactionList } from "./transaction-list.ts";
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
  plaidAccountId?: string;
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
}

export interface PlaidConnection {
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

interface PlaidLinkExitError {
  display_message?: string | null;
}

interface PlaidLinkHandler {
  open(): void;
}

interface PlaidLinkOptions {
  token: string;
  onSuccess(publicToken: string): void;
  onExit(error: PlaidLinkExitError | null): void;
}

declare global {
  interface Window {
    Plaid?: {
      create(options: PlaidLinkOptions): PlaidLinkHandler;
    };
  }
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
    (!("plaidAccountId" in value) || typeof value.plaidAccountId === "string")
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
    ? renderTransactionList(transactions, accounts)
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
      <p class="account-detail-updated">Account details retrieved ${escapeHtml(updatedLabel)}</p>
    </section>
    <section class="panel account-detail-transactions">
      <div class="panel-heading"><div><h2>Transactions</h2><p>Recent activity for this account</p></div></div>
      <div class="account-transaction-list">${transactionRows}</div>
    </section>
  `;
}

export function renderAccounts(accounts: BankAccount[]): string {
  if (accounts.length === 0) {
    return `
      <div class="accounts-empty">
        <div class="empty-icon" aria-hidden="true">▣</div>
        <strong>No bank accounts connected</strong>
        <span>Connect an institution to see your accounts and balances here.</span>
      </div>
    `;
  }

  const groups: Map<string, BankAccount[]> = new Map();
  for (const account of accounts) {
    const group: BankAccount[] = groups.get(account.itemId) ?? [];
    group.push(account);
    groups.set(account.itemId, group);
  }

  return [...groups.entries()]
    .map(([itemId, group]): string => {
      const institutionName: string = escapeHtml(group[0]?.institutionName ?? "Bank");
      const lastRetrievedAt: Date = new Date(
        group[0]?.lastRetrievedAt ?? group[0]?.updatedAt ?? "",
      );
      const updateLabel: string = Number.isNaN(lastRetrievedAt.getTime())
        ? "Last retrieved time unavailable"
        : `Last retrieved ${escapeHtml(
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
              <p class="eyebrow">CONNECTED INSTITUTION</p>
              <h2>${institutionName}</h2>
            </div>
            <div class="institution-actions">
              <span class="institution-last-retrieved">${updateLabel}</span>
              <button class="icon-button sync-institution-button" type="button"
                aria-label="Synchronize ${institutionName}" title="Synchronize ${institutionName}"
                data-item-id="${escapeHtml(itemId)}" data-institution-name="${institutionName}">
                <svg class="sync-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16.3 8A6.5 6.5 0 0 0 5 4.8L3.5 6.3M3.5 6.3V2.8M3.5 6.3H7M3.7 12a6.5 6.5 0 0 0 11.3 3.2l1.5-1.5m0 0v3.5m0-3.5H13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <details class="institution-actions-menu">
                <summary class="icon-button menu-trigger" aria-label="More actions for ${institutionName}" title="More actions for ${institutionName}">
                  <span aria-hidden="true">⋯</span>
                </summary>
                <div class="institution-actions-menu-panel">
                  <button class="menu-item disconnect-bank" type="button" data-item-id="${escapeHtml(itemId)}">Disconnect</button>
                </div>
              </details>
            </div>
          </header>
          <div class="connected-account-list">${accountRows}</div>
        </section>
      `;
    })
    .join("");
}

export function renderConnections(connections: PlaidConnection[]): string {
  if (connections.length === 0) return `<div class="accounts-empty"><strong>No Plaid connections yet</strong><span>Connect an institution to see its integration here.</span></div>`;
  return connections.map((connection) => {
    const institutionName = escapeHtml(connection.institutionName);
    const retrieved = new Date(connection.lastRetrievedAt);
    const updateLabel = Number.isNaN(retrieved.getTime()) ? "Last retrieved time unavailable" : `Last retrieved ${escapeHtml(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(retrieved))}`;
    const accountRows = connection.accounts.map((account) => {
      const accountType = [account.type, account.subtype].filter((part): part is string => Boolean(part)).join(" · ");
      const mask = account.mask ? `•••• ${escapeHtml(account.mask)}` : "Account number hidden";
      return `<a class="connected-account-link" href="/accounts/${escapeHtml(encodeURIComponent(account.id))}"><article class="connected-account"><div class="connected-account-icon" aria-hidden="true">▣</div><div class="connected-account-info"><strong>${escapeHtml(account.name)}</strong><span>${escapeHtml(accountType)} · ${mask}</span></div><strong class="connected-account-balance${isLiabilityAccount(account) && account.currentBalance !== null ? " liability-balance" : ""}">${escapeHtml(formatAccountBalance(account))}</strong></article></a>`;
    }).join("");
    return `<details class="connection-card"><summary class="connection-heading"><span class="connected-account-icon" aria-hidden="true">↔</span><span class="connection-title"><span class="eyebrow">PLAID INTEGRATION</span><strong>${institutionName}</strong><span>${connection.accountCount} ${connection.accountCount === 1 ? "account" : "accounts"} · ${updateLabel}</span></span><span class="connection-chevron" aria-hidden="true">⌄</span></summary><div class="connection-accounts">${accountRows || `<p class="account-empty">No accounts are currently available from this integration.</p>`}</div></details>`;
  }).join("");
}

export function renderConnectionsPage(user: BankAccountsPageUser): string {
  const displayName = escapeHtml(user.displayName);
  const username = escapeHtml(user.username);
  const initial = escapeHtml(user.displayName.charAt(0).toUpperCase() || "U");
  return `<div class="app-shell"><aside class="sidebar" aria-label="Main navigation"><a class="brand" href="/dashboard" aria-label="Finance home"><span class="brand-mark" aria-hidden="true">F</span><span>Finance</span></a><button class="mobile-menu-toggle" type="button" aria-label="Open navigation menu" aria-expanded="false" aria-controls="main-navigation"><span aria-hidden="true">☰</span></button><div class="mobile-menu-panel"><div class="workspace-label">WORKSPACE</div>${renderMainNavigation("connections")}<div class="sidebar-bottom"><div class="profile-avatar" aria-hidden="true">${initial}</div><div class="profile-copy"><strong>${displayName}</strong><span>@${username}</span><span class="app-version">Version ${escapeHtml(appVersion)}</span></div></div></div></aside><main class="main-content accounts-content"><section class="page-heading accounts-page-heading"><div><p class="eyebrow">YOUR FINANCES</p><h1>Connections</h1><p class="subheading">Plaid integrations and the accounts they provide.</p></div></section><div id="connected-integrations" class="connected-accounts" aria-live="polite"><div class="panel accounts-loading">Loading your connections…</div></div><footer class="page-footer">Your finances, in focus.<span>Bank connections provided by Plaid</span></footer></main></div>`;
}

export function renderOverviewBankAccounts(accounts: BankAccount[]): string {
  const container: string = accounts.length === 0
    ? `<div class="account-empty">
        <span>No bank accounts connected yet.</span>
        <a class="text-button" href="/accounts">Connect an account <span aria-hidden="true">→</span></a>
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

export async function initializeOverviewBankAccounts(): Promise<void> {
  const container: HTMLDivElement | null =
    document.querySelector<HTMLDivElement>("#overview-bank-accounts");
  if (!container) {
    return;
  }

  const totalBalanceElement: HTMLDivElement | null =
    document.querySelector<HTMLDivElement>("#overview-total-balance");

  try {
    const response: Response = await fetch("/api/accounts", {
      cache: "no-store",
    });
    const payload: unknown = await readJson(response);
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
        void initializeOverviewBankAccounts();
      });
  }
}

function setAccountsMessage(message: string, isError: boolean): void {
  const element: HTMLParagraphElement | null =
    document.querySelector<HTMLParagraphElement>("#accounts-message");
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

async function loadPlaidLink(): Promise<void> {
  if (window.Plaid) {
    return;
  }

  await new Promise<void>((resolve, reject): void => {
    const script: HTMLScriptElement = document.createElement("script");
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.async = true;
    script.onload = (): void => resolve();
    script.onerror = (): void =>
      reject(new Error("Plaid Link could not be loaded. Check your connection and try again."));
    document.head.append(script);
  });

  if (!window.Plaid) {
    throw new Error("Plaid Link did not initialize correctly.");
  }
}

async function refreshAccounts(): Promise<void> {
  const container: HTMLDivElement | null =
    document.querySelector<HTMLDivElement>("#connected-accounts");
  const connectButton: HTMLButtonElement | null =
    document.querySelector<HTMLButtonElement>("#connect-bank");
  const syncAllButton: HTMLButtonElement | null =
    document.querySelector<HTMLButtonElement>("#sync-all-institutions");
  if (!container) {
    return;
  }

  try {
    const response: Response = await fetch("/api/accounts", {
      cache: "no-store",
    });
    const payload: unknown = await readJson(response);

    if (!response.ok) {
      throw new Error(
        getErrorMessage(payload, "Unable to load bank accounts."),
      );
    }
    if (!isAccountsResponse(payload)) {
      throw new Error("The server returned an invalid bank-account response.");
    }

    container.innerHTML = renderAccounts(payload.accounts);
    if (connectButton) {
      connectButton.disabled = !payload.configured;
      connectButton.hidden = !payload.configured;
    }
    if (syncAllButton) {
      syncAllButton.hidden = !payload.configured || payload.accounts.length === 0;
      syncAllButton.disabled = syncAllButton.hidden;
    }
    const setupNotice: HTMLParagraphElement | null =
      document.querySelector<HTMLParagraphElement>("#plaid-setup-notice");
    if (setupNotice) {
      setupNotice.hidden = payload.configured;
    }
    attachDisconnectHandlers();
    attachInstitutionSyncHandlers();
  } catch (error: unknown) {
    container.innerHTML = `
      <div class="accounts-error">
        <strong>We couldn't load your bank accounts.</strong>
        <button class="text-button" id="retry-accounts" type="button">Try again</button>
      </div>
    `;
    container
      .querySelector<HTMLButtonElement>("#retry-accounts")
      ?.addEventListener("click", (): void => {
        void refreshAccounts();
      });
    setAccountsMessage(
      error instanceof Error ? error.message : "Unable to load bank accounts.",
      true,
    );
  }
}

function attachDisconnectHandlers(): void {
  document
    .querySelectorAll<HTMLButtonElement>(".disconnect-bank")
    .forEach((button): void => {
      button.addEventListener("click", async (): Promise<void> => {
        const itemId: string | undefined = button.dataset["itemId"];
        if (
          !itemId ||
          !window.confirm(
            "Disconnect this institution? Its saved account details will be removed from Finance.",
          )
        ) {
          return;
        }

        button.disabled = true;
        setAccountsMessage("", false);
        try {
          const response: Response = await fetch(
            `/api/accounts/items/${encodeURIComponent(itemId)}`,
            { method: "DELETE" },
          );
          const payload: unknown = await readJson(response);
          if (!response.ok) {
            throw new Error(
              getErrorMessage(payload, "Unable to disconnect the institution."),
            );
          }
          setAccountsMessage("Institution disconnected.", false);
          await refreshAccounts();
        } catch (error: unknown) {
          button.disabled = false;
          setAccountsMessage(
            error instanceof Error
              ? error.message
              : "Unable to disconnect the institution.",
            true,
          );
        }
      });
    });
}

function attachInstitutionSyncHandlers(): void {
  document
    .querySelectorAll<HTMLButtonElement>(".sync-institution-button")
    .forEach((button): void => {
      button.addEventListener("click", async (): Promise<void> => {
        const itemId = button.dataset["itemId"];
        const institutionName = button.dataset["institutionName"] ?? "institution";
        if (!itemId) return;

        button.disabled = true;
        setAccountsMessage(`Syncing ${institutionName}…`, false);
        try {
          const response = await fetch(
            `/api/accounts/items/${encodeURIComponent(itemId)}/transactions/sync`,
            { method: "POST", credentials: "same-origin" },
          );
          const payload: unknown = await readJson(response);
          if (!response.ok) {
            throw new Error(getErrorMessage(payload, `Unable to sync ${institutionName}.`));
          }
          setAccountsMessage(`${institutionName} synchronized.`, false);
          await refreshAccounts();
        } catch (error: unknown) {
          setAccountsMessage(
            error instanceof Error ? error.message : `Unable to sync ${institutionName}.`,
            true,
          );
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
    });
}

async function syncAllInstitutions(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  setAccountsMessage("Syncing all connected institutions…", false);
  try {
    const response = await fetch("/api/accounts/transactions/sync", {
      method: "POST",
      credentials: "same-origin",
    });
    const payload: unknown = await readJson(response);
    if (!response.ok) {
      throw new Error(getErrorMessage(payload, "Unable to sync connected institutions."));
    }
    setAccountsMessage("All connected institutions synchronized.", false);
    await refreshAccounts();
  } catch (error: unknown) {
    setAccountsMessage(
      error instanceof Error ? error.message : "Unable to sync connected institutions.",
      true,
    );
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function completePlaidConnection(publicToken: string): Promise<void> {
  const connectButton: HTMLButtonElement | null =
    document.querySelector<HTMLButtonElement>("#connect-bank");
  if (connectButton) {
    connectButton.disabled = true;
    connectButton.textContent = "Saving connected accounts…";
  }

  try {
    const response: Response = await fetch("/api/accounts/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicToken }),
    });
    const payload: unknown = await readJson(response);
    if (!response.ok) {
      throw new Error(
        getErrorMessage(payload, "Unable to save the bank connection."),
      );
    }

    setAccountsMessage("Your bank accounts are connected.", false);
    await refreshAccounts();
  } catch (error: unknown) {
    setAccountsMessage(
      error instanceof Error
        ? error.message
        : "Unable to save the bank connection.",
      true,
    );
  } finally {
    if (connectButton) {
      connectButton.disabled = false;
      connectButton.innerHTML = `<span aria-hidden="true">＋</span> Connect a bank`;
    }
  }
}

async function connectBank(): Promise<void> {
  const button: HTMLButtonElement | null =
    document.querySelector<HTMLButtonElement>("#connect-bank");
  if (!button) {
    return;
  }

  button.disabled = true;
  button.textContent = "Preparing secure connection…";
  setAccountsMessage("", false);

  try {
    const response: Response = await fetch("/api/accounts/link-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const payload: unknown = await readJson(response);
    if (
      !response.ok ||
      typeof payload !== "object" ||
      payload === null ||
      !("linkToken" in payload) ||
      typeof payload.linkToken !== "string"
    ) {
      throw new Error(
        getErrorMessage(payload, "Unable to start a secure bank connection."),
      );
    }

    await loadPlaidLink();
    if (!window.Plaid) {
      throw new Error("Plaid Link did not initialize correctly.");
    }

    const handler: PlaidLinkHandler = window.Plaid.create({
      token: payload.linkToken,
      onSuccess: (publicToken: string): void => {
        void completePlaidConnection(publicToken);
      },
      onExit: (error: PlaidLinkExitError | null): void => {
        if (error?.display_message) {
          setAccountsMessage(error.display_message, true);
        }
        button.disabled = false;
        button.innerHTML = `<span aria-hidden="true">＋</span> Connect a bank`;
      },
    });
    handler.open();
  } catch (error: unknown) {
    button.disabled = false;
    button.innerHTML = `<span aria-hidden="true">＋</span> Connect a bank`;
    setAccountsMessage(
      error instanceof Error
        ? error.message
        : "Unable to start a secure bank connection.",
      true,
    );
  }
}

export function renderBankAccountsPage(user: BankAccountsPageUser): string {
  const displayName: string = escapeHtml(user.displayName);
  const username: string = escapeHtml(user.username);
  const initial: string = escapeHtml(user.displayName.charAt(0).toUpperCase() || "U");

  return `
    <div class="app-shell">
      <aside class="sidebar" aria-label="Main navigation">
        <a class="brand" href="/dashboard" aria-label="Finance home">
          <span class="brand-mark" aria-hidden="true">F</span>
          <span>Finance</span>
        </a>
        <button class="mobile-menu-toggle" type="button" aria-label="Open navigation menu" aria-expanded="false" aria-controls="main-navigation"><span aria-hidden="true">☰</span></button>
        <div class="mobile-menu-panel">
        <div class="workspace-label">WORKSPACE</div>
        ${renderMainNavigation("accounts")}
        <div class="sidebar-bottom">
          <div class="profile-avatar" aria-hidden="true">${initial}</div>
          <div class="profile-copy">
            <strong>${displayName}</strong>
            <span>@${username}</span>
            <span class="app-version">Version ${escapeHtml(appVersion)}</span>

          </div>
        </div>
        </div>
      </aside>

      <main class="main-content accounts-content">

        <p id="accounts-message" class="auth-message" role="status" hidden></p>

        <section class="page-heading accounts-page-heading">
          <div>
            <p class="eyebrow">YOUR FINANCES</p>
            <h1>Accounts</h1>
            <p class="subheading">Bank accounts connected to your Finance profile.</p>
          </div>
          <div class="accounts-page-actions">
            <button class="secondary-button sync-all-button" id="sync-all-institutions" type="button" hidden>
              <svg class="sync-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16.3 8A6.5 6.5 0 0 0 5 4.8L3.5 6.3M3.5 6.3V2.8M3.5 6.3H7M3.7 12a6.5 6.5 0 0 0 11.3 3.2l1.5-1.5m0 0v3.5m0-3.5H13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Sync all
            </button>
            <button class="primary-button" id="connect-bank" type="button" hidden>
              <span aria-hidden="true">＋</span> Connect a bank
            </button>
          </div>
        </section>

        <section class="panel plaid-setup-notice" id="plaid-setup-notice" hidden>
          <h2>Secure bank connections</h2>
          <p>
            Add your Plaid Sandbox credentials and a private encryption key to the
            server environment to enable bank linking. Your bank sign-in is handled
            by Plaid and is never stored by Finance.
          </p>
        </section>

        <section class="panel account-data-notice">
          <strong>Your data, kept to what this page needs</strong>
          <p>
            Plaid Link requests the Transactions product with a 30-day history
            window. You can manually sync transaction history from the dashboard.
            Finance stores transaction details and sync cursors encrypted at rest,
            along with encrypted account details and balances.
          </p>
        </section>

        <div id="connected-accounts" class="connected-accounts" aria-live="polite">
          <div class="panel accounts-loading">Loading your connected accounts…</div>
        </div>

        <footer class="page-footer">
          Your finances, in focus.
          <span>Bank connections provided by Plaid</span>
        </footer>
      </main>
    </div>
  `;
}

export function renderBankAccountDetailPage(user: BankAccountsPageUser): string {
  const displayName = escapeHtml(user.displayName);
  const username = escapeHtml(user.username);
  const initial = escapeHtml(user.displayName.charAt(0).toUpperCase() || "U");

  return `
    <div class="app-shell">
      <aside class="sidebar" aria-label="Main navigation">
        <a class="brand" href="/dashboard" aria-label="Finance home">
          <span class="brand-mark" aria-hidden="true">F</span><span>Finance</span>
        </a>
        <button class="mobile-menu-toggle" type="button" aria-label="Open navigation menu" aria-expanded="false" aria-controls="main-navigation"><span aria-hidden="true">☰</span></button>
        <div class="mobile-menu-panel">
        <div class="workspace-label">WORKSPACE</div>
        ${renderMainNavigation("accounts")}
        <div class="sidebar-bottom">
          <div class="profile-avatar" aria-hidden="true">${initial}</div>
          <div class="profile-copy"><strong>${displayName}</strong><span>@${username}</span><span class="app-version">Version ${escapeHtml(appVersion)}</span></div>
        </div>
        </div>
      </aside>
      <main class="main-content accounts-content">

        <section class="page-heading accounts-page-heading">
          <div><p class="eyebrow">CONNECTED ACCOUNT</p><h1>Account details</h1><p class="subheading">A current snapshot and recent activity for this account.</p></div>
          <div class="account-detail-actions">
            <a class="text-button account-all-link" href="/accounts">All accounts</a>
            <button class="primary-button" id="sync-account-transactions" type="button">Sync transactions</button>
          </div>
        </section>
        <p id="account-transaction-status" class="auth-message" role="status" aria-live="polite" hidden></p>
        <div id="account-detail-content" class="account-detail-content" aria-live="polite">
          <div class="panel accounts-loading">Loading account details and transactions…</div>
        </div>
        <footer class="page-footer">Your finances, in focus.<span>Bank connections provided by Plaid</span></footer>
      </main>
    </div>
  `;
}

export async function initializeAccountDetailPage(accountId: string): Promise<void> {
  const container = document.querySelector<HTMLDivElement>("#account-detail-content");
  if (!container) return;

  const syncButton = document.querySelector<HTMLButtonElement>("#sync-account-transactions");
  const syncStatus = document.querySelector<HTMLParagraphElement>("#account-transaction-status");
  if (syncButton && syncButton.dataset["handlerAttached"] !== "true") {
    syncButton.dataset["handlerAttached"] = "true";
    syncButton.addEventListener("click", async (): Promise<void> => {
      syncButton.disabled = true;
      if (syncStatus) {
        syncStatus.hidden = false;
        syncStatus.classList.remove("error", "success");
        syncStatus.textContent = "Syncing transactions for connected accounts…";
      }
      try {
        const response = await fetch("/api/accounts/transactions/sync", {
          method: "POST",
          credentials: "same-origin",
        });
        const payload: unknown = await readJson(response);
        if (!response.ok) {
          throw new Error(getErrorMessage(payload, "Unable to sync transactions."));
        }
        await initializeAccountDetailPage(accountId);
        if (syncStatus) {
          syncStatus.textContent = "Transactions synced.";
          syncStatus.classList.add("success");
        }
      } catch (error: unknown) {
        if (syncStatus) {
          syncStatus.textContent = error instanceof Error ? error.message : "Unable to sync transactions.";
          syncStatus.classList.add("error");
        }
      } finally {
        syncButton.disabled = false;
      }
    });
  }

  try {
    const response = await fetch(
      `/api/accounts/${encodeURIComponent(accountId)}/transactions`,
      { cache: "no-store", credentials: "same-origin" },
    );
    const payload: unknown = await readJson(response);
    if (!response.ok || !isAccountDetailResponse(payload)) {
      throw new Error(getErrorMessage(payload, "Unable to load this account."));
    }
    container.innerHTML = renderAccountDetail(payload.account, payload.transactions, payload.accounts);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unable to load this account.";
    container.innerHTML = `
      <section class="panel account-detail-error" role="alert">
        <strong>This account could not be loaded.</strong>
        <span>${escapeHtml(message)}</span>
        <a class="text-button" href="/accounts">Back to accounts</a>
      </section>
    `;
  }
}

export function initializeBankAccountsPage(): void {
  document
    .querySelector<HTMLButtonElement>("#connect-bank")
    ?.addEventListener("click", (): void => {
      void connectBank();
    });
  const syncAllButton = document.querySelector<HTMLButtonElement>("#sync-all-institutions");
  syncAllButton?.addEventListener("click", (): void => {
    void syncAllInstitutions(syncAllButton);
  });
  void refreshAccounts();
}

export async function initializeConnectionsPage(): Promise<void> {
  const container = document.querySelector<HTMLDivElement>("#connected-integrations");
  if (!container) return;
  try {
    const response = await fetch("/api/accounts/items", { cache: "no-store", credentials: "same-origin" });
    const payload: unknown = await readJson(response);
    if (!response.ok || typeof payload !== "object" || payload === null || !("connections" in payload) || !Array.isArray(payload.connections)) {
      throw new Error(getErrorMessage(payload, "Unable to load Plaid connections."));
    }
    container.innerHTML = renderConnections(payload.connections as PlaidConnection[]);
  } catch {
    container.innerHTML = `<div class="accounts-error"><strong>We couldn't load your connections.</strong><button class="text-button" id="retry-connections" type="button">Try again</button></div>`;
    container.querySelector<HTMLButtonElement>("#retry-connections")?.addEventListener("click", () => void initializeConnectionsPage());
  }
}
