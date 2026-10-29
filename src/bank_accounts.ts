export interface BankAccountsPageUser {
  displayName: string;
  username: string;
}

export interface BankAccount {
  id: string;
  itemId: string;
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
}

interface AccountsResponse {
  configured: boolean;
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character: string): string => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };

    return entities[character] ?? character;
  });
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
    typeof value.updatedAt === "string"
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
      const updatedAt: Date = new Date(group[0]?.updatedAt ?? "");
      const updateLabel: string = Number.isNaN(updatedAt.getTime())
        ? ""
        : `Account details retrieved ${escapeHtml(
            new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(updatedAt),
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
          `;
        })
        .join("");

      return `
        <section class="institution-card" aria-label="${institutionName} accounts">
          <header class="institution-heading">
            <div>
              <p class="eyebrow">CONNECTED INSTITUTION</p>
              <h2>${institutionName}</h2>
              <span class="institution-updated">${updateLabel}</span>
            </div>
            <button
              class="text-button disconnect-bank"
              type="button"
              data-item-id="${escapeHtml(itemId)}"
            >Disconnect</button>
          </header>
          <div class="connected-account-list">${accountRows}</div>
        </section>
      `;
    })
    .join("");
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
            <div class="account-row">
              <div class="account-icon checking" aria-hidden="true">▣</div>
              <div class="account-info">
                <strong>${escapeHtml(account.name)}</strong>
                <span>${escapeHtml(account.institutionName)}${accountType ? ` · ${escapeHtml(accountType)}` : ""}</span>
              </div>
              <strong class="account-balance">${escapeHtml(formatBalance(account.currentBalance, account.currencyCode))}</strong>
            </div>
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
    const setupNotice: HTMLParagraphElement | null =
      document.querySelector<HTMLParagraphElement>("#plaid-setup-notice");
    if (setupNotice) {
      setupNotice.hidden = payload.configured;
    }
    attachDisconnectHandlers();
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
        <div class="workspace-label">WORKSPACE</div>
        <nav class="navigation">
          <a class="nav-link" href="/dashboard">
            <span class="nav-icon" aria-hidden="true">◫</span> Overview
          </a>
          <a class="nav-link" href="/dashboard#transactions">
            <span class="nav-icon" aria-hidden="true">↕</span> Transactions
          </a>
          <a class="nav-link" href="/dashboard#budgets">
            <span class="nav-icon" aria-hidden="true">▤</span> Budgets
          </a>
          <a class="nav-link active" href="/accounts" aria-current="page">
            <span class="nav-icon" aria-hidden="true">▣</span> Accounts
          </a>
          <a class="nav-link" href="/settings">
            <span class="nav-icon" aria-hidden="true">⚙</span> Settings
          </a>
        </nav>
        <div class="sidebar-bottom">
          <div class="profile-avatar" aria-hidden="true">${initial}</div>
          <div class="profile-copy">
            <strong>${displayName}</strong>
            <span>@${username}</span>
          </div>
        </div>
      </aside>

      <main class="main-content accounts-content">
        <header class="topbar">
          <div class="breadcrumb">Workspace <span>/</span> Accounts</div>
          <div class="header-actions">
            <a class="settings-shortcut" href="/settings">Settings</a>
            <button class="text-button logout-button" type="button">Log out</button>
          </div>
        </header>
        <p id="accounts-message" class="auth-message" role="status" hidden></p>

        <section class="page-heading accounts-page-heading">
          <div>
            <p class="eyebrow">YOUR FINANCES</p>
            <h1>Accounts</h1>
            <p class="subheading">Bank accounts connected to your Finance profile.</p>
          </div>
          <button class="primary-button" id="connect-bank" type="button" hidden>
            <span aria-hidden="true">＋</span> Connect a bank
          </button>
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
            window. Finance stores encrypted account details and balances, but
            does not fetch or store transaction history.
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

export function initializeBankAccountsPage(): void {
  document
    .querySelector<HTMLButtonElement>("#connect-bank")
    ?.addEventListener("click", (): void => {
      void connectBank();
    });
  void refreshAccounts();
}
