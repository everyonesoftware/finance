import type { BankAccount } from "./bank_accounts.ts";
import type { TransactionGroup } from "./transaction-list.ts";

export type TransactionSortOrder = "date-desc" | "date-asc" | "amount-desc" | "amount-asc";

export interface TransactionListFilters {
  includeAccountIds: string[];
  excludeAccountIds: string[];
  minimumAmount: number;
  maximumAmount: number;
  sort: TransactionSortOrder;
}

export function getAccountSelectionOnLoad(
  accountIds: string[],
  previouslyAvailableAccountIds: string[] | null,
  previouslySelectedAccountIds: string[],
): string[] {
  const previouslySelected = new Set(previouslySelectedAccountIds);
  if (previouslyAvailableAccountIds === null || previouslyAvailableAccountIds.every((id) => previouslySelected.has(id))) {
    return [...accountIds];
  }
  return accountIds.filter((id) => previouslySelected.has(id));
}

export function getTransactionGroupAmount(group: TransactionGroup): number | null {
  const transaction = group.transactions.find((candidate) =>
    typeof candidate.amount === "number" && Number.isFinite(candidate.amount),
  );
  if (!transaction || typeof transaction.amount !== "number") return null;
  return group.type === "transfer" ? Math.abs(transaction.amount) : -transaction.amount;
}

export function getTransactionGroupDate(group: TransactionGroup): string | null {
  const dates = group.transactions
    .map((transaction) => transaction.date)
    .filter((date): date is string => typeof date === "string" && date.length > 0)
    .sort();
  return dates[0] ?? null;
}

function getTransactionGroupAccountIds(
  group: TransactionGroup,
  accountsByPlaidId: Map<string, BankAccount>,
): string[] {
  if (group.type === "transfer") return [group.fromAccount.id, group.toAccount.id];
  const accountId = group.transactions[0].account_id;
  if (typeof accountId !== "string") return [];
  const account = accountsByPlaidId.get(accountId);
  return account ? [account.id] : [];
}

export function filterAndSortTransactionGroups(
  groups: TransactionGroup[],
  accounts: BankAccount[],
  filters: TransactionListFilters,
): TransactionGroup[] {
  const accountsByPlaidId = new Map<string, BankAccount>();
  for (const account of accounts) {
    if (account.plaidAccountId) accountsByPlaidId.set(account.plaidAccountId, account);
  }

  const included = new Set(filters.includeAccountIds);
  const excluded = new Set(filters.excludeAccountIds);
  const matches = groups.flatMap((group, index) => {
    const accountIds = getTransactionGroupAccountIds(group, accountsByPlaidId);
    if (included.size === 0 || !accountIds.some((id) => included.has(id))) return [];
    if (accountIds.some((id) => excluded.has(id))) return [];

    const amount = getTransactionGroupAmount(group);
    if (amount === null || amount < filters.minimumAmount || amount > filters.maximumAmount) return [];
    return [{ group, index, amount, date: getTransactionGroupDate(group) ?? "" }];
  });

  matches.sort((left, right) => {
    let comparison = 0;
    switch (filters.sort) {
      case "date-asc":
        comparison = left.date.localeCompare(right.date);
        break;
      case "amount-desc":
        comparison = right.amount - left.amount;
        break;
      case "amount-asc":
        comparison = left.amount - right.amount;
        break;
      case "date-desc":
      default:
        comparison = right.date.localeCompare(left.date);
        break;
    }
    return comparison || left.index - right.index;
  });

  return matches.map(({ group }) => group);
}
