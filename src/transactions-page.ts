import { renderAppNavigation } from "./navigation.ts";
import { escapeHtml } from "./html-utils.ts";
import {
  filterAndSortTransactionGroups,
  clampTransactionAmountRange,
  getAccountSelectionOnLoad,
  getFuzzyMatchPositions,
  getTransactionGroupAmount,
  parseAmountRangeInput,
  reconcileAmountRangeInput,
  renderFuzzyHighlightedText,
  updateSelectedAccountIds,
  updateTransactionAmountRange,
  type TransactionSortOrder,
} from "./transaction-filters.ts";
import {
  groupInternalTransfers,
  renderTransactionGroups,
  type TransactionGroup,
  type TransactionRecord,
} from "./transaction-list.ts";
import type { BankAccount } from "./bank_accounts.ts";
import { initializeBatchImport, renderBatchImportDialog } from "./batch-import.ts";

export interface TransactionsPageUser {
  displayName: string;
  username: string;
}

interface TransactionsResponse {
  transactions: TransactionRecord[];
  accounts: BankAccount[];
  configured: boolean;
}

export function formatFilterAmount(value: number): string {
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));
  return `${value < 0 ? "-" : ""}$${formatted}`;
}

export function renderTransactionsPage(user: TransactionsPageUser): string {
  return `
    <div class="app-shell">
      ${renderAppNavigation(user, "transactions")}
      <main class="main-content transactions-content">

        <div id="transaction-desktop-heading"></div>
        <p id="all-transactions-status" class="bank-data-notice" role="status" aria-live="polite" hidden></p>
        <div class="transactions-workspace">
        <div class="transactions-sticky-controls">
        <div id="transaction-mobile-heading">
        <section class="page-heading transactions-page-heading">
          <div>
            <p class="eyebrow"><span class="transaction-desktop-only">ALL ACCOUNTS</span><span class="transaction-mobile-only">YOUR MONEY, IN MOTION</span></p>
            <h1>Transactions</h1>
            <p class="subheading transaction-desktop-only">Search saved activity across your accounts.</p>
          </div>
          <div class="transaction-heading-actions">
            <button class="transaction-icon-button" id="transaction-filters-trigger" type="button" aria-label="Filter transactions" title="Filter transactions" aria-haspopup="dialog" aria-controls="transaction-filters-dialog" aria-expanded="false" disabled>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18l-7 8v7l-4 2v-9Z" /></svg>
            </button>
            <button class="transaction-icon-button" id="transaction-sort-trigger" type="button" aria-label="Sort transactions" title="Sort transactions" aria-haspopup="dialog" aria-controls="transaction-sort-dialog" aria-expanded="false" disabled>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4v16m-4-4 4 4 4-4M15 5h6m-6 5h4m-4 5h2" /></svg>
            </button>
            <button id="open-batch-import" class="primary-button transaction-icon-button transactions-import-button" type="button" aria-label="Import transactions" title="Import transactions">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m-4 4 4-4 4 4M4 15v5h16v-5" /></svg>
              <span class="transaction-import-label">Import Transactions</span>
            </button>
          </div>
        </section>
        </div>
        <section id="transaction-desktop-toolbar" class="panel transaction-filters" aria-label="Transaction filters">
          <div class="transaction-filter-toolbar">
            <span class="transaction-filter-label">Filter</span>
            <div class="transaction-filter-controls">
              <div class="transaction-filter-anchor">
                <button class="transaction-filter-trigger" id="accounts-filter-trigger" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="accounts-filter-popover" disabled>
                  Accounts: <span id="desktop-accounts-filter-summary">0 / 0 selected</span><span class="transaction-trigger-chevron" aria-hidden="true">▾</span>
                </button>
                <div class="transaction-filter-popover accounts-filter-popover" id="accounts-filter-popover" role="dialog" aria-label="Filter by account" hidden>
                  <div class="transaction-popover-heading"><strong>Accounts</strong><button class="transaction-popover-close" id="close-accounts-filter" type="button" aria-label="Close account filters">×</button></div>
                </div>
              </div>
              <div class="transaction-filter-anchor">
                <button class="transaction-filter-trigger" id="amount-filter-trigger" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="amount-filter-popover" disabled>
                  Amount: <span id="desktop-amount-filter-summary">Any</span><span class="transaction-trigger-chevron" aria-hidden="true">▾</span>
                </button>
                <div class="transaction-filter-popover amount-filter-popover" id="amount-filter-popover" role="dialog" aria-label="Filter by amount" hidden>
                  <div class="transaction-popover-heading"><strong>Amount range</strong><button class="transaction-popover-close" id="close-amount-filter" type="button" aria-label="Close amount filters">×</button></div>
                </div>
              </div>
              <div id="transaction-desktop-sort"></div>
            </div>
            <div id="transaction-desktop-import"></div>
          </div>
        </section>
        <div class="transaction-activity-status">
          <span id="transaction-activity-count">Loading activity…</span>
          <span id="transaction-sort-summary">Newest first</span>
        </div>
        <p id="all-transactions-count" class="transaction-results-status" aria-live="polite">Loading transactions…</p>
        </div>
        <section class="panel transactions-results" aria-label="Transactions">
          <div id="all-transactions-list" class="transaction-empty">Loading transactions…</div>
          <div id="transactions-scroll-sentinel" class="transaction-scroll-sentinel" aria-hidden="true" hidden></div>
        </section>
        </div>

      </main>

      <dialog id="transaction-filters-dialog" class="transaction-controls-dialog" aria-labelledby="transaction-filters-title">
        <div class="transaction-sheet-heading"><h2 id="transaction-filters-title">Filters</h2></div>
        <div class="transaction-sheet-body" id="transaction-filter-sheet-body">
                <div id="transaction-account-fields" class="transaction-shared-fields">
                  <h3>Accounts <span class="transaction-selection-summary"><span id="accounts-filter-selected">0</span> / <span id="accounts-filter-total">0</span> selected</span></h3>
                  <label class="transaction-account-search">
                    <input id="account-filter-search" type="search" placeholder="Search accounts…" aria-label="Search accounts" aria-controls="account-options" autocomplete="off" />
                  </label>
                  <div class="transaction-popover-actions">
                    <button id="select-all-accounts" type="button">Select all</button>
                    <button id="deselect-all-accounts" type="button">Deselect all</button>
                  </div>
                  <p class="transaction-popover-help transaction-desktop-only">All accounts are selected by default. Deselect accounts to hide their transactions.</p>
                  <div id="account-options" class="transaction-filter-account-list"><span>Loading accounts…</span></div>
                </div>
                <div id="transaction-amount-fields" class="transaction-shared-fields">
                  <h3>Amount range <span id="amount-filter-summary" class="transaction-selection-summary">Any</span></h3>
                  <p class="transaction-popover-help">Amounts match the transaction list (spending is negative, income is positive); no currency conversion is applied.</p>
                  <div class="transaction-amount-sliders">
                    <div class="transaction-amount-reset-row">
                      <button id="reset-amount-filter" class="transaction-popover-action-link" type="button">Reset</button>
                    </div>
                    <div class="transaction-dual-range" id="transaction-amount-range" role="group" aria-label="Transaction amount range" style="--range-start: 0%; --range-end: 100%; --minimum-position: 0%; --maximum-position: 100%;">
                      <span class="transaction-dual-range-track" aria-hidden="true"></span>
                      <span class="transaction-dual-range-selection" aria-hidden="true"></span>
                      <button class="transaction-dual-range-thumb transaction-dual-range-thumb-minimum" id="minimum-transaction-amount-slider" type="button" role="slider" aria-label="Minimum transaction amount" aria-valuemin="-1" aria-valuemax="1" aria-valuenow="-1" aria-valuetext="-1.00" tabindex="0" disabled></button>
                      <button class="transaction-dual-range-thumb transaction-dual-range-thumb-maximum" id="maximum-transaction-amount-slider" type="button" role="slider" aria-label="Maximum transaction amount" aria-valuemin="-1" aria-valuemax="1" aria-valuenow="1" aria-valuetext="1.00" tabindex="0" disabled></button>
                    </div>
                    <div class="transaction-amount-inputs">
                      <label class="transaction-amount-input-control" for="minimum-transaction-amount">
                        <span>Minimum</span>
                        <input id="minimum-transaction-amount" type="text" inputmode="decimal" autocomplete="off" value="-1" disabled />
                      </label>
                      <label class="transaction-amount-input-control" for="maximum-transaction-amount">
                        <span>Maximum</span>
                        <input id="maximum-transaction-amount" type="text" inputmode="decimal" autocomplete="off" value="1" disabled />
                      </label>
                    </div>
                  </div>
                </div>
        </div>
        <div class="transaction-sheet-footer">
          <button id="cancel-transaction-filters" class="secondary-button" type="button">Cancel</button>
          <button id="apply-transaction-filters" class="primary-button" type="button">Apply filters</button>
        </div>
      </dialog>
      <dialog id="transaction-sort-dialog" class="transaction-controls-dialog" aria-labelledby="transaction-sort-title">
        <div class="transaction-sheet-heading"><h2 id="transaction-sort-title">Sort transactions</h2></div>
        <div class="transaction-sheet-body" id="transaction-sort-sheet-body">
              <label class="transaction-sort-control" id="transaction-sort-fields" for="transaction-sort-order">
                <span>Sort</span>
                <select id="transaction-sort-order">
                  <option value="date-desc">Date · newest</option>
                  <option value="date-asc">Date · oldest</option>
                  <option value="amount-desc">Amount · highest</option>
                  <option value="amount-asc">Amount · lowest</option>
                </select>
              </label>
        </div>
        <div class="transaction-sheet-footer">
          <button id="cancel-transaction-sort" class="secondary-button" type="button">Cancel</button>
          <button id="apply-transaction-sort" class="primary-button" type="button">Apply sort</button>
        </div>
      </dialog>
      ${renderBatchImportDialog()}
    </div>
  `;
}

