import { escapeHtml } from "./html-utils.ts";
import { formatTransactionAmount } from "./account-transaction-utils.ts";
import type { BankAccount } from "./bank_accounts.ts";
import { getCreditBatchAmount, type TransactionGroup } from "./transaction-list.ts";

export type TransactionSortOrder = "date-desc" | "date-asc" | "amount-desc" | "amount-asc";

export interface TransactionListFilters {
  includeAccountIds: string[];
  excludeAccountIds: string[];
  minimumAmount: number;
  maximumAmount: number;
  sort: TransactionSortOrder;
  searchQuery?: string;
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

export function updateSelectedAccountIds(
  selectedAccountIds: string[],
  targetAccountIds: string[],
  shouldSelect: boolean,
): string[] {
  const selected = new Set(selectedAccountIds);
  for (const accountId of targetAccountIds) {
    if (shouldSelect) selected.add(accountId);
    else selected.delete(accountId);
  }
  return [...selected];
}

export function clampTransactionAmountRange(
  minimum: number,
  maximum: number,
  lowerBound: number,
  upperBound: number,
): { minimum: number; maximum: number } {
  const clampToBounds = (amount: number): number =>
    Number(Math.min(upperBound, Math.max(lowerBound, amount)).toFixed(2));
  return { minimum: clampToBounds(minimum), maximum: clampToBounds(maximum) };
}

export function updateTransactionAmountRange(
  minimum: number,
  maximum: number,
  changedHandle: "minimum" | "maximum",
  value: number,
  lowerBound: number,
  upperBound: number,
): { minimum: number; maximum: number } {
  const currentRange = clampTransactionAmountRange(minimum, maximum, lowerBound, upperBound);
  const changedValue = clampTransactionAmountRange(value, value, lowerBound, upperBound).minimum;
  if (changedHandle === "minimum") {
    return { minimum: changedValue, maximum: Math.max(currentRange.maximum, changedValue) };
  }
  return { minimum: Math.min(currentRange.minimum, changedValue), maximum: changedValue };
}

export function parseAmountRangeInput(value: string): number | null {
  const normalized = value.trim();
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

export function reconcileAmountRangeInput(value: string, appliedValue: number): string {
  return parseAmountRangeInput(value) === appliedValue ? value : String(appliedValue);
}

export function getFuzzyMatchPositions(query: string, text: string): number[] | null {
  if (query.trim().length === 0) return [];

  const isSearchCharacter = (character: string): boolean => /[\p{L}\p{N}]/u.test(character);
  const queryCharacters = Array.from(query.toLowerCase()).filter(isSearchCharacter);
  if (queryCharacters.length === 0) return null;

  const textCharacters = Array.from(text);
  const searchableText: { character: string; textIndex: number }[] = [];
  textCharacters.forEach((character, textIndex) => {
    if (!isSearchCharacter(character)) return;
    for (const normalizedCharacter of Array.from(character.toLowerCase())) {
      searchableText.push({ character: normalizedCharacter, textIndex });
    }
  });

  let bestPositions: number[] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let start = 0; start < searchableText.length; start++) {
    if (searchableText[start].character !== queryCharacters[0]) continue;
    const positions = [start];
    let cursor = start + 1;
    let matched = true;
    for (let queryIndex = 1; queryIndex < queryCharacters.length; queryIndex++) {
      while (cursor < searchableText.length && searchableText[cursor].character !== queryCharacters[queryIndex]) cursor++;
      if (cursor === searchableText.length) {
        matched = false;
        break;
      }
      positions.push(cursor++);
    }
    if (!matched) continue;

    const firstTextIndex = searchableText[start].textIndex;
    const previousCharacter = textCharacters[firstTextIndex - 1] ?? "";
    const startsAtWord = firstTextIndex === 0 || !isSearchCharacter(previousCharacter);
    const gaps = positions.at(-1)! - positions[0] - queryCharacters.length + 1;
    const score = gaps * 100 + start - (startsAtWord ? 2 : 0);
    if (score < bestScore) {
      bestScore = score;
      bestPositions = positions.map((position) => searchableText[position].textIndex);
    }
  }
  return bestPositions;
}

export function renderFuzzyHighlightedText(text: string, positions: number[]): string {
  const matchedPositions = new Set(positions);
  const characters = Array.from(text);
  let output = "";
  let highlighting = false;
  characters.forEach((character, index) => {
    const shouldHighlight = matchedPositions.has(index);
    if (shouldHighlight && !highlighting) output += "<mark>";
    if (!shouldHighlight && highlighting) output += "</mark>";
    output += escapeHtml(character);
    highlighting = shouldHighlight;
  });
  if (highlighting) output += "</mark>";
  return output;
}

export function getTransactionGroupAmount(group: TransactionGroup): number | null {
  if (group.type === "treasury-payment" || group.type === "travel-reward") return getCreditBatchAmount(group.transactions);
  const transaction = group.transactions.find((candidate) =>
    typeof candidate.amount === "number" && Number.isFinite(candidate.amount),
  );
  if (!transaction || typeof transaction.amount !== "number") return null;
  return group.type !== "single" ? Math.abs(transaction.amount) : -transaction.amount;
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
  accountsByProviderId: Map<string, BankAccount>,
): string[] {
  if (group.type === "treasury-payment" || group.type === "travel-reward") return [group.receivingAccount.id];
  if (group.type !== "single") return [group.fromAccount.id, group.toAccount.id];
  const accountId = group.transactions[0].account_id;
  if (typeof accountId !== "string") return [];
  const account = accountsByProviderId.get(accountId);
  return account ? [account.id] : [];
}

export function filterAndSortTransactionGroups(
  groups: TransactionGroup[],
  accounts: BankAccount[],
  filters: TransactionListFilters,
): TransactionGroup[] {
  const accountsByProviderId = new Map<string, BankAccount>();
  for (const account of accounts) {
    if (account.providerAccountId) accountsByProviderId.set(account.providerAccountId, account);
  }

  const included = new Set(filters.includeAccountIds);
  const excluded = new Set(filters.excludeAccountIds);
  const searchQuery = filters.searchQuery?.trim().toLowerCase() ?? "";
  const matchesText = (fields: unknown[]): boolean => fields.some((field) =>
    typeof field === "string" && field.toLowerCase().includes(searchQuery),
  );
  const matches = groups.flatMap((group, index) => {
    const amount = getTransactionGroupAmount(group);
    const first = group.transactions[0];
    const summaryCurrency = typeof first?.iso_currency_code === "string" ? first.iso_currency_code
      : typeof first?.unofficial_currency_code === "string" ? first.unofficial_currency_code : null;
    const creditBatch = group.type === "treasury-payment" || group.type === "travel-reward";
    const matchesGroup = searchQuery && group.type !== "single" && matchesText([
      group.type === "treasury-payment" ? `TreasuryDirect → ${group.receivingAccount.name}`
        : group.type === "travel-reward" ? `Travel rewards → ${group.receivingAccount.name}`
        : group.type === "credit-card-payment" ? "Credit Card Payment" : "Transfer",
      group.type === "treasury-payment" ? `Bond payments · ${group.transactions.length} transactions` : null,
      group.type === "travel-reward" ? `Travel rewards · ${group.transactions.length} ${group.transactions.length === 1 ? "transaction" : "transactions"}` : null,
      group.type === "travel-reward" ? "Original credits" : null,
      group.type === "treasury-payment" ? "Original payments" : null,
      creditBatch && amount !== null ? formatTransactionAmount(-amount, summaryCurrency) : null,
      ...(group.type === "treasury-payment" || group.type === "travel-reward" ? [group.receivingAccount] : [group.fromAccount, group.toAccount]).flatMap((account) =>
        [account.name, account.officialName, account.institutionName, account.mask],
      ),
    ]);
    if (searchQuery && !matchesGroup && !group.transactions.some((transaction) => {
      const account = typeof transaction.account_id === "string"
        ? accountsByProviderId.get(transaction.account_id)
        : undefined;
      const currency = typeof transaction.iso_currency_code === "string"
        ? transaction.iso_currency_code
        : typeof transaction.unofficial_currency_code === "string" ? transaction.unofficial_currency_code : null;
      const fields = [transaction.name, transaction.merchant_name, transaction.date,
        typeof transaction.amount === "number" && Number.isFinite(transaction.amount)
          ? formatTransactionAmount(transaction.amount, currency) : null,
        account?.name, account?.officialName, account?.institutionName, account?.mask];
      return matchesText(fields);
    })) return [];
    const accountIds = getTransactionGroupAccountIds(group, accountsByProviderId);
    if (included.size === 0 || !accountIds.some((id) => included.has(id))) return [];
    if (accountIds.some((id) => excluded.has(id))) return [];

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
