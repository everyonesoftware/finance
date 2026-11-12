import type { BankAccount } from "./bank_accounts.ts";
import { readTransactionFile } from "./account-import-workflow.ts";
import { escapeHtml } from "./html-utils.ts";
import { renderBalanceImpact, type BalanceImpact } from "./account-balance.ts";

type CsvMapping = Partial<Record<"dateColumn" | "nameColumn" | "amountColumn" | "debitColumn" | "creditColumn" | "idColumn", number>> & { dateFormat: string; amountConvention: string };
interface ImportFile { fileName: string; content: string; accountId?: string; csv?: CsvMapping }
interface FilePreview {
  fileName: string; accountId: string | null; status: "ready" | "needs-account" | "error";
  reason: string; total: number; duplicates: number; importable: number;
  errors: string[]; columns: string[]; mapping: CsvMapping | null; notes?: string[];
  balanceImpact?: BalanceImpact;
}
interface ReviewRow { fileName: string; request?: ImportFile; preview?: FilePreview; error?: string; csvOpen?: boolean }

export function renderBatchImportDialog(): string {
  return `<dialog id="batch-import-dialog" class="account-workflow-dialog batch-import-dialog" aria-labelledby="batch-import-title">
    <form id="batch-import-form" class="account-workflow">
      <header><p class="eyebrow">TRANSACTION IMPORT</p><h2 id="batch-import-title">Import Transactions</h2><p>Choose your exports, review the destinations, then approve the import.</p></header>
      <div class="account-workflow-body">
        <label class="form-field"><span>Transaction files</span><input id="batch-import-files" type="file" accept=".csv,.ofx,.qfx" multiple><small>CSV, OFX, or QFX · up to 30 files, 4 MB each, 32 MB per batch. Selecting again replaces this batch.</small></label>
        <p class="account-workflow-note">Accounts are matched only when identifying information is unambiguous. Choose a destination when asked. Duplicates in saved activity and across these files are excluded. Review the balance impact before approval. You can adjust the known balance after importing on the account page.</p>
        <p id="batch-import-summary" role="status" aria-live="polite">Select files to prepare a review. Nothing is saved until you approve.</p>
        <div class="batch-import-table-wrap"><table class="batch-import-table"><thead><tr><th scope="col">File</th><th scope="col">Destination account</th><th scope="col">Status</th><th scope="col">Transactions</th></tr></thead><tbody id="batch-import-rows"></tbody></table></div>
        <div id="batch-balance-impacts"></div>
      </div>
      <p id="batch-import-error" class="auth-message error" role="alert" hidden></p>
      <footer class="account-workflow-actions"><button id="batch-import-cancel" class="secondary-button" type="button">Cancel</button><button id="batch-import-confirm" class="primary-button" type="submit" disabled>Import transactions</button></footer>
    </form>
  </dialog>`;
}

const mappingFields = [["dateColumn", "Date"], ["nameColumn", "Description"], ["amountColumn", "Signed amount"], ["debitColumn", "Debit"], ["creditColumn", "Credit"], ["idColumn", "Transaction ID"]] as const;
function renderCsvOptions(row: ReviewRow, index: number): string {
  if (!row.request || !/\.csv$/i.test(row.fileName)) return "";
  const mapping = { ...row.preview?.mapping, ...row.request.csv };
  const columns = row.preview?.columns ?? [];
  const select = (key: string, label: string, options: Array<[string, string]>, current: string) => `<label class="form-field"><span>${label}</span><select data-batch-csv="${index}" data-field="${key}" aria-label="${label} for ${escapeHtml(row.fileName)}">${options.map(([value, text]) => `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(text)}</option>`).join("")}</select></label>`;
  return `<details class="batch-csv-options"${row.csvOpen ? " open" : ""}><summary>CSV options</summary><div class="account-form-grid">${select("dateFormat", "Date format", [["mdy", "Month / day / year"], ["dmy", "Day / month / year"], ["ymd", "Year / month / day"]], mapping?.dateFormat ?? "mdy")}${select("amountConvention", "Signed amounts", [["inflow-positive", "Positive = money in"], ["outflow-positive", "Positive = money out"]], mapping?.amountConvention ?? "inflow-positive")}${columns.length ? mappingFields.map(([key, label]) => select(key, label, [["", "Not used"], ...columns.map((name, column): [string, string] => [String(column), `${column + 1}. ${name || "Unnamed column"}`])], mapping?.[key] === undefined ? "" : String(mapping[key]))).join("") : ""}</div><small>Use either a signed amount or debit and credit columns, not both. Changes recalculate the entire batch.</small></details>`;
}