/** Reparent shared controls; resizing must not recreate inputs or transaction rows. */
export function initializeResponsiveTransactions(root: HTMLElement, viewport: MediaQueryList): void {
  const heading = root.querySelector<HTMLElement>(".transactions-page-heading");
  const actions = root.querySelector<HTMLElement>(".transaction-heading-actions");
  const accountFields = root.querySelector<HTMLElement>("#transaction-account-fields");
  const amountFields = root.querySelector<HTMLElement>("#transaction-amount-fields");
  const sortFields = root.querySelector<HTMLElement>("#transaction-sort-fields");
  const importButton = root.querySelector<HTMLElement>("#open-batch-import");
  const count = root.querySelector<HTMLElement>("#all-transactions-count");
  if (!heading || !actions || !accountFields || !amountFields || !sortFields || !importButton || !count) return;

  const sync = (): void => {
    if (!root.isConnected) {
      viewport.removeEventListener("change", sync);
      return;
    }
    for (const id of ["transaction-filters-dialog", "transaction-sort-dialog"]) {
      const dialog = root.querySelector<HTMLDialogElement>(`#${id}`);
      if (dialog?.open) dialog.close();
    }
    for (const kind of ["accounts", "amount"]) {
      const popover = root.querySelector<HTMLElement>(`#${kind}-filter-popover`);
      if (popover) popover.hidden = true;
      root.querySelector(`#${kind}-filter-trigger`)?.setAttribute("aria-expanded", "false");
    }
    const mobile = viewport.matches;
    root.querySelector(mobile ? "#transaction-mobile-heading" : "#transaction-desktop-heading")?.append(heading);
    root.querySelector(mobile ? "#transaction-filter-sheet-body" : "#accounts-filter-popover")?.append(accountFields);
    root.querySelector(mobile ? "#transaction-filter-sheet-body" : "#amount-filter-popover")?.append(amountFields);
    root.querySelector(mobile ? "#transaction-sort-sheet-body" : "#transaction-desktop-sort")?.append(sortFields);
    (mobile ? actions : root.querySelector("#transaction-desktop-import"))?.append(importButton);
    root.querySelector(mobile ? ".transactions-sticky-controls" : "#transaction-desktop-toolbar")?.append(count);
    importButton.classList.toggle("transaction-icon-button", mobile);
  };
  sync();
  viewport.addEventListener("change", sync);
}

