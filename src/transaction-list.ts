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
  responsiveActivity?: boolean;
  groupByDate?: boolean;
  previousDate?: string | null;
}

export type TransactionGroup =
  | { type: "single"; transactions: [TransactionRecord] }
  | {
      type: "treasury-payment";
      transactions: TransactionRecord[];
      receivingAccount: BankAccount;
    }
  | {
      type: "travel-reward";
      transactions: TransactionRecord[];
      receivingAccount: BankAccount;
    }
  | {
      type: "transfer" | "credit-card-payment";
      transactions: TransactionRecord[];
      fromAccount: BankAccount;
      toAccount: BankAccount;
    };

export function getTransactionGroupDate(group: TransactionGroup): string | null {
  let latest: string | null = null;
  for (const transaction of group.transactions) {
    const date = stringField(transaction, "date");
    if (date !== null && (latest === null || date > latest)) latest = date;
  }
  return latest;
}

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
  windowDays = 3,
): Generator<number> {
  const dates = candidates.get(candidate.counterpartKey);
  if (!dates) return;
  const cursors: { indexes: number[]; position: number }[] = [];
  for (let day = candidate.ordinal - windowDays; day <= candidate.ordinal + windowDays; day += 1) {
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

const creditCardPaymentRules = [
  {
    issuer: "citi",
    outgoing: /^CITI\s+CARD\s+ONLINE\s+PAYMENT$/i,
    incoming: /^ONLINE\s+PAYMENT,\s*THANK\s+YOU$/i,
    institution: /^Citi$/i,
  },
  {
    issuer: "capital-one",
    outgoing: /^CAPITAL\s+ONE\s+ONLINE\s+PMT$/i,
    incoming: /^CAPITAL\s+ONE\s+ONLINE\s+PYMT\s+CAPITAL\s+ONE\s+ONLINE\s+PYMT$/i,
    institution: /^Capital\s*One$/i,
  },
];

function creditCardPaymentPairs(
  transactions: TransactionRecord[],
  accountsByProviderId: Map<string, BankAccount>,
): Map<number, number> {
  // Recognize only observed issuer-specific descriptors, never generic payment text.
  const candidates: TransferCandidateIndex = new Map();
  const metadata = transactions.map((transaction, index): TransferCandidate | null => {
    if (!transaction || transaction["pending"] === true) return null;
    const name = stringField(transaction, "name")?.trim() ?? "";
    const rule = creditCardPaymentRules.find((candidate) => candidate.outgoing.test(name) || candidate.incoming.test(name));
    if (!rule) return null;
    const outgoing = rule.outgoing.test(name);
    const account = accountsByProviderId.get(stringField(transaction, "account_id") ?? "");
    if (!account || (outgoing ? account.type !== "depository"
      : account.type !== "credit" || account.subtype !== "credit card" || !rule.institution.test(account.institutionName.trim()))) return null;
    const amount = numberField(transaction, "amount");
    const currency = currencyCode(transaction);
    const date = stringField(transaction, "date");
    const ordinal = date ? dateOrdinal(date) : null;
    if (amount === null || (outgoing ? amount <= 0 : amount >= 0) || !currency || ordinal === null) return null;
    if (new Date(ordinal * 86_400_000).toISOString().slice(0, 10) !== date) return null;
    const cents = Math.round(Math.abs(amount) * 100);
    if (cents === 0) return null;
    const candidate = {
      key: JSON.stringify([rule.issuer, outgoing, cents, currency]),
      counterpartKey: JSON.stringify([rule.issuer, !outgoing, cents, currency]),
      ordinal,
    };
    let dates = candidates.get(candidate.key);
    if (!dates) {
      dates = new Map();
      candidates.set(candidate.key, dates);
    }
    const indexes = dates.get(ordinal);
    if (indexes) indexes.push(index);
    else dates.set(ordinal, [index]);
    return candidate;
  });
  const uniqueMatches = new Map<number, number>();
  metadata.forEach((candidate, index) => {
    if (!candidate) return;
    const matches = counterpartIndexes(candidate, candidates, -1, 5);
    const first = matches.next();
    if (!first.done && matches.next().done) uniqueMatches.set(index, first.value);
  });
  // Require uniqueness in both directions, not a greedy first match.
  return new Map([...uniqueMatches].filter(([index, counterpart]) => uniqueMatches.get(counterpart) === index));
}

function creditBatchCandidate(
  transaction: TransactionRecord,
  accountsByProviderId: Map<string, BankAccount>,
): { key: string; type: "treasury-payment" | "travel-reward" } | null {
  const name = stringField(transaction, "name")?.trim();
  const amount = numberField(transaction, "amount");
  const accountId = stringField(transaction, "account_id");
  const date = stringField(transaction, "date");
  const currency = currencyCode(transaction);
  const ordinal = date ? dateOrdinal(date) : null;
  const account = accountId ? accountsByProviderId.get(accountId) : undefined;
  // Match only observed descriptors and their expected account types.
  const type = name && /^APA\s+TREAS\s+310\s+MISC\s+PAY\s*~\s*Future Amount:\s*\d+(?:\.\d{1,2})?\s*~\s*Tran:\s*DDIR$/i.test(name)
    && account?.type === "depository" ? "treasury-payment"
    : name && /^CREDIT-TRAVEL\s+REWARD\s+CREDIT-TRAVEL\s+REWARD$/i.test(name)
      && account?.type === "credit" && account.subtype === "credit card"
      && /^Capital\s*One$/i.test(account.institutionName.trim()) ? "travel-reward" : null;
  if (!type || transaction["pending"] === true || amount === null || amount >= 0
    || !Number.isSafeInteger(Math.round(-amount * 100)) || Math.round(-amount * 100) === 0
    || !accountId
    || !currency || ordinal === null
    || new Date(ordinal * 86_400_000).toISOString().slice(0, 10) !== date) return null;
  return { key: JSON.stringify([type, accountId, currency, date]), type };
}

export function getCreditBatchAmount(transactions: TransactionRecord[]): number {
  return transactions.reduce((cents, transaction) => cents - Math.round(numberField(transaction, "amount")! * 100), 0) / 100;
}

export function groupInternalTransfers(
  transactions: TransactionRecord[],
  accounts: BankAccount[],
): TransactionGroup[] {
  const accountsByProviderId = new Map<string, BankAccount>();
  for (const account of accounts) {
    if (account.providerAccountId) accountsByProviderId.set(account.providerAccountId, account);
  }
  const paymentPairs = creditCardPaymentPairs(transactions, accountsByProviderId);
  const creditBatches = new Map<string, number[]>();
  const creditCandidates = transactions.map((transaction, index) => {
    const candidate = transaction ? creditBatchCandidate(transaction, accountsByProviderId) : null;
    if (candidate !== null) {
      const indexes = creditBatches.get(candidate.key);
      if (indexes) indexes.push(index);
      else creditBatches.set(candidate.key, [index]);
    }
    return candidate;
  });

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

    const creditCandidate = creditCandidates[index];
    const creditIndexes = creditCandidate ? creditBatches.get(creditCandidate.key) : undefined;
    if (creditCandidate && creditIndexes && (creditIndexes.length > 1 || creditCandidate.type === "travel-reward")) {
      creditIndexes.forEach((candidateIndex) => consumed.add(candidateIndex));
      groups.push({
        type: creditCandidate.type,
        transactions: creditIndexes.map((candidateIndex) => transactions[candidateIndex]!),
        receivingAccount: accountsByProviderId.get(stringField(transaction, "account_id")!)!,
      });
      continue;
    }

    const paymentIndex = paymentPairs.get(index);
    const paymentCounterpart = paymentIndex === undefined ? undefined : transactions[paymentIndex];
    if (paymentIndex !== undefined && paymentCounterpart && !consumed.has(paymentIndex)) {
      const outgoing = numberField(transaction, "amount")! > 0 ? transaction : paymentCounterpart;
      const incoming = outgoing === transaction ? paymentCounterpart : transaction;
      const fromAccount = accountsByProviderId.get(stringField(outgoing, "account_id")!)!;
      const toAccount = accountsByProviderId.get(stringField(incoming, "account_id")!)!;
      consumed.add(paymentIndex);
      groups.push({ type: "credit-card-payment", transactions: [transaction, paymentCounterpart], fromAccount, toAccount });
      continue;
    }

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
  responsiveActivity = false,
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
          ${responsiveActivity ? `<span class="transaction-desktop-date">${escapeHtml(date + pending)}</span>` : ""}
          ${hideDate ? "" : `<span${responsiveActivity ? ' class="transaction-mobile-date"' : ""}>${escapeHtml(date)}</span>`}
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

export function renderRecentTransactionList(
  transactions: TransactionRecord[],
  accounts: BankAccount[],
  limit = 5,
): string {
  const sorted = [...transactions].sort((left, right) =>
    (stringField(right, "date") ?? "").localeCompare(stringField(left, "date") ?? ""),
  );
  const groups = groupInternalTransfers(sorted, accounts).sort((left, right) =>
    (getTransactionGroupDate(right) ?? "").localeCompare(getTransactionGroupDate(left) ?? ""),
  );
  // Sort complete groups before limiting summaries so original records stay together.
  return renderTransactionGroups(groups.slice(0, limit), accounts);
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
    const date = getTransactionGroupDate(group);
    const heading = options.groupByDate === true && date !== previousDate
      ? `<h3 class="transaction-date-heading">${escapeHtml(date ?? "Date unavailable")}</h3>`
      : "";
    previousDate = date;
    if (group.type === "single") return heading + renderTransactionRow(group.transactions[0], accounts, options.showAccount === true, options.groupByDate === true || options.activityStyle === true, options.groupByDate === true, options.responsiveActivity === true);
    if (group.type === "treasury-payment" || group.type === "travel-reward") {
      const travelReward = group.type === "travel-reward";
      return `${heading}
        <details class="transaction-transfer-pair">
          <summary aria-label="Expand or collapse original ${travelReward ? "travel reward credits" : "TreasuryDirect payments"}">
            <div class="transaction-copy transfer-pair-copy">
              <strong>${travelReward ? "Travel rewards" : "TreasuryDirect"} → ${escapeHtml(group.receivingAccount.name)}</strong>
              <span>${escapeHtml(date ?? "Date unavailable")}</span>
              <span class="transaction-group-type">${travelReward ? "Travel rewards" : "Bond payments"} · ${group.transactions.length} ${group.transactions.length === 1 ? "transaction" : "transactions"}</span>
            </div>
            <b class="transfer-pair-amount">${escapeHtml(formatTransactionAmount(-getCreditBatchAmount(group.transactions), currencyCode(group.transactions[0]!)))}</b>
          </summary>
          <div class="transfer-pair-rows">
            <div class="transfer-pair-details-label">Original ${travelReward ? "credits" : "payments"}</div>
            ${group.transactions.map((transaction) => renderTransactionRow(transaction, accounts, options.showAccount === true)).join("")}
          </div>
        </details>
      `;
    }
    const dateLabel = dates[0] === dates.at(-1) ? dates[0] : `${dates[0]} – ${dates.at(-1)}`;
    const amountTransaction = group.transactions.find((transaction) => numberField(transaction, "amount") !== null);
    const transferAmount = amountTransaction ? Math.abs(numberField(amountTransaction, "amount") ?? 0) : Number.NaN;
    const amountCurrency = amountTransaction ? currencyCode(amountTransaction) : null;
    const groupLabel = group.type === "credit-card-payment" ? "Credit Card Payment" : "Transfer";
    const detailLabel = group.type === "credit-card-payment" ? "credit card payment" : "transfer";
    return `${heading}
      <details class="transaction-transfer-pair">
        <summary aria-label="Expand or collapse original ${detailLabel} transactions">
          <div class="transaction-copy transfer-pair-copy">
            <strong>${escapeHtml(group.fromAccount.name)} → ${escapeHtml(group.toAccount.name)}</strong>
            <span>${escapeHtml(dateLabel ?? "Date unavailable")}</span>
            <span class="transaction-group-type">${groupLabel}</span>
          </div>
          <b class="transfer-pair-amount">${escapeHtml(formatTransactionAmount(-transferAmount, amountCurrency))}</b>
        </summary>
        <div class="transfer-pair-rows">
          <div class="transfer-pair-details-label">Transactions included in this ${detailLabel}</div>
          ${group.transactions.map((transaction) => renderTransactionRow(transaction, accounts, options.showAccount === true)).join("")}
        </div>
      </details>
    `;
  }).join("");
}