export function initializeBatchImport(getAccounts: () => BankAccount[], onImported: () => Promise<void>, signal?: AbortSignal): void {
  const dialog = document.querySelector<HTMLDialogElement>("#batch-import-dialog");
  const form = document.querySelector<HTMLFormElement>("#batch-import-form");
  const trigger = document.querySelector<HTMLButtonElement>("#open-batch-import");
  const files = document.querySelector<HTMLInputElement>("#batch-import-files");
  const table = document.querySelector<HTMLTableSectionElement>("#batch-import-rows");
  const balanceImpacts = document.querySelector<HTMLElement>("#batch-balance-impacts");
  const summary = document.querySelector<HTMLElement>("#batch-import-summary");
  const error = document.querySelector<HTMLElement>("#batch-import-error");
  const confirm = document.querySelector<HTMLButtonElement>("#batch-import-confirm");
  const cancel = document.querySelector<HTMLButtonElement>("#batch-import-cancel");
  if (!dialog || !form || !trigger || !files || !table || !summary || !error || !confirm || !cancel) return;
  const isActive = () => !signal?.aborted && dialog.isConnected !== false && form.isConnected !== false;
  let rows: ReviewRow[] = [];
  let busy = false;
  let approvedPreview = false;
  let previewToken: string | undefined;
  let focusSelector: string | null = null;
  const eligible = () => getAccounts().filter(account => account.canImport);
  const total = () => approvedPreview ? rows.reduce((sum, row) => sum + (row.preview?.importable ?? 0), 0) : 0;
  const canImport = () => approvedPreview && rows.length > 0 && rows.every(row => row.request && !row.error && row.preview?.status === "ready" && row.preview.accountId) && total() > 0;
  const showError = (message = "") => { if (!isActive()) return; error.textContent = message; error.hidden = !message; };
  const invalidatePreview = () => { approvedPreview = false; previewToken = undefined; };
  function render(): void {
    if (!isActive()) return;
    const focused = document.activeElement as HTMLElement | null;
    const active = focused && form!.contains(focused) ? focused : null;
    if (active?.dataset?.batchAccount !== undefined) focusSelector = `[data-batch-account="${active.dataset.batchAccount}"]`;
    else if (active?.dataset?.batchCsv !== undefined && active.dataset.field) focusSelector = `[data-batch-csv="${active.dataset.batchCsv}"][data-field="${active.dataset.field}"]`;
    table!.innerHTML = rows.map((row, index) => {
      const preview = row.preview;
      const status = row.error ? "Error" : !approvedPreview ? busy ? "Checking…" : "Needs preview" : preview?.status === "error" ? "Error" : preview?.status === "needs-account" ? "Needs account" : "Ready";
      const count = row.error ? "Cannot import" : !approvedPreview ? "Recalculate to update counts" : preview?.status === "error" ? "Cannot import" : preview?.status === "needs-account" ? "Choose an account to calculate" : preview ? `Import ${preview.importable} of ${preview.total} transactions` : "Calculating…";
      const reason = row.error ?? (approvedPreview ? [...(preview?.errors ?? []), preview?.reason ?? ""].filter(Boolean).join(" ") : "A fresh preview is required before approval.");
      return `<tr><td data-label="File"><strong>${escapeHtml(row.fileName)}</strong><button type="button" class="batch-remove" data-batch-remove="${index}" aria-label="Remove ${escapeHtml(row.fileName)}">Remove</button></td>
        <td data-label="Destination account"><select data-batch-account="${index}" aria-label="Destination account for ${escapeHtml(row.fileName)}"><option value="">Choose account…</option>${eligible().map(account => `<option value="${escapeHtml(account.id)}"${row.request?.accountId === account.id ? " selected" : ""}>${escapeHtml(`${account.institutionName} · ${account.name}${account.mask ? ` •${account.mask}` : ""}`)}</option>`).join("")}</select>${renderCsvOptions(row, index)}</td>
        <td data-label="Status"><strong class="batch-status" data-status="${status === "Ready" ? "ready" : "attention"}">${status}</strong><small>${escapeHtml(reason)}</small>${(preview?.notes ?? []).map(note => `<small>${escapeHtml(note)}</small>`).join("")}</td>
        <td data-label="Transactions">${count}${approvedPreview && preview?.status === "ready" ? `<small>${preview.duplicates} duplicate${preview.duplicates === 1 ? "" : "s"} excluded</small>` : ""}</td></tr>`;
    }).join("");
    files!.disabled = busy;
    if (balanceImpacts) balanceImpacts.innerHTML = approvedPreview ? rows.map(row => {
      const preview = row.preview;
      if (row.error || preview?.status !== "ready" || !preview.balanceImpact) return "";
      const account = eligible().find(account => account.id === preview.accountId);
      if (!account) return "";
      const label = `${row.fileName} · ${account.institutionName} · ${account.name}${account.mask ? ` •${account.mask}` : ""}`;
      return renderBalanceImpact(preview.balanceImpact, account.currencyCode ?? "USD", label);
    }).join("") : "";
    cancel!.disabled = busy;
    for (const control of table!.querySelectorAll<HTMLSelectElement | HTMLButtonElement>("select, button")) control.disabled = busy;
    const canRetry = !approvedPreview && rows.some(row => row.request);
    confirm!.disabled = busy || (!canImport() && !canRetry);
    confirm!.textContent = busy ? "Processing…" : canRetry ? "Retry preview" : `Import ${total()} transaction${total() === 1 ? "" : "s"}`;
    if (!busy && focusSelector) {
      form!.querySelector<HTMLElement>(focusSelector)?.focus();
      focusSelector = null;
    }
    const allReady = approvedPreview && rows.every(row => !row.error && row.preview?.status === "ready");
    summary!.textContent = busy ? "Checking files and recalculating the batch…" : rows.length ? `${rows.length} file${rows.length === 1 ? "" : "s"} · ${total()} new transactions. ${canImport() ? "Ready for approval." : allReady ? "No new transactions to import." : "Resolve flagged files or remove them before importing."}` : "Select files to prepare a review. Nothing is saved until you approve.";
  }
  async function post<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok) throw Object.assign(new Error([payload.error, ...(payload.errors ?? [])].filter(Boolean).join("\n") || "Import request failed."), { status: response.status });
    return payload as T;
  }
  async function preview(): Promise<void> {
    if (!isActive()) return;
    invalidatePreview();
    busy = true;
    showError();
    render();
    try {
      const validRows = rows.filter(row => row.request);
      if (validRows.length) {
        const payload = await post<{ files: FilePreview[]; previewToken?: string }>("/api/accounts/import-batch/preview", { files: validRows.map(row => row.request) });
        if (!isActive()) return;
        if (!Array.isArray(payload.files) || payload.files.length !== validRows.length) throw new Error("The server returned an invalid batch preview.");
        validRows.forEach((row, index) => {
          row.preview = payload.files[index];
          if (row.preview.accountId) row.request!.accountId = row.preview.accountId;
        });
        previewToken = payload.previewToken;
      }
      approvedPreview = true;
    } catch (cause) { showError(cause instanceof Error ? cause.message : "Unable to preview files."); }
    finally { busy = false; render(); }
  }
  trigger.addEventListener("click", () => {
    if (!isActive() || busy) return;
    rows = []; files.value = ""; invalidatePreview(); focusSelector = null; showError(); render();
    if (!eligible().length) showError("No importable accounts are available. Add a manual account on the Accounts page first.");
    dialog.showModal();
  });
  cancel.addEventListener("click", () => { if (isActive() && !busy) dialog.close(); });
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  files.addEventListener("change", async () => {
    if (!isActive() || busy) return;
    invalidatePreview(); rows = []; showError();
    const selected = [...(files.files ?? [])];
    if (selected.length > 30 || selected.reduce((sum, file) => sum + file.size, 0) > 32 * 1024 * 1024) {
      showError("Choose no more than 30 files and 32 MB in total."); render(); return;
    }
    busy = true; render();
    for (const file of selected) {
      if (!isActive()) return;
      const row: ReviewRow = { fileName: file.name }; rows.push(row);
      try {
        if (!/\.(csv|ofx|qfx)$/i.test(file.name)) throw new Error("Choose a CSV, OFX, or QFX file.");
        if (file.size > 4 * 1024 * 1024) throw new Error("File exceeds 4 MB.");
        row.request = { fileName: file.name, content: await readTransactionFile(file), ...(/\.csv$/i.test(file.name) ? { csv: { dateFormat: "mdy", amountConvention: "inflow-positive" } } : {}) };
        if (!isActive()) return;
      } catch (cause) { row.error = cause instanceof Error ? cause.message : "Unable to read file."; }
    }
    busy = false;
    await preview();
  });
  table.addEventListener("change", async event => {
    if (!isActive() || busy) return;
    const target = event.target as HTMLSelectElement;
    const index = target.dataset.batchAccount ?? target.dataset.batchCsv;
    if (index === undefined) return;
    const row = rows[Number(index)];
    if (!row?.request) return;
    if (target.dataset.batchAccount !== undefined) {
      row.request.accountId = target.value || undefined;
    } else {
      row.csvOpen = true;
      const mapping: CsvMapping = { dateFormat: "mdy", amountConvention: "inflow-positive", ...(row.preview?.mapping ?? {}), ...row.request.csv };
      const field = target.dataset.field as keyof CsvMapping;
      if (field === "dateFormat" || field === "amountConvention") mapping[field] = target.value;
      else if (mappingFields.some(([key]) => key === field)) {
        if (target.value === "") delete mapping[field];
        else mapping[field] = Number(target.value);
      }
      row.request.csv = mapping;
    }
    await preview();
  });
  table.addEventListener("click", async event => {
    if (!isActive() || busy) return;
    const index = (event.target as HTMLButtonElement).dataset.batchRemove;
    if (index === undefined) return;
    rows.splice(Number(index), 1);
    await preview();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!isActive() || busy) return;
    if (!approvedPreview && rows.some(row => row.request)) { await preview(); return; }
    if (!canImport()) return;
    busy = true; showError(); render();
    try {
      const result = await post<{ imported: number; skipped: number }>("/api/accounts/import-batch", { files: rows.map(row => row.request), previewToken });
      if (!isActive()) return;
      invalidatePreview();
      rows = []; files.value = "";
      dialog.close();
      try { await onImported(); }
      catch { if (isActive()) { showError(`Imported ${result.imported} transactions, but the page could not refresh. Reload to see them.`); dialog.showModal(); } }
    } catch (cause) {
      if (cause instanceof Error && "status" in cause && cause.status === 409) invalidatePreview();
      showError(cause instanceof Error ? cause.message : "Unable to import files.");
    }
    finally { busy = false; render(); }
  });
}