function renderAccountOptions(accounts: BankAccount[]): string {
  if (accounts.length === 0) return `<span class="transaction-filter-empty">No saved accounts.</span>`;
  const options = accounts.map((account) => {
    const mask = account.mask ? ` · •••• ${escapeHtml(account.mask)}` : "";
    const id = escapeHtml(account.id);
    const label = `${account.institutionName} · ${account.name}${mask}`;
    return `
      <label class="transaction-filter-account">
        <input type="checkbox" data-account-filter value="${id}" />
        <span data-account-label>${escapeHtml(label)}</span>
      </label>
    `;
  }).join("");
  return `${options}<span class="transaction-filter-empty account-filter-no-results" hidden>No accounts match your search.</span>`;
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

function allTransactionAmountBounds(groups: TransactionGroup[]): { minimum: number; maximum: number } {
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
  const filterTrigger = document.querySelector<HTMLButtonElement>("#transaction-filters-trigger");
  const filterDialog = document.querySelector<HTMLDialogElement>("#transaction-filters-dialog");
  const cancelFilters = document.querySelector<HTMLButtonElement>("#cancel-transaction-filters");
  const applyFilters = document.querySelector<HTMLButtonElement>("#apply-transaction-filters");
  const sortTrigger = document.querySelector<HTMLButtonElement>("#transaction-sort-trigger");
  const sortDialog = document.querySelector<HTMLDialogElement>("#transaction-sort-dialog");
  const cancelSort = document.querySelector<HTMLButtonElement>("#cancel-transaction-sort");
  const applySort = document.querySelector<HTMLButtonElement>("#apply-transaction-sort");
  const activityCount = document.querySelector<HTMLSpanElement>("#transaction-activity-count");
  const sortSummary = document.querySelector<HTMLSpanElement>("#transaction-sort-summary");
  const desktopAccountSummary = document.querySelector<HTMLSpanElement>("#desktop-accounts-filter-summary");
  const desktopAmountSummary = document.querySelector<HTMLSpanElement>("#desktop-amount-filter-summary");
  const accountTrigger = document.querySelector<HTMLButtonElement>("#accounts-filter-trigger");
  const amountTrigger = document.querySelector<HTMLButtonElement>("#amount-filter-trigger");
  const accountPopover = document.querySelector<HTMLDivElement>("#accounts-filter-popover");
  const amountPopover = document.querySelector<HTMLDivElement>("#amount-filter-popover");
  const accountSelected = document.querySelector<HTMLSpanElement>("#accounts-filter-selected");
  const accountTotal = document.querySelector<HTMLSpanElement>("#accounts-filter-total");
  const accountSearch = document.querySelector<HTMLInputElement>("#account-filter-search");

  const selectAllAccounts = document.querySelector<HTMLButtonElement>("#select-all-accounts");
  const deselectAllAccounts = document.querySelector<HTMLButtonElement>("#deselect-all-accounts");
  const amountTriggerSummary = document.querySelector<HTMLSpanElement>("#amount-filter-summary");
  const resetAmountFilter = document.querySelector<HTMLButtonElement>("#reset-amount-filter");
  const amountRange = document.querySelector<HTMLDivElement>("#transaction-amount-range");
  const minimumSlider = document.querySelector<HTMLButtonElement>("#minimum-transaction-amount-slider");
  const maximumSlider = document.querySelector<HTMLButtonElement>("#maximum-transaction-amount-slider");
  const minimumInput = document.querySelector<HTMLInputElement>("#minimum-transaction-amount");
  const maximumInput = document.querySelector<HTMLInputElement>("#maximum-transaction-amount");
  const sortSelect = document.querySelector<HTMLSelectElement>("#transaction-sort-order");
  const scrollSentinel = document.querySelector<HTMLDivElement>("#transactions-scroll-sentinel");
  if (!scrollSentinel) return;
  if (!list || !count || !accountOptions || !filterTrigger || !filterDialog || !cancelFilters || !applyFilters || !sortTrigger || !sortDialog || !cancelSort || !applySort || !accountSelected || !accountTotal || !accountSearch || !selectAllAccounts || !deselectAllAccounts || !amountTriggerSummary || !resetAmountFilter || !amountRange || !minimumSlider || !maximumSlider || !minimumInput || !maximumInput || !sortSelect) return;

  let accounts: BankAccount[] = [];
  let transactions: TransactionRecord[] = [];
  let transactionGroups: TransactionGroup[] = [];
  let filteredGroups: TransactionGroup[] = [];
  const batchSize = 50;
  let visibleGroupLimit = batchSize;
  let renderedGroupCount = 0;
  let scrollObserver: IntersectionObserver | null = null;
  let hasLoadedTransactions = false;
  let minimumAmount = -1;
  let maximumAmount = 1;
  let selectedMinimumAmount = -1;
  let selectedMaximumAmount = 1;
  let appliedSort: TransactionSortOrder = "date-desc";
  let filterSnapshot: { accountIds: string[]; minimum: number; maximum: number } | null = null;
  let filtersAccepted = false;
  let sortAccepted = false;

  const updateAccountSummary = (): void => {
    accountSelected.textContent = String(getSelectedAccountIds(accountOptions).length);
    if (desktopAccountSummary) desktopAccountSummary.textContent = `${accountSelected.textContent} / ${accounts.length} selected`;
  };

  const updateAccountActionLabels = (): void => {
    const searchIsActive = accountSearch.value.trim().length > 0;
    selectAllAccounts.textContent = searchIsActive ? "Select Filtered" : "Select all";
    deselectAllAccounts.textContent = searchIsActive ? "Deselect Filtered" : "Deselect all";
  };

  const applyAccountSearch = (): void => {
    let visibleCount = 0;
    for (const row of accountOptions.querySelectorAll<HTMLLabelElement>(".transaction-filter-account")) {
      const label = row.querySelector<HTMLSpanElement>("[data-account-label]");
      if (!label) continue;
      const text = label.textContent ?? "";
      const positions = getFuzzyMatchPositions(accountSearch.value, text);
      row.hidden = positions === null;
      label.innerHTML = renderFuzzyHighlightedText(text, positions ?? []);
      if (positions !== null) visibleCount++;
    }
    const noResults = accountOptions.querySelector<HTMLSpanElement>(".account-filter-no-results");
    if (noResults) noResults.hidden = accounts.length === 0 || visibleCount > 0;
    updateAccountActionLabels();
  };

  const updateAmountSummary = (): void => {
    const isFullRange = selectedMinimumAmount <= minimumAmount && selectedMaximumAmount >= maximumAmount;
    amountTriggerSummary.textContent = isFullRange
      ? "Any"
      : `${formatFilterAmount(selectedMinimumAmount)}–${formatFilterAmount(selectedMaximumAmount)}`;
    if (desktopAmountSummary) desktopAmountSummary.textContent = amountTriggerSummary.textContent;
  };

  const renderResults = (resetVisible = true): void => {
    updateAccountSummary();
    updateAmountSummary();
    // Sheet controls edit a draft until Apply. Pagination continues using applied groups.
    if (resetVisible && filterDialog.open) return;
    scrollObserver?.disconnect();
    const selectedAccountIds = getSelectedAccountIds(accountOptions);
    if (resetVisible) {
      visibleGroupLimit = batchSize;
      renderedGroupCount = 0;
      filteredGroups = filterAndSortTransactionGroups(transactionGroups, accounts, {
        includeAccountIds: selectedAccountIds,
        excludeAccountIds: [],
        minimumAmount: selectedMinimumAmount,
        maximumAmount: selectedMaximumAmount,
        sort: appliedSort,
      });
    }
    // Keep the complete history reachable if the browser cannot observe scrolling.
    const visibleGroupCount = Math.min(scrollObserver ? visibleGroupLimit : filteredGroups.length, filteredGroups.length);
    const nextGroups = filteredGroups.slice(renderedGroupCount, visibleGroupCount);
    const transactionCount = filteredGroups.reduce((total, group) => total + group.transactions.length, 0);
    count.textContent = `Showing rows ${filteredGroups.length ? 1 : 0}–${visibleGroupCount} of ${filteredGroups.length} · ${transactionCount} transaction${transactionCount === 1 ? "" : "s"}`;
    if (activityCount) activityCount.textContent = `${filteredGroups.length} activity item${filteredGroups.length === 1 ? "" : "s"}`;
    if (sortSummary) sortSummary.textContent = {
      "date-desc": "Newest first", "date-asc": "Oldest first",
      "amount-desc": "Amount · highest", "amount-asc": "Amount · lowest",
    }[appliedSort];
    filterTrigger.setAttribute("data-active", String(selectedAccountIds.length !== accounts.length || selectedMinimumAmount > minimumAmount || selectedMaximumAmount < maximumAmount));
    scrollSentinel.hidden = visibleGroupCount >= filteredGroups.length;
    updateAccountSummary();
    updateAmountSummary();
    if (filteredGroups.length === 0) {
      list.className = "transaction-empty";
      list.textContent = selectedAccountIds.length === 0
        ? "No accounts are selected. Select one or more accounts to view transactions."
        : transactions.length === 0
          ? "No saved transactions are available."
          : "No transactions match these filters.";
      return;
    }
    list.className = "transaction-list all-transactions-list";
    const html = renderTransactionGroups(nextGroups, accounts, {
      showAccount: true,
      activityStyle: true,
      responsiveActivity: true,
    });
    if (resetVisible) list.innerHTML = html;
    else list.insertAdjacentHTML("beforeend", html);
    renderedGroupCount = visibleGroupCount;
    // Re-arm after appending, including when a tall viewport still contains the sentinel.
    if (!scrollSentinel.hidden) scrollObserver?.observe(scrollSentinel);
  };

  if (typeof IntersectionObserver !== "undefined") {
    scrollObserver = new IntersectionObserver((entries) => {
      if (!scrollSentinel.isConnected) {
        scrollObserver?.disconnect();
        return;
      }
      if (scrollSentinel.hidden || !entries.some((entry) => entry.target === scrollSentinel && entry.isIntersecting)) return;
      visibleGroupLimit += batchSize;
      renderResults(false);
    }, { rootMargin: "0px 0px 400px 0px" });
  }

  const updateAccountSelection = (shouldSelect: boolean): void => {
    const targetAccountIds = accountSearch.value.trim().length > 0
      ? [...accountOptions.querySelectorAll<HTMLLabelElement>(".transaction-filter-account:not([hidden])")]
        .map((row) => row.querySelector<HTMLInputElement>("input[data-account-filter]")?.value)
        .filter((id): id is string => id !== undefined)
      : accounts.map((account) => account.id);
    const selectedAccountIds = updateSelectedAccountIds(
      getSelectedAccountIds(accountOptions),
      targetAccountIds,
      shouldSelect,
    );
    const selectedAccountIdSet = new Set(selectedAccountIds);
    for (const input of accountOptions.querySelectorAll<HTMLInputElement>("input[data-account-filter]")) {
      input.checked = selectedAccountIdSet.has(input.value);
    }
    renderResults();
  };

  const updateAmountControlVisual = (): void => {
    const amountSpan = maximumAmount - minimumAmount;
    const rangeStart = ((selectedMinimumAmount - minimumAmount) / amountSpan) * 100;
    const rangeEnd = ((selectedMaximumAmount - minimumAmount) / amountSpan) * 100;
    amountRange.style.setProperty("--range-start", `${rangeStart}%`);
    amountRange.style.setProperty("--range-end", `${rangeEnd}%`);
    amountRange.style.setProperty("--minimum-position", `${rangeStart}%`);
    amountRange.style.setProperty("--maximum-position", `${rangeEnd}%`);
    amountRange.dataset.coincident = selectedMinimumAmount === selectedMaximumAmount ? "true" : "false";
    // Crossing moves the other thumb, so both controls can still reach the full transaction bounds.
    for (const [slider, value] of [[minimumSlider, selectedMinimumAmount], [maximumSlider, selectedMaximumAmount]] as const) {
      slider.setAttribute("aria-valuemin", String(minimumAmount));
      slider.setAttribute("aria-valuemax", String(maximumAmount));
      slider.setAttribute("aria-valuenow", String(value));
      slider.setAttribute("aria-valuetext", formatFilterAmount(value));
    }
  };

  const updateAmountRange = (
    changedHandle: "minimum" | "maximum",
    value: number,
    editingInput?: HTMLInputElement,
  ): void => {
    const range = updateTransactionAmountRange(
      selectedMinimumAmount,
      selectedMaximumAmount,
      changedHandle,
      value,
      minimumAmount,
      maximumAmount,
    );
    selectedMinimumAmount = range.minimum;
    selectedMaximumAmount = range.maximum;
    if (editingInput !== minimumInput) minimumInput.value = String(selectedMinimumAmount);
    if (editingInput !== maximumInput) maximumInput.value = String(selectedMaximumAmount);
    updateAmountControlVisual();
    renderResults();
  };

  const syncRangeBounds = (preserveSelection: boolean): void => {
    const range = preserveSelection
      ? clampTransactionAmountRange(selectedMinimumAmount, selectedMaximumAmount, minimumAmount, maximumAmount)
      : { minimum: minimumAmount, maximum: maximumAmount };
    selectedMinimumAmount = range.minimum;
    selectedMaximumAmount = range.maximum;
    minimumInput.value = String(selectedMinimumAmount);
    maximumInput.value = String(selectedMaximumAmount);
    minimumSlider.disabled = false;
    maximumSlider.disabled = false;
    minimumInput.disabled = false;
    maximumInput.disabled = false;
    updateAmountControlVisual();
  };

  const loadTransactions = async (): Promise<void> => {
    const preserveAmountSelection = hasLoadedTransactions &&
      (selectedMinimumAmount > minimumAmount || selectedMaximumAmount < maximumAmount);
    const previousAvailableAccountIds = hasLoadedTransactions ? accounts.map((account) => account.id) : null;
    const previousSelectedAccountIds = getSelectedAccountIds(accountOptions);
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
    transactionGroups = groupInternalTransfers(transactions, accounts);
    accountTotal.textContent = String(accounts.length);
    accountOptions.innerHTML = renderAccountOptions(accounts);
    const accountIdsToSelect = getAccountSelectionOnLoad(
      accounts.map((account) => account.id),
      previousAvailableAccountIds,
      previousSelectedAccountIds,
    );
    const selectedAccountIdSet = new Set(accountIdsToSelect);
    for (const input of accountOptions.querySelectorAll<HTMLInputElement>("input[data-account-filter]")) {
      input.checked = selectedAccountIdSet.has(input.value);
    }
    applyAccountSearch();
    hasLoadedTransactions = true;
    const bounds = allTransactionAmountBounds(transactionGroups);
    minimumAmount = bounds.minimum;
    maximumAmount = bounds.maximum;
    syncRangeBounds(preserveAmountSelection);
    renderResults();
    filterTrigger.disabled = false;
    sortTrigger.disabled = false;
    if (accountTrigger) accountTrigger.disabled = false;
    if (amountTrigger) amountTrigger.disabled = false;
    if (status) {
      status.hidden = true;
      status.textContent = "";
    }
  };

  initializeBatchImport(() => accounts, loadTransactions);
  const closeDesktopPopovers = (): void => {
    if (accountPopover) accountPopover.hidden = true;
    if (amountPopover) amountPopover.hidden = true;
    accountTrigger?.setAttribute("aria-expanded", "false");
    amountTrigger?.setAttribute("aria-expanded", "false");
  };
  const toggleDesktopPopover = (trigger: HTMLButtonElement | null, popover: HTMLDivElement | null): void => {
    if (!trigger || !popover) return;
    const shouldOpen = popover.hidden;
    closeDesktopPopovers();
    if (!shouldOpen) return;
    popover.hidden = false;
    popover.style.transform = "";
    trigger.setAttribute("aria-expanded", "true");
    const bounds = popover.getBoundingClientRect();
    const shift = Math.min(0, window.innerWidth - 8 - bounds.right);
    popover.style.transform = `translateX(${Math.max(8 - bounds.left, shift)}px)`;
    popover.style.maxHeight = `${Math.max(120, window.innerHeight - bounds.top - 8)}px`;
  };
  accountTrigger?.addEventListener("click", () => toggleDesktopPopover(accountTrigger, accountPopover));
  amountTrigger?.addEventListener("click", () => toggleDesktopPopover(amountTrigger, amountPopover));
  for (const [kind, trigger] of [["accounts", accountTrigger], ["amount", amountTrigger]] as const) {
    document.querySelector(`#close-${kind}-filter`)?.addEventListener("click", () => {
      closeDesktopPopovers();
      trigger?.focus();
    });
  }
  document.addEventListener("click", (event: MouseEvent) => {
    if (!(event.target instanceof Node)) return;
    if (!accountPopover?.contains(event.target) && !accountTrigger?.contains(event.target) && !amountPopover?.contains(event.target) && !amountTrigger?.contains(event.target)) closeDesktopPopovers();
  });
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    const trigger = accountPopover && !accountPopover.hidden ? accountTrigger : amountPopover && !amountPopover.hidden ? amountTrigger : null;
    if (trigger) { closeDesktopPopovers(); trigger.focus(); }
  });
  filterTrigger.addEventListener("click", () => {
    filterSnapshot = {
      accountIds: getSelectedAccountIds(accountOptions),
      minimum: selectedMinimumAmount,
      maximum: selectedMaximumAmount,
    };
    filtersAccepted = false;
    accountSearch.value = "";
    applyAccountSearch();
    filterDialog.showModal();
    filterTrigger.setAttribute("aria-expanded", "true");
  });
  filterDialog.addEventListener("close", () => {
    if (!filtersAccepted && filterSnapshot) {
      const selectedIds = new Set(filterSnapshot.accountIds);
      for (const input of accountOptions.querySelectorAll<HTMLInputElement>("input[data-account-filter]")) {
        input.checked = selectedIds.has(input.value);
      }
      selectedMinimumAmount = filterSnapshot.minimum;
      selectedMaximumAmount = filterSnapshot.maximum;
      minimumInput.value = String(selectedMinimumAmount);
      maximumInput.value = String(selectedMaximumAmount);
      updateAmountControlVisual();
      updateAccountSummary();
      updateAmountSummary();
    }
    filterSnapshot = null;
    filterTrigger.setAttribute("aria-expanded", "false");
    filterTrigger.focus();
    if (filtersAccepted) renderResults();
  });
  cancelFilters.addEventListener("click", () => filterDialog.close());
  applyFilters.addEventListener("click", () => {
    handleAmountInputCommit("minimum", minimumInput);
    handleAmountInputCommit("maximum", maximumInput);
    filtersAccepted = true;
    filterDialog.close();
  });
  sortTrigger.addEventListener("click", () => {
    sortSelect.value = appliedSort;
    sortAccepted = false;
    sortDialog.showModal();
    sortTrigger.setAttribute("aria-expanded", "true");
  });
  sortDialog.addEventListener("close", () => {
    if (!sortAccepted) sortSelect.value = appliedSort;
    sortTrigger.setAttribute("aria-expanded", "false");
    sortTrigger.focus();
  });
  cancelSort.addEventListener("click", () => sortDialog.close());
  applySort.addEventListener("click", () => {
    appliedSort = sortSelect.value as TransactionSortOrder;
    sortAccepted = true;
    sortDialog.close();
    renderResults();
  });
  for (const dialog of [filterDialog, sortDialog]) {
    dialog.addEventListener("click", (event: MouseEvent) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
  }
  resetAmountFilter.addEventListener("click", () => {
    selectedMinimumAmount = minimumAmount;
    selectedMaximumAmount = maximumAmount;
    minimumInput.value = String(minimumAmount);
    maximumInput.value = String(maximumAmount);
    updateAmountControlVisual();
    renderResults();
  });
  selectAllAccounts.addEventListener("click", () => updateAccountSelection(true));
  deselectAllAccounts.addEventListener("click", () => updateAccountSelection(false));
  accountOptions.addEventListener("change", () => renderResults());
  accountSearch.addEventListener("input", applyAccountSearch);
  sortSelect.addEventListener("change", () => {
    if (sortDialog.open) return;
    appliedSort = sortSelect.value as TransactionSortOrder;
    renderResults();
  });
  const setActiveAmountHandle = (handle: "minimum" | "maximum"): void => {
    const active = handle === "minimum" ? minimumSlider : maximumSlider;
    const inactive = handle === "minimum" ? maximumSlider : minimumSlider;
    active.style.zIndex = "3";
    inactive.style.zIndex = "2";
  };

  const getAmountAtPointer = (event: PointerEvent): number => {
    const bounds = amountRange.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
    return minimumAmount + ratio * (maximumAmount - minimumAmount);
  };

  let activeAmountPointer: { pointerId: number; handle: "minimum" | "maximum" } | null = null;
  const bindAmountSlider = (slider: HTMLButtonElement, handle: "minimum" | "maximum"): void => {
    slider.addEventListener("focus", () => setActiveAmountHandle(handle));
    slider.addEventListener("pointerdown", (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      setActiveAmountHandle(handle);
      slider.focus({ preventScroll: true });
      activeAmountPointer = { pointerId: event.pointerId, handle };
      slider.setPointerCapture(event.pointerId);
      updateAmountRange(handle, getAmountAtPointer(event));
    });
    slider.addEventListener("keydown", (event: KeyboardEvent) => {
      const currentValue = handle === "minimum" ? selectedMinimumAmount : selectedMaximumAmount;
      const largeStep = Math.max(0.01, Number(((maximumAmount - minimumAmount) * 0.1).toFixed(2)));
      let nextValue: number | null = null;
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowDown":
          nextValue = currentValue - 0.01;
          break;
        case "ArrowRight":
        case "ArrowUp":
          nextValue = currentValue + 0.01;
          break;
        case "PageDown":
          nextValue = currentValue - largeStep;
          break;
        case "PageUp":
          nextValue = currentValue + largeStep;
          break;
        case "Home":
          nextValue = minimumAmount;
          break;
        case "End":
          nextValue = maximumAmount;
          break;
        default:
          return;
      }
      event.preventDefault();
      updateAmountRange(handle, nextValue);
    });
  };

  const handleAmountInput = (handle: "minimum" | "maximum", input: HTMLInputElement): void => {
    const value = parseAmountRangeInput(input.value);
    if (value === null) return;
    updateAmountRange(handle, value, input);
    const appliedValue = handle === "minimum" ? selectedMinimumAmount : selectedMaximumAmount;
    input.value = reconcileAmountRangeInput(input.value, appliedValue);
  };

  const handleAmountInputCommit = (handle: "minimum" | "maximum", input: HTMLInputElement): void => {
    const value = parseAmountRangeInput(input.value);
    if (value === null) {
      input.value = String(handle === "minimum" ? selectedMinimumAmount : selectedMaximumAmount);
      return;
    }
    updateAmountRange(handle, value);
  };

  bindAmountSlider(minimumSlider, "minimum");
  bindAmountSlider(maximumSlider, "maximum");
  amountRange.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.defaultPrevented || event.target instanceof HTMLButtonElement) return;
    const amount = getAmountAtPointer(event);
    const handle = Math.abs(amount - selectedMinimumAmount) <= Math.abs(amount - selectedMaximumAmount)
      ? "minimum"
      : "maximum";
    const slider = handle === "minimum" ? minimumSlider : maximumSlider;
    event.preventDefault();
    setActiveAmountHandle(handle);
    activeAmountPointer = { pointerId: event.pointerId, handle };
    slider.focus({ preventScroll: true });
    slider.setPointerCapture(event.pointerId);
    updateAmountRange(handle, amount);
  });
  amountRange.addEventListener("pointermove", (event: PointerEvent) => {
    if (activeAmountPointer?.pointerId === event.pointerId) {
      updateAmountRange(activeAmountPointer.handle, getAmountAtPointer(event));
    }
  });
  const finishAmountPointer = (event: PointerEvent): void => {
    const activePointer = activeAmountPointer;
    if (activePointer?.pointerId !== event.pointerId) return;
    const slider = activePointer.handle === "minimum" ? minimumSlider : maximumSlider;
    if (slider.hasPointerCapture(event.pointerId)) slider.releasePointerCapture(event.pointerId);
    activeAmountPointer = null;
  };
  amountRange.addEventListener("pointerup", finishAmountPointer);
  amountRange.addEventListener("pointercancel", finishAmountPointer);
  minimumInput.addEventListener("input", () => handleAmountInput("minimum", minimumInput));
  maximumInput.addEventListener("input", () => handleAmountInput("maximum", maximumInput));
  minimumInput.addEventListener("change", () => handleAmountInputCommit("minimum", minimumInput));
  maximumInput.addEventListener("change", () => handleAmountInputCommit("maximum", maximumInput));

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const root = document.querySelector<HTMLElement>(".app-shell");
    if (root) initializeResponsiveTransactions(root, window.matchMedia("(max-width: 800px)"));
  }

  try {
    await loadTransactions();
  } catch (error) {
    list.className = "transaction-empty";
    list.textContent = error instanceof Error ? error.message : "Unable to load transactions.";
    count.textContent = "Transactions could not be loaded";
    if (activityCount) activityCount.textContent = "Unable to load activity";
  }
}
