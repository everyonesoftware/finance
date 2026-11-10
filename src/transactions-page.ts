import { appVersion } from "./app-version.ts";
import { renderMainNavigation } from "./navigation.ts";
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

export function formatFilterAmount(value: number): string {
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));
  return `${value < 0 ? "-" : ""}$${formatted}`;
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
        <button class="mobile-menu-toggle" type="button" aria-label="Open navigation menu" aria-expanded="false" aria-controls="main-navigation"><span aria-hidden="true">☰</span></button>
        <div class="mobile-menu-panel">
        <div class="workspace-label">WORKSPACE</div>
        ${renderMainNavigation("transactions")}
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
      <main class="main-content transactions-content">

        <section class="page-heading transactions-page-heading">
          <div>
            <p class="eyebrow">ALL ACCOUNTS</p>
            <h1>Transactions</h1>
            <p class="subheading">Search saved activity across your accounts.</p>
          </div>

        </section>
        <p id="all-transactions-status" class="bank-data-notice" role="status" aria-live="polite">Bank connections and syncing are unavailable. Previously saved data remains available.</p>

        <section class="panel transaction-filters" aria-labelledby="transaction-filters-title">
          <div class="transaction-filter-toolbar">
            <span id="transaction-filters-title" class="transaction-filter-label">Filter</span>
            <div class="transaction-filter-controls">
              <div class="transaction-filter-anchor">
                <button class="transaction-filter-trigger" id="accounts-filter-trigger" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="accounts-filter-popover">
                  Accounts: <span id="accounts-filter-selected">0</span> / <span id="accounts-filter-total">0</span> selected<span class="transaction-trigger-chevron" aria-hidden="true">▾</span>
                </button>
                <div class="transaction-filter-popover accounts-filter-popover" id="accounts-filter-popover" role="dialog" aria-label="Filter by account" hidden>
                  <div class="transaction-popover-heading">
                    <strong>Accounts</strong>
                    <button class="transaction-popover-close" id="close-accounts-filter" type="button" aria-label="Close account filters">×</button>
                  </div>
                  <label class="transaction-account-search">
                    <input id="account-filter-search" type="search" placeholder="Search accounts…" aria-label="Search accounts" aria-controls="account-options" autocomplete="off" />
                  </label>
                  <div class="transaction-popover-actions">
                    <button id="select-all-accounts" type="button">Select all</button>
                    <button id="deselect-all-accounts" type="button">Deselect all</button>
                  </div>
                  <p class="transaction-popover-help">All accounts are selected by default. Deselect accounts to hide their transactions.</p>
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
        <footer class="page-footer">Your finances, in focus.<span>Previously saved transactions</span></footer>
      </main>
    </div>
  `;
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
  const accountSelected = document.querySelector<HTMLSpanElement>("#accounts-filter-selected");
  const accountTotal = document.querySelector<HTMLSpanElement>("#accounts-filter-total");
  const accountSearch = document.querySelector<HTMLInputElement>("#account-filter-search");
  const accountPopover = document.querySelector<HTMLDivElement>("#accounts-filter-popover");
  const selectAllAccounts = document.querySelector<HTMLButtonElement>("#select-all-accounts");
  const deselectAllAccounts = document.querySelector<HTMLButtonElement>("#deselect-all-accounts");
  const closeAccountsFilter = document.querySelector<HTMLButtonElement>("#close-accounts-filter");
  const amountTrigger = document.querySelector<HTMLButtonElement>("#amount-filter-trigger");
  const amountTriggerSummary = document.querySelector<HTMLSpanElement>("#amount-filter-summary");
  const amountPopover = document.querySelector<HTMLDivElement>("#amount-filter-popover");
  const closeAmountFilter = document.querySelector<HTMLButtonElement>("#close-amount-filter");
  const resetAmountFilter = document.querySelector<HTMLButtonElement>("#reset-amount-filter");
  const amountRange = document.querySelector<HTMLDivElement>("#transaction-amount-range");
  const minimumSlider = document.querySelector<HTMLButtonElement>("#minimum-transaction-amount-slider");
  const maximumSlider = document.querySelector<HTMLButtonElement>("#maximum-transaction-amount-slider");
  const minimumInput = document.querySelector<HTMLInputElement>("#minimum-transaction-amount");
  const maximumInput = document.querySelector<HTMLInputElement>("#maximum-transaction-amount");
  const sortSelect = document.querySelector<HTMLSelectElement>("#transaction-sort-order");
  if (!list || !count || !accountOptions || !accountTrigger || !accountSelected || !accountTotal || !accountSearch || !accountPopover || !selectAllAccounts || !deselectAllAccounts || !closeAccountsFilter || !amountTrigger || !amountTriggerSummary || !amountPopover || !closeAmountFilter || !resetAmountFilter || !amountRange || !minimumSlider || !maximumSlider || !minimumInput || !maximumInput || !sortSelect) return;

  let accounts: BankAccount[] = [];
  let transactions: TransactionRecord[] = [];
  let hasLoadedTransactions = false;
  let minimumAmount = -1;
  let maximumAmount = 1;
  let selectedMinimumAmount = -1;
  let selectedMaximumAmount = 1;

  const updateAccountSummary = (): void => {
    accountSelected.textContent = String(getSelectedAccountIds(accountOptions).length);
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
  };

  const closeFilterPopovers = (): void => {
    accountPopover.hidden = true;
    amountPopover.hidden = true;
    accountPopover.style.transform = "";
    amountPopover.style.transform = "";
    for (const popover of [accountPopover, amountPopover]) {
      popover.style.position = "";
      popover.style.left = "";
      popover.style.top = "";
    }
    accountTrigger.setAttribute("aria-expanded", "false");
    amountTrigger.setAttribute("aria-expanded", "false");
  };

  const toggleFilterPopover = (trigger: HTMLButtonElement, popover: HTMLDivElement): void => {
    const shouldOpen = popover.hidden;
    closeFilterPopovers();
    if (shouldOpen) {
      popover.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      const isNarrowViewport = window.matchMedia("(max-width: 520px)").matches;
      if (isNarrowViewport) {
        const triggerBounds = trigger.getBoundingClientRect();
        popover.style.position = "fixed";
        popover.style.left = "8px";
        popover.style.top = `${triggerBounds.bottom + 7}px`;
        popover.style.transform = "";
        const popupBounds = popover.getBoundingClientRect();
        const left = Math.max(8, Math.min(triggerBounds.left, window.innerWidth - popupBounds.width - 8));
        const top = triggerBounds.bottom + 7 + popupBounds.height <= window.innerHeight - 8
          ? triggerBounds.bottom + 7
          : Math.max(8, triggerBounds.top - popupBounds.height - 7);
        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
      } else {
        const bounds = popover.getBoundingClientRect();
        const horizontalShift = bounds.right > window.innerWidth - 8
          ? window.innerWidth - 8 - bounds.right
          : bounds.left < 8 ? 8 - bounds.left : 0;
        if (horizontalShift !== 0) popover.style.transform = `translateX(${horizontalShift}px)`;
      }
    }
  };

  const renderResults = (): void => {
    const selectedAccountIds = getSelectedAccountIds(accountOptions);
    const groups = groupInternalTransfers(transactions, accounts);
    const filtered = filterAndSortTransactionGroups(groups, accounts, {
      includeAccountIds: selectedAccountIds,
      excludeAccountIds: [],
      minimumAmount: selectedMinimumAmount,
      maximumAmount: selectedMaximumAmount,
      sort: sortSelect.value as TransactionSortOrder,
    });
    const filteredTransactions = filtered.flatMap((group) => group.transactions);
    const visibleTransactionCount = filtered.reduce((total, group) => total + group.transactions.length, 0);
    count.textContent = `Showing ${visibleTransactionCount} transaction${visibleTransactionCount === 1 ? "" : "s"} in ${filtered.length} row${filtered.length === 1 ? "" : "s"}`;
    updateAccountSummary();
    updateAmountSummary();
    if (filtered.length === 0) {
      list.className = "transaction-empty";
      list.textContent = selectedAccountIds.length === 0
        ? "No accounts are selected. Select one or more accounts to view transactions."
        : transactions.length === 0
          ? "No saved transactions are available."
          : "No transactions match these filters.";
      return;
    }
    list.className = "transaction-list all-transactions-list";
    list.innerHTML = renderTransactionList(filteredTransactions, accounts, { showAccount: true });
  };

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
    const preserveAmountSelection = hasLoadedTransactions;
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
    const bounds = allTransactionAmountBounds(transactions, accounts);
    minimumAmount = bounds.minimum;
    maximumAmount = bounds.maximum;
    syncRangeBounds(preserveAmountSelection);
    renderResults();
    if (status) {
      status.hidden = false;
      status.textContent = "Bank connections and syncing are unavailable. Previously saved data remains available.";
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
  accountOptions.addEventListener("change", renderResults);
  accountSearch.addEventListener("input", applyAccountSearch);
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

  try {
    await loadTransactions();
  } catch (error) {
    list.className = "transaction-empty";
    list.textContent = error instanceof Error ? error.message : "Unable to load transactions.";
    count.textContent = "Transactions could not be loaded";
  }
}
