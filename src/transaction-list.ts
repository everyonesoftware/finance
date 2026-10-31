import type { BankAccount } from "./bank_accounts.ts";
import { findReferencedAccount, formatTransactionAmount, renderLinkedTransactionName } from "./account-transaction-utils.ts";
import { escapeHtml } from "./html-utils.ts";

export type TransactionRecord = Record<string, unknown>;

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
  accountsByPlaidId: Map<string, BankAccount>,
  accounts: BankAccount[],
): { fromAccount: BankAccount; toAccount: BankAccount } | null {
  const name = stringField(transaction, "name");
  const amount = numberField(transaction, "amount");
  const receivingAccountId = stringField(transaction, "account_id");
  const referenceMatch = name?.match(/\bX\d{4,}(\d{4})\b/i);
  if (
    !name ||
    !/\bFID\s+BKG\s+SVC\s+LLC\s+ACH\b/i.test(name) ||
    !referenceMatch?.[1] ||
    amount === null || amount >= 0 ||
    !receivingAccountId
  ) return null;

  const toAccount = accountsByPlaidId.get(receivingAccountId);
  if (!toAccount || toAccount.type !== "depository") return null;
  const sourceMask = referenceMatch[1];
  const sourceAccounts = accounts.filter((account) => {
    const accountMask = account.mask?.replace(/\D/g, "");
    return account.type === "investment" &&
      /\bfidelity\b/i.test(account.institutionName) &&
      accountMask?.endsWith(sourceMask);
  });
  if (sourceAccounts.length !== 1 || sourceAccounts[0]?.id === toAccount.id) return null;
  const fromAccount = sourceAccounts[0];
  return fromAccount ? { fromAccount, toAccount } : null;
}

function plausiblePair(
  first: TransactionRecord,
  second: TransactionRecord,
  accountsByPlaidId: Map<string, BankAccount>,
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

  const firstAccount = accountsByPlaidId.get(firstId);
  const secondAccount = accountsByPlaidId.get(secondId);
  if (!firstAccount || !secondAccount) return null;
  const firstReference = findReferencedAccount(firstName, accounts);
  const secondReference = findReferencedAccount(secondName, accounts);
  if (firstReference?.plaidAccountId !== secondId || secondReference?.plaidAccountId !== firstId) return null;

  const toTransaction = firstDirection === "to" ? first : second;
  const fromTransaction = firstDirection === "from" ? first : second;
  const fromAccount = accountsByPlaidId.get(stringField(toTransaction, "account_id") ?? "");
  const toAccount = findReferencedAccount(stringField(toTransaction, "name") ?? "", accounts);
  if (!fromAccount || !toAccount || fromAccount.id === toAccount.id) return null;

  // The incoming-side transaction must belong to the receiving account.
  const incomingAccountId = stringField(fromTransaction, "account_id");
  if (incomingAccountId !== toAccount.plaidAccountId) return null;
  return { fromAccount, toAccount };
}

export function groupInternalTransfers(
  transactions: TransactionRecord[],
  accounts: BankAccount[],
): TransactionGroup[] {
  const accountsByPlaidId = new Map<string, BankAccount>();
  for (const account of accounts) {
    if (account.plaidAccountId) accountsByPlaidId.set(account.plaidAccountId, account);
  }

  const groups: TransactionGroup[] = [];
  const consumed = new Set<number>();
  for (let index = 0; index < transactions.length; index += 1) {
    if (consumed.has(index)) continue;
    const transaction = transactions[index];
    if (!transaction) continue;

    let counterpartIndex = -1;
    let pairedAccounts: { fromAccount: BankAccount; toAccount: BankAccount } | null = null;
    for (let candidateIndex = index + 1; candidateIndex < transactions.length; candidateIndex += 1) {
      if (consumed.has(candidateIndex)) continue;
      const candidate = transactions[candidateIndex];
      if (!candidate) continue;
      const pair = plausiblePair(transaction, candidate, accountsByPlaidId, accounts);
      if (pair) {
        counterpartIndex = candidateIndex;
        pairedAccounts = pair;
        break;
      }
    }

    if (counterpartIndex < 0) {
      const describedTransfer = getFidelityAchTransferAccounts(transaction, accountsByPlaidId, accounts);
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

function renderTransactionRow(transaction: TransactionRecord, accounts: BankAccount[]): string {
  const name = stringField(transaction, "name") ?? "Transaction";
  const date = stringField(transaction, "date") ?? "Date unavailable";
  const pending = transaction["pending"] === true ? " · Pending" : "";
  const amount = numberField(transaction, "amount") ?? Number.NaN;
  return `
    <div class="account-row transaction-row">
      <div class="transaction-copy">
        <strong>${renderLinkedTransactionName(name, accounts)}</strong>
        <span>${escapeHtml(date + pending)}</span>
      </div>
      <b>${escapeHtml(formatTransactionAmount(amount, currencyCode(transaction)))}</b>
    </div>
  `;
}

export function renderTransactionList(
  transactions: TransactionRecord[],
  accounts: BankAccount[],
): string {
  const groups = groupInternalTransfers(transactions, accounts);
  if (groups.length === 0) return "No transactions yet. Connect a bank and sync to get started.";

  return groups.map((group): string => {
    if (group.type === "single") return renderTransactionRow(group.transactions[0], accounts);
    const dates = group.transactions
      .map((transaction) => stringField(transaction, "date"))
      .filter((date): date is string => date !== null)
      .sort();
    const dateLabel = dates[0] === dates.at(-1) ? dates[0] : `${dates[0]} – ${dates.at(-1)}`;
    const amountTransaction = group.transactions.find((transaction) => numberField(transaction, "amount") !== null);
    const transferAmount = amountTransaction ? Math.abs(numberField(amountTransaction, "amount") ?? 0) : Number.NaN;
    const amountCurrency = amountTransaction ? currencyCode(amountTransaction) : null;
    return `
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
          ${group.transactions.map((transaction) => renderTransactionRow(transaction, accounts)).join("")}
        </div>
      </details>
    `;
  }).join("");
}
