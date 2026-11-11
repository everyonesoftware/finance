import type { BankAccount } from "./bank_accounts.ts";
import {
  findFidelityAchAccountMention,
  findReferencedAccount,
  formatTransactionAmount,
  renderLinkedTransactionName,
} from "./account-transaction-utils.ts";
import { escapeHtml } from "./html-utils.ts";

export type TransactionRecord = Record<string, unknown>;
export interface TransactionListRenderOptions {
  showAccount?: boolean;
  activityStyle?: boolean;
  groupByDate?: boolean;
  previousDate?: string | null;
}

export type TransactionGroup =
  | { type: "single"; transactions: [TransactionRecord] }
  | {
      type: "transfer";
      transactions: TransactionRecord[];
      fromAccount: BankAccount;
      toAccount: BankAccount;
    };

function stringField(transaction: TransactionRecord, field: string): string | null {
  const value = transaction[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(transaction: TransactionRecord, field: string): number | null {
  const value = transaction[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function currencyCode(transaction: TransactionRecord): string | null {
  return stringField(transaction, "iso_currency_code") ?? stringField(transaction, "unofficial_currency_code");
}

function transferDirection(name: string): "to" | "from" | null {
  if (!/\btransfer\b|\bxfer\b/i.test(name)) return null;
  const to = /\bto\b/i.test(name);
  const from = /\bfrom\b/i.test(name);
  if (to === from) return null;
  return to ? "to" : "from";
}

function dateOrdinal(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? timestamp / 86_400_000 : null;
}

function getFidelityAchTransferAccounts(
  transaction: TransactionRecord,
  accountsByProviderId: Map<string, BankAccount>,
  accounts: BankAccount[],
): { fromAccount: BankAccount; toAccount: BankAccount } | null {
  const name = stringField(transaction, "name");
  const amount = numberField(transaction, "amount");
  const receivingAccountId = stringField(transaction, "account_id");
  if (
    !name ||
    !/\bFID\s+BKG\s+SVC\s+LLC\s+ACH\b/i.test(name) ||
    amount === null || amount >= 0 ||
    !receivingAccountId
  ) return null;

  const toAccount = accountsByProviderId.get(receivingAccountId);
  if (!toAccount || toAccount.type !== "depository") return null;
  const sourceMention = findFidelityAchAccountMention(name, accounts);
  if (!sourceMention || sourceMention.account.id === toAccount.id) return null;
  return { fromAccount: sourceMention.account, toAccount };
}

function plausiblePair(
  first: TransactionRecord,
  second: TransactionRecord,
  accountsByProviderId: Map<string, BankAccount>,
  accounts: BankAccount[],
): { fromAccount: BankAccount; toAccount: BankAccount } | null {
  const firstId = stringField(first, "account_id");
  const secondId = stringField(second, "account_id");
  const firstName = stringField(first, "name");
  const secondName = stringField(second, "name");
  const firstAmount = numberField(first, "amount");
  const secondAmount = numberField(second, "amount");
  const firstDate = stringField(first, "date");
  const secondDate = stringField(second, "date");
  if (!firstId || !secondId || firstId === secondId || !firstName || !secondName) return null;
  if (firstAmount === null || secondAmount === null || firstAmount === 0 || secondAmount === 0) return null;
  if (Math.sign(firstAmount) === Math.sign(secondAmount)) return null;
  if (Math.round(Math.abs(firstAmount) * 100) !== Math.round(Math.abs(secondAmount) * 100)) return null;
  const firstCurrency = currencyCode(first);
  const secondCurrency = currencyCode(second);
  if (!firstCurrency || firstCurrency !== secondCurrency) return null;

  const firstDirection = transferDirection(firstName);
  const secondDirection = transferDirection(secondName);
  if (!firstDirection || !secondDirection || firstDirection === secondDirection) return null;
  if (!firstDate || !secondDate) return null;
  const firstOrdinal = dateOrdinal(firstDate);
  const secondOrdinal = dateOrdinal(secondDate);
  if (firstOrdinal === null || secondOrdinal === null || Math.abs(firstOrdinal - secondOrdinal) > 3) return null;

  const firstAccount = accountsByProviderId.get(firstId);
  const secondAccount = accountsByProviderId.get(secondId);
  if (!firstAccount || !secondAccount) return null;
  const firstReference = findReferencedAccount(firstName, accounts);
  const secondReference = findReferencedAccount(secondName, accounts);
  if (firstReference?.providerAccountId !== secondId || secondReference?.providerAccountId !== firstId) return null;

  const toTransaction = firstDirection === "to" ? first : second;
  const fromTransaction = firstDirection === "from" ? first : second;
  const fromAccount = accountsByProviderId.get(stringField(toTransaction, "account_id") ?? "");
  const toAccount = findReferencedAccount(stringField(toTransaction, "name") ?? "", accounts);
  if (!fromAccount || !toAccount || fromAccount.id === toAccount.id) return null;

  // The incoming-side transaction must belong to the receiving account.
  const incomingAccountId = stringField(fromTransaction, "account_id");
  if (incomingAccountId !== toAccount.providerAccountId) return null;
  return { fromAccount, toAccount };
}

interface TransferCandidate {
  key: string;
  counterpartKey: string;
  ordinal: number;
}

type TransferCandidateIndex = Map<string, Map<number, number[]>>;

function transferCandidate(transaction: TransactionRecord): TransferCandidate | null {
  const name = stringField(transaction, "name");
  const amount = numberField(transaction, "amount");
  const currency = currencyCode(transaction);
  const date = stringField(transaction, "date");
  const direction = name ? transferDirection(name) : null;
  const ordinal = date ? dateOrdinal(date) : null;
  if (!direction || amount === null || amount === 0 || !currency || ordinal === null) return null;
  const cents = Math.round(Math.abs(amount) * 100);
  const sign = Math.sign(amount);
  return {
    key: JSON.stringify([direction, sign, cents, currency]),
    counterpartKey: JSON.stringify([direction === "to" ? "from" : "to", -sign, cents, currency]),
    ordinal,
  };
}

function* counterpartIndexes(
  candidate: TransferCandidate,
  candidates: TransferCandidateIndex,
  afterIndex: number,
): Generator<number> {
  const dates = candidates.get(candidate.counterpartKey);
  if (!dates) return;
  const cursors: { indexes: number[]; position: number }[] = [];
  for (let day = candidate.ordinal - 3; day <= candidate.ordinal + 3; day += 1) {
    const indexes = dates.get(day);
    if (!indexes) continue;
    // Buckets retain input order. Jump over earlier records rather than rescanning them.
    let low = 0;
    let high = indexes.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (indexes[middle]! <= afterIndex) low = middle + 1;
      else high = middle;
    }
    if (low < indexes.length) cursors.push({ indexes, position: low });
  }
  // Merge at most seven date buckets to preserve the original first-match order.
  while (true) {
    let next: { indexes: number[]; position: number } | undefined;
    let nextIndex = Infinity;
    for (const cursor of cursors) {
      const index = cursor.indexes[cursor.position];
      if (index !== undefined && index < nextIndex) {
        next = cursor;
        nextIndex = index;
      }
    }
    if (!next) return;
    next.position += 1;
    yield nextIndex;
  }
}

export function groupInternalTransfers(
  transactions: TransactionRecord[],
  accounts: BankAccount[],
): TransactionGroup[] {
  const accountsByProviderId = new Map<string, BankAccount>();
  for (const account of accounts) {
    if (account.providerAccountId) accountsByProviderId.set(account.providerAccountId, account);
  }

  const candidates: TransferCandidateIndex = new Map();
  const metadata = transactions.map((transaction, index) => {
    const candidate = transaction ? transferCandidate(transaction) : null;
    if (candidate) {
      let dates = candidates.get(candidate.key);
      if (!dates) {
        dates = new Map();
        candidates.set(candidate.key, dates);
      }
      const indexes = dates.get(candidate.ordinal);
      if (indexes) indexes.push(index);
      else dates.set(candidate.ordinal, [index]);
    }
    return candidate;
  });

  const groups: TransactionGroup[] = [];
  const consumed = new Set<number>();
  for (let index = 0; index < transactions.length; index += 1) {
    if (consumed.has(index)) continue;
    const transaction = transactions[index];
    if (!transaction) continue;

    let counterpartIndex = -1;
    let pairedAccounts: { fromAccount: BankAccount; toAccount: BankAccount } | null = null;
    const candidateMetadata = metadata[index];
    const possibleCounterparts = candidateMetadata ? counterpartIndexes(candidateMetadata, candidates, index) : [];
    for (const candidateIndex of possibleCounterparts) {
      if (consumed.has(candidateIndex)) continue;
      const candidate = transactions[candidateIndex];
      if (!candidate) continue;
      const pair = plausiblePair(transaction, candidate, accountsByProviderId, accounts);
      if (pair) {
        counterpartIndex = candidateIndex;
        pairedAccounts = pair;
        break;
      }
    }

    if (counterpartIndex < 0) {
      const describedTransfer = getFidelityAchTransferAccounts(transaction, accountsByProviderId, accounts);
      if (describedTransfer) {
        groups.push({ type: "transfer", transactions: [transaction], ...describedTransfer });
        continue;
      }
    }

    if (counterpartIndex >= 0 && pairedAccounts) {
      const counterpart = transactions[counterpartIndex];
      if (counterpart) {
        consumed.add(counterpartIndex);
        groups.push({
          type: "transfer",
          transactions: [transaction, counterpart],
          ...pairedAccounts,
        });
        continue;
      }
    }
    groups.push({ type: "single", transactions: [transaction] });
  }
  return groups;
}

function renderTransactionRow(
  transaction: TransactionRecord,
  accounts: BankAccount[],
  showAccount: boolean,
  activity = false,
  hideDate = false,
): string {
  const name = stringField(transaction, "name") ?? "Transaction";
  const date = stringField(transaction, "date") ?? "Date unavailable";
  const pending = transaction["pending"] === true ? " · Pending" : "";
  const amount = numberField(transaction, "amount") ?? Number.NaN;
  const providerAccountId = stringField(transaction, "account_id");
  const account = showAccount && providerAccountId
    ? accounts.find((candidate) => candidate.providerAccountId === providerAccountId)
    : undefined;
  const accountLabel = account
    ? `<span class="transaction-account-label">${escapeHtml(account.institutionName)} · ${escapeHtml(account.name)}</span>`
    : "";
  if (activity) {
    const monogram = Array.from(name.trim())[0]?.toLocaleUpperCase("en-US") ?? "T";
    return `
      <div class="account-row transaction-row" data-activity="true">
        <span class="transaction-avatar" aria-hidden="true">${escapeHtml(monogram)}</span>
        <div class="transaction-copy">
          <strong>${renderLinkedTransactionName(name, accounts)}</strong>
          ${hideDate ? "" : `<span>${escapeHtml(date)}</span>`}
          ${accountLabel}
          ${transaction["pending"] === true ? '<span class="transaction-pending">Pending</span>' : ""}
        </div>
        <b${amount < 0 ? ' class="transaction-income"' : ""}>${escapeHtml(formatTransactionAmount(amount, currencyCode(transaction)))}</b>
      </div>
    `;
  }
  return `
    <div class="account-row transaction-row">
      <div class="transaction-copy">
        <strong>${renderLinkedTransactionName(name, accounts)}</strong>
        <span>${escapeHtml(date + pending)}</span>
        ${accountLabel}
      </div>
      <b>${escapeHtml(formatTransactionAmount(amount, currencyCode(transaction)))}</b>
    </div>
  `;
}

export function renderTransactionList(
  transactions: TransactionRecord[],
  accounts: BankAccount[],
  options: TransactionListRenderOptions = {},
): string {
  return renderTransactionGroups(groupInternalTransfers(transactions, accounts), accounts, options);
}

export function renderTransactionGroups(
  groups: TransactionGroup[],
  accounts: BankAccount[],
  options: TransactionListRenderOptions = {},
): string {
  if (groups.length === 0) return "No saved transactions are available.";

  let previousDate = options.previousDate;
  return groups.map((group): string => {
    const dates = group.transactions
      .map((transaction) => stringField(transaction, "date"))
      .filter((date): date is string => date !== null)
      .sort();
    const date = dates[0] ?? null;
    const heading = options.groupByDate === true && date !== previousDate
      ? `<h3 class="transaction-date-heading">${escapeHtml(date ?? "Date unavailable")}</h3>`
      : "";
    previousDate = date;
    if (group.type === "single") return heading + renderTransactionRow(group.transactions[0], accounts, options.showAccount === true, options.groupByDate === true || options.activityStyle === true, options.groupByDate === true);
    const dateLabel = dates[0] === dates.at(-1) ? dates[0] : `${dates[0]} – ${dates.at(-1)}`;
    const amountTransaction = group.transactions.find((transaction) => numberField(transaction, "amount") !== null);
    const transferAmount = amountTransaction ? Math.abs(numberField(amountTransaction, "amount") ?? 0) : Number.NaN;
    const amountCurrency = amountTransaction ? currencyCode(amountTransaction) : null;
    return `${heading}
      <details class="transaction-transfer-pair">
        <summary aria-label="Expand or collapse original transfer transactions">
          <div class="transaction-copy transfer-pair-copy">
            <strong>Transfer: ${escapeHtml(group.fromAccount.name)} → ${escapeHtml(group.toAccount.name)}</strong>
            <span>${escapeHtml(dateLabel ?? "Date unavailable")}</span>
          </div>
          <b class="transfer-pair-amount">${escapeHtml(formatTransactionAmount(-transferAmount, amountCurrency))}</b>
        </summary>
        <div class="transfer-pair-rows">
          <div class="transfer-pair-details-label">Transactions included in this transfer</div>
          ${group.transactions.map((transaction) => renderTransactionRow(transaction, accounts, options.showAccount === true)).join("")}
        </div>
      </details>
    `;
  }).join("");
}
