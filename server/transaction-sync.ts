export interface TransactionPage<T> {
  added: T[];
  modified: T[];
  removed: Array<{ transaction_id: string }>;
  next_cursor: string;
  has_more: boolean;
}

export interface TransactionBatch<T> {
  added: T[];
  modified: T[];
  removed: Array<{ transaction_id: string }>;
  cursor: string;
}

export async function collectTransactionPages<T>(
  fetchPage: (request: { cursor?: string }) => Promise<TransactionPage<T>>,
  initialCursor: string | undefined,
  maxPages = 100,
  maxRestarts = 3,
): Promise<TransactionBatch<T>> {
  for (let restart = 0; ; restart++) {
    let cursor = initialCursor;
    const added: T[] = [];
    const modified: T[] = [];
    const removed: Array<{ transaction_id: string }> = [];
    for (let pageCount = 0; pageCount < maxPages; pageCount++) {
      let page: TransactionPage<T>;
      try {
        page = await fetchPage(cursor === undefined ? {} : { cursor });
      } catch (error) {
        const code = (error as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code;
        if (code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && restart < maxRestarts) break;
        throw error;
      }
      added.push(...page.added);
      modified.push(...page.modified);
      removed.push(...page.removed);
      cursor = page.next_cursor;
      if (!page.has_more) return { added, modified, removed, cursor };
      if (pageCount === maxPages - 1) throw new Error(`Transaction sync exceeded the ${maxPages} page limit.`);
    }
    if (restart >= maxRestarts) throw new Error("Transaction sync exceeded the restart limit.");
  }
}

export function getRecentTransactions<T extends { date?: unknown }>(
  transactions: T[],
  limit = 50,
): T[] {
  return [...transactions]
    .sort((left, right) => {
      const leftDate = typeof left.date === "string" ? left.date : "";
      const rightDate = typeof right.date === "string" ? right.date : "";
      return rightDate.localeCompare(leftDate);
    })
    .slice(0, limit);
}
