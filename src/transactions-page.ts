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
          <div class="transaction-filter-toolbar">
            <span id="transaction-filters-title" class="transaction-filter-label">Filter</span>
            <div class="transaction-filter-controls">
              <div class="transaction-filter-anchor">
                <button class="transaction-filter-trigger" id="accounts-filter-trigger" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="accounts-filter-popover">
                  Accounts: <span id="accounts-filter-total">0</span><span class="transaction-trigger-summary" id="accounts-filter-summary">All accounts</span><span class="transaction-trigger-chevron" aria-hidden="true">▾</span>
                </button>
                <div class="transaction-filter-popover accounts-filter-popover" id="accounts-filter-popover" role="dialog" aria-label="Filter by account" hidden>
                  <div class="transaction-popover-heading">
                    <strong>Accounts</strong>
                    <button class="transaction-popover-close" id="close-accounts-filter" type="button" aria-label="Close account filters">×</button>
                  </div>
                  <label class="transaction-popover-mode" for="account-filter-mode">
                    <span>Show transactions</span>
                    <select id="account-filter-mode">
                      <option value="include">from selected accounts</option>
                      <option value="exclude">not from selected accounts</option>
                    </select>
                  </label>
                  <div class="transaction-popover-actions">
                    <button id="select-all-accounts" type="button">Select all</button>
                    <button id="deselect-all-accounts" type="button">Deselect all</button>
                  </div>
                  <p class="transaction-popover-help">Select one or more accounts. Transfers involving an excluded account are hidden.</p>
                  <div id="account-options" class="transaction-filter-account-list"><span>Loading accounts…</span></div>
                </div>
              </div>
              <div class="transaction-filter-anchor">
                <button class="transaction-filter-trigger" id="amount-filter-trigger" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="amount-filter-popover">
                  Amount: <span id="amount-filter-summary">Any</span><span class="transaction-trigger-chevron" aria-hidden="true">▾</span>
                </button>
                <div class="transaction-filter-popover amount-filter-popover" id="amount-filter-popover" role="dialog" aria-label="Filter by amount" hidden>
                  <div class="transaction-popover-heading">
                    <strong>Amount range</strong>
                    <button class="transaction-popover-close" id="close-amount-filter" type="button" aria-label="Close amount filters">×</button>
                  </div>
                  <p class="transaction-popover-help">Amounts match the transaction list (spending is negative, income is positive); no currency conversion is applied.</p>
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
                </div>
              </div>
              <label class="transaction-sort-control" for="transaction-sort-order">
                <span>Sort</span>
                <select id="transaction-sort-order">
                  <option value="date-desc">Date · newest</option>
                  <option value="date-asc">Date · oldest</option>
                  <option value="amount-desc">Amount · highest</option>
                  <option value="amount-asc">Amount · lowest</option>
                </select>
              </label>
            </div>
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

function renderAccountOptions(accounts: BankAccount[]): string {
  if (accounts.length === 0) return `<span class="transaction-filter-empty">No connected accounts.</span>`;
  return accounts.map((account) => {
    const mask = account.mask ? ` · •••• ${escapeHtml(account.mask)}` : "";
    const id = escapeHtml(account.id);
    return `
      <label class="transaction-filter-account">
        <input type="checkbox" data-account-filter value="${id}" />
        <span>${escapeHtml(account.institutionName)} · ${escapeHtml(account.name)}${mask}</span>
      </label>
    `;
  }).join("");
}

function getSelectedAccountIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLInputElement>("input[data-account-filter]:checked")]
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
  const accountOptions = document.querySelector<HTMLDivElement>("#account-options");
  const accountTrigger = document.querySelector<HTMLButtonElement>("#accounts-filter-trigger");
  const accountTriggerSummary = document.querySelector<HTMLSpanElement>("#accounts-filter-summary");
  const accountTotal = document.querySelector<HTMLSpanElement>("#accounts-filter-total");
  const accountPopover = document.querySelector<HTMLDivElement>("#accounts-filter-popover");
  const accountMode = document.querySelector<HTMLSelectElement>("#account-filter-mode");
  const selectAllAccounts = document.querySelector<HTMLButtonElement>("#select-all-accounts");
  const deselectAllAccounts = document.querySelector<HTMLButtonElement>("#deselect-all-accounts");
  const closeAccountsFilter = document.querySelector<HTMLButtonElement>("#close-accounts-filter");
  const amountTrigger = document.querySelector<HTMLButtonElement>("#amount-filter-trigger");
  const amountTriggerSummary = document.querySelector<HTMLSpanElement>("#amount-filter-summary");
  const amountPopover = document.querySelector<HTMLDivElement>("#amount-filter-popover");
  const closeAmountFilter = document.querySelector<HTMLButtonElement>("#close-amount-filter");
  const minimumInput = document.querySelector<HTMLInputElement>("#minimum-transaction-amount");
  const maximumInput = document.querySelector<HTMLInputElement>("#maximum-transaction-amount");
  const minimumOutput = document.querySelector<HTMLOutputElement>("#minimum-transaction-amount-value");
  const maximumOutput = document.querySelector<HTMLOutputElement>("#maximum-transaction-amount-value");
  const sortSelect = document.querySelector<HTMLSelectElement>("#transaction-sort-order");
  const syncButton = document.querySelector<HTMLButtonElement>("#sync-all-transactions");
  if (!list || !count || !accountOptions || !accountTrigger || !accountTriggerSummary || !accountTotal || !accountPopover || !accountMode || !selectAllAccounts || !deselectAllAccounts || !closeAccountsFilter || !amountTrigger || !amountTriggerSummary || !amountPopover || !closeAmountFilter || !minimumInput || !maximumInput || !minimumOutput || !maximumOutput || !sortSelect) return;

  let accounts: BankAccount[] = [];
  let transactions: TransactionRecord[] = [];
  let minimumAmount = -1;
  let maximumAmount = 1;

  const updateAccountSummary = (): void => {
    const selectedCount = getSelectedAccountIds(accountOptions).length;
    accountTriggerSummary.textContent = selectedCount === 0
      ? "All accounts"
      : `${selectedCount} ${accountMode.value === "exclude" ? "excluded" : "selected"}`;
  };

  const updateAmountSummary = (): void => {
    const minimum = Number(minimumInput.value);
    const maximum = Number(maximumInput.value);
    const isFullRange = minimum <= minimumAmount && maximum >= maximumAmount;
    amountTriggerSummary.textContent = isFullRange
      ? "Any"
      : `${formatFilterAmount(minimum)}–${formatFilterAmount(maximum)}`;
  };

  const closeFilterPopovers = (): void => {
    accountPopover.hidden = true;
    amountPopover.hidden = true;
    accountPopover.style.transform = "";
    amountPopover.style.transform = "";
    accountTrigger.setAttribute("aria-expanded", "false");
    amountTrigger.setAttribute("aria-expanded", "false");
  };

  const toggleFilterPopover = (trigger: HTMLButtonElement, popover: HTMLDivElement): void => {
    const shouldOpen = popover.hidden;
    closeFilterPopovers();
    if (shouldOpen) {
      popover.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      const bounds = popover.getBoundingClientRect();
      const horizontalShift = bounds.right > window.innerWidth - 8
        ? window.innerWidth - 8 - bounds.right
        : bounds.left < 8 ? 8 - bounds.left : 0;
      if (horizontalShift !== 0) popover.style.transform = `translateX(${horizontalShift}px)`;
    }
  };

  const renderResults = (): void => {
    const selectedAccountIds = getSelectedAccountIds(accountOptions);
    const isIncluding = accountMode.value === "include";
    const groups = groupInternalTransfers(transactions, accounts);
    const filtered = filterAndSortTransactionGroups(groups, accounts, {
      includeAccountIds: isIncluding ? selectedAccountIds : [],
      excludeAccountIds: isIncluding ? [] : selectedAccountIds,
      minimumAmount: Number(minimumInput.value),
      maximumAmount: Number(maximumInput.value),
      sort: sortSelect.value as TransactionSortOrder,
    });
    const filteredTransactions = filtered.flatMap((group) => group.transactions);
    const visibleTransactionCount = filtered.reduce((total, group) => total + group.transactions.length, 0);
    count.textContent = `Showing ${visibleTransactionCount} transaction${visibleTransactionCount === 1 ? "" : "s"} in ${filtered.length} row${filtered.length === 1 ? "" : "s"}`;
    updateAccountSummary();
    updateAmountSummary();
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
    const previousAccountIds = getSelectedAccountIds(accountOptions);
    const previousAccountMode = accountMode.value;
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
    accountTotal.textContent = String(accounts.length);
    accountOptions.innerHTML = renderAccountOptions(accounts);
    const previousAccountIdSet = new Set(previousAccountIds);
    for (const input of accountOptions.querySelectorAll<HTMLInputElement>("input[data-account-filter]")) {
      input.checked = previousAccountIdSet.has(input.value);
    }
    accountMode.value = previousAccountMode;
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

  accountTrigger.addEventListener("click", () => toggleFilterPopover(accountTrigger, accountPopover));
  amountTrigger.addEventListener("click", () => toggleFilterPopover(amountTrigger, amountPopover));
  closeAccountsFilter.addEventListener("click", () => {
    closeFilterPopovers();
    accountTrigger.focus();
  });
  closeAmountFilter.addEventListener("click", () => {
    closeFilterPopovers();
    amountTrigger.focus();
  });
  selectAllAccounts.addEventListener("click", () => {
    for (const input of accountOptions.querySelectorAll<HTMLInputElement>("input[data-account-filter]")) input.checked = true;
    renderResults();
  });
  deselectAllAccounts.addEventListener("click", () => {
    for (const input of accountOptions.querySelectorAll<HTMLInputElement>("input[data-account-filter]")) input.checked = false;
    renderResults();
  });
  accountOptions.addEventListener("change", renderResults);
  accountMode.addEventListener("change", renderResults);
  sortSelect.addEventListener("change", renderResults);
  document.addEventListener("click", (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (!accountPopover.contains(target) && !accountTrigger.contains(target) && !amountPopover.contains(target) && !amountTrigger.contains(target)) {
      closeFilterPopovers();
    }
  });
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape" && (!accountPopover.hidden || !amountPopover.hidden)) {
      const accountWasOpen = !accountPopover.hidden;
      closeFilterPopovers();
      (accountWasOpen ? accountTrigger : amountTrigger).focus();
    }
  });
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
