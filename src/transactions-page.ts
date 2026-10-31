import { appVersion } from "./app-version.ts";
import { escapeHtml } from "./html-utils.ts";
import {
  filterAndSortTransactionGroups,
  getTransactionGroupAmount,
  type TransactionSortOrder,
} from "./transaction-filters.ts";
import {
  groupInternalTransfers,
  renderTransactionList,
  type TransactionRecord,
} from "./transaction-list.ts";
import type { BankAccount } from "./bank_accounts.ts";

export interface TransactionsPageUser {
  displayName: string;
  username: string;
}

interface TransactionsResponse {
  transactions: TransactionRecord[];
  accounts: BankAccount[];
  configured: boolean;
}

function formatFilterAmount(value: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function renderTransactionsPage(user: TransactionsPageUser): string {
  const displayName = escapeHtml(user.displayName);
  const username = escapeHtml(user.username);
  const initial = escapeHtml(user.displayName.charAt(0).toUpperCase() || "U");

  return `
    <div class="app-shell">
      <aside class="sidebar" aria-label="Main navigation">
        <a class="brand" href="/dashboard" aria-label="Finance home">
          <span class="brand-mark" aria-hidden="true">F</span><span>Finance</span>
        </a>
        <div class="workspace-label">WORKSPACE</div>
        <nav class="navigation">
          <a class="nav-link" href="/dashboard"><span class="nav-icon" aria-hidden="true">◫</span> Overview</a>
          <a class="nav-link active" href="/transactions" aria-current="page"><span class="nav-icon" aria-hidden="true">↕</span> Transactions</a>
          <a class="nav-link" href="/accounts"><span class="nav-icon" aria-hidden="true">▣</span> Accounts</a>
          <a class="nav-link" href="/settings"><span class="nav-icon" aria-hidden="true">⚙</span> Settings</a>
        </nav>
        <div class="sidebar-bottom">
          <div class="profile-avatar" aria-hidden="true">${initial}</div>
          <div class="profile-copy">
            <strong>${displayName}</strong>
            <span>@${username}</span>
            <span class="app-version">Version ${escapeHtml(appVersion)}</span>
          </div>
        </div>
      </aside>
      <main class="main-content transactions-content">
        <header class="topbar">
          <div class="breadcrumb">Workspace <span>/</span> Transactions</div>
          <div class="header-actions">
            <a class="settings-shortcut" href="/accounts">Accounts</a>
            <a class="settings-shortcut" href="/settings">Settings</a>
            <button class="text-button logout-button" type="button">Log out</button>
          </div>
        </header>
        <section class="page-heading transactions-page-heading">
          <div>
            <p class="eyebrow">ALL ACCOUNTS</p>
            <h1>Transactions</h1>
            <p class="subheading">Search your activity across every connected account.</p>
          </div>
          <button class="primary-button" id="sync-all-transactions" type="button">Sync transactions</button>
        </section>
        <p id="all-transactions-status" class="auth-message" role="status" aria-live="polite" hidden></p>

        <section class="panel transaction-filters" aria-labelledby="transaction-filters-title">
          <div class="panel-heading">
            <div><h2 id="transaction-filters-title">Filter and sort</h2><p>Adjust the results below.</p></div>
          </div>
          <div class="transaction-filter-grid">
            <fieldset class="transaction-account-filter">
              <legend>Include accounts</legend>
              <p>Show transactions involving any selected account. Leave unchecked to include all.</p>
              <div id="include-account-options" class="transaction-filter-account-list"><span>Loading accounts…</span></div>
            </fieldset>
            <fieldset class="transaction-account-filter">
              <legend>Exclude accounts</legend>
              <p>Excluded accounts take precedence; transfers involving an excluded account are hidden.</p>
              <div id="exclude-account-options" class="transaction-filter-account-list"><span>Loading accounts…</span></div>
            </fieldset>
            <fieldset class="transaction-amount-filter">
              <legend>Amount range</legend>
              <p>Amounts match the transaction list (spending is negative, income is positive); no currency conversion is applied.</p>
              <div class="transaction-amount-sliders">
                <label class="transaction-range-control" for="minimum-transaction-amount">
                  <span>Minimum <output id="minimum-transaction-amount-value">—</output></span>
                  <input id="minimum-transaction-amount" type="range" min="-1" max="1" step="0.01" value="-1" disabled />
                </label>
                <label class="transaction-range-control" for="maximum-transaction-amount">
                  <span>Maximum <output id="maximum-transaction-amount-value">—</output></span>
                  <input id="maximum-transaction-amount" type="range" min="-1" max="1" step="0.01" value="1" disabled />
                </label>
              </div>
            </fieldset>
            <label class="transaction-sort-control" for="transaction-sort-order">
              <span>Sort by</span>
              <select id="transaction-sort-order">
                <option value="date-desc">Date · newest first</option>
                <option value="date-asc">Date · oldest first</option>
                <option value="amount-desc">Amount · highest first</option>
                <option value="amount-asc">Amount · lowest first</option>
              </select>
            </label>
          </div>
        </section>

        <section class="panel transactions-results" aria-labelledby="all-transactions-title">
          <div class="panel-heading">
            <div><h2 id="all-transactions-title">All transactions</h2><p id="all-transactions-count" aria-live="polite">Loading transactions…</p></div>
          </div>
          <div id="all-transactions-list" class="transaction-empty" aria-live="polite">Loading transactions…</div>
        </section>
        <footer class="page-footer">Your finances, in focus.<span>Transactions across connected institutions</span></footer>
      </main>
    </div>
  `;
}

function renderAccountOptions(accounts: BankAccount[], mode: "include" | "exclude"): string {
  if (accounts.length === 0) return `<span class="transaction-filter-empty">No connected accounts.</span>`;
  return accounts.map((account) => {
    const mask = account.mask ? ` · •••• ${escapeHtml(account.mask)}` : "";
    const id = escapeHtml(account.id);
    return `
      <label class="transaction-filter-account">
        <input type="checkbox" data-account-filter="${mode}" value="${id}" />
        <span>${escapeHtml(account.institutionName)} · ${escapeHtml(account.name)}${mask}</span>
      </label>
    `;
  }).join("");
}

function getSelectedAccountIds(container: HTMLElement, mode: "include" | "exclude"): string[] {
  return [...container.querySelectorAll<HTMLInputElement>(`input[data-account-filter="${mode}"]:checked`)]
    .map((input) => input.value);
}

export function getTransactionAmountBounds(values: number[]): { minimum: number; maximum: number } {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return { minimum: -1, maximum: 1 };
  minimum = Math.floor(minimum * 100) / 100;
  maximum = Math.ceil(maximum * 100) / 100;
  if (minimum === maximum) {
    minimum -= 1;
    maximum += 1;
  }
  return { minimum, maximum };
}

function allTransactionAmountBounds(transactions: TransactionRecord[], accounts: BankAccount[]): { minimum: number; maximum: number } {
  const groups = groupInternalTransfers(transactions, accounts);
  const values = groups
    .map((group) => getTransactionGroupAmount(group))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return getTransactionAmountBounds(values);
}

export async function initializeTransactionsPage(): Promise<void> {
  const list = document.querySelector<HTMLDivElement>("#all-transactions-list");
  const count = document.querySelector<HTMLParagraphElement>("#all-transactions-count");
  const status = document.querySelector<HTMLParagraphElement>("#all-transactions-status");
  const includeOptions = document.querySelector<HTMLDivElement>("#include-account-options");
  const excludeOptions = document.querySelector<HTMLDivElement>("#exclude-account-options");
  const minimumInput = document.querySelector<HTMLInputElement>("#minimum-transaction-amount");
  const maximumInput = document.querySelector<HTMLInputElement>("#maximum-transaction-amount");
  const minimumOutput = document.querySelector<HTMLOutputElement>("#minimum-transaction-amount-value");
  const maximumOutput = document.querySelector<HTMLOutputElement>("#maximum-transaction-amount-value");
  const sortSelect = document.querySelector<HTMLSelectElement>("#transaction-sort-order");
  const syncButton = document.querySelector<HTMLButtonElement>("#sync-all-transactions");
  if (!list || !count || !includeOptions || !excludeOptions || !minimumInput || !maximumInput || !minimumOutput || !maximumOutput || !sortSelect) return;

  let accounts: BankAccount[] = [];
  let transactions: TransactionRecord[] = [];
  let minimumAmount = -1;
  let maximumAmount = 1;

  const renderResults = (): void => {
    if (!list || !count || !includeOptions || !excludeOptions || !minimumInput || !maximumInput || !sortSelect) return;
    const groups = groupInternalTransfers(transactions, accounts);
    const filtered = filterAndSortTransactionGroups(groups, accounts, {
      includeAccountIds: getSelectedAccountIds(includeOptions, "include"),
      excludeAccountIds: getSelectedAccountIds(excludeOptions, "exclude"),
      minimumAmount: Number(minimumInput.value),
      maximumAmount: Number(maximumInput.value),
      sort: sortSelect.value as TransactionSortOrder,
    });
    const filteredTransactions = filtered.flatMap((group) => group.transactions);
    const visibleTransactionCount = filtered.reduce((total, group) => total + group.transactions.length, 0);
    count.textContent = `Showing ${visibleTransactionCount} transaction${visibleTransactionCount === 1 ? "" : "s"} in ${filtered.length} row${filtered.length === 1 ? "" : "s"}`;
    if (filtered.length === 0) {
      list.className = "transaction-empty";
      list.textContent = transactions.length === 0
        ? "No transactions are available yet. Sync transactions to load activity."
        : "No transactions match these filters.";
      return;
    }
    list.className = "transaction-list all-transactions-list";
    list.innerHTML = renderTransactionList(filteredTransactions, accounts, { showAccount: true });
  };

  const updateAmountOutputs = (): void => {
    minimumOutput.value = formatFilterAmount(Number(minimumInput.value));
    maximumOutput.value = formatFilterAmount(Number(maximumInput.value));
  };

  const syncRangeBounds = (): void => {
    minimumInput.min = String(minimumAmount);
    minimumInput.max = String(maximumAmount);
    maximumInput.min = String(minimumAmount);
    maximumInput.max = String(maximumAmount);
    minimumInput.value = String(minimumAmount);
    maximumInput.value = String(maximumAmount);
    minimumInput.disabled = false;
    maximumInput.disabled = false;
    updateAmountOutputs();
  };

  const loadTransactions = async (): Promise<void> => {
    const response = await fetch("/api/accounts/transactions/all", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const payload = await response.json() as Partial<TransactionsResponse> & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Unable to load transactions.");
    if (!Array.isArray(payload.transactions) || !Array.isArray(payload.accounts)) {
      throw new Error("The server returned an invalid transactions response.");
    }
    transactions = payload.transactions;
    accounts = payload.accounts;
    includeOptions.innerHTML = renderAccountOptions(accounts, "include");
    excludeOptions.innerHTML = renderAccountOptions(accounts, "exclude");
    const bounds = allTransactionAmountBounds(transactions, accounts);
    minimumAmount = bounds.minimum;
    maximumAmount = bounds.maximum;
    syncRangeBounds();
    renderResults();
    if (payload.configured === false && status) {
      status.hidden = false;
      status.textContent = "Plaid is not configured. Add a secure bank connection to view synced transactions.";
    }
  };

  includeOptions.addEventListener("change", renderResults);
  excludeOptions.addEventListener("change", renderResults);
  sortSelect.addEventListener("change", renderResults);
  minimumInput.addEventListener("input", () => {
    if (Number(minimumInput.value) > Number(maximumInput.value)) maximumInput.value = minimumInput.value;
    updateAmountOutputs();
    renderResults();
  });
  maximumInput.addEventListener("input", () => {
    if (Number(maximumInput.value) < Number(minimumInput.value)) minimumInput.value = maximumInput.value;
    updateAmountOutputs();
    renderResults();
  });

  if (syncButton) {
    syncButton.addEventListener("click", async () => {
      syncButton.disabled = true;
      if (status) {
        status.hidden = false;
        status.classList.remove("error", "success");
        status.textContent = "Syncing transactions across connected accounts…";
      }
      try {
        const response = await fetch("/api/accounts/transactions/sync", {
          method: "POST",
          credentials: "same-origin",
        });
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Unable to sync transactions.");
        await loadTransactions();
        if (status) {
          status.textContent = "Transactions synced.";
          status.classList.add("success");
        }
      } catch (error) {
        if (status) {
          status.textContent = error instanceof Error ? error.message : "Unable to sync transactions.";
          status.classList.add("error");
        }
      } finally {
        syncButton.disabled = false;
      }
    });
  }

  try {
    await loadTransactions();
  } catch (error) {
    list.className = "transaction-empty";
    list.textContent = error instanceof Error ? error.message : "Unable to load transactions.";
    count.textContent = "Transactions could not be loaded";
  }
}
