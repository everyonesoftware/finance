import type { BankAccount } from "./bank_accounts.ts";
import { escapeHtml } from "./html-utils.ts";

export async function readTransactionFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  else if (/\.(ofx|qfx)$/i.test(file.name)) {
    const header = new TextDecoder("windows-1252").decode(bytes.slice(0, 512));
    const declared = /CHARSET\s*:\s*([^\s<]+)/i.exec(header)?.[1]
      ?? /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(header)?.[1];
    if (declared && !/^(none|usascii|ascii)$/i.test(declared)) {
      encoding = declared === "1252" ? "windows-1252" : declared === "65001" ? "utf-8" : declared;
    }
  }
  try {
    const content = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (content.includes("\0")) throw new Error("Invalid text encoding.");
    return content;
  } catch {
    throw new Error("The file's text encoding could not be read. Export or save it as UTF-8 and try again.");
  }
}

function showError(element: HTMLElement | null, message = ""): void {
  if (!element) return;
  element.textContent = message;
  element.hidden = !message;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new Error(payload?.error ?? "The request failed. Please try again.");
  return payload as T;
}

export function initializeManualAccountCreation(onCreated: (account: BankAccount) => Promise<void>): void {
  const dialog = document.querySelector<HTMLDialogElement>("#manual-account-dialog");
  const form = document.querySelector<HTMLFormElement>("#manual-account-form");
  const error = document.querySelector<HTMLElement>("#manual-account-error");
  const cancel = document.querySelector<HTMLButtonElement>("#cancel-manual-account");
  if (!dialog || !form) return;
  let busy = false;
  document.querySelector("#add-account")?.addEventListener("click", () => {
    showError(error);
    dialog.showModal();
  });
  cancel?.addEventListener("click", () => { if (!busy) dialog.close(); });
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(form);
    const [type, subtype] = String(data.get("accountKind")).split(":");
    const balance = String(data.get("currentBalance") ?? "").trim();
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    busy = true;
    if (submit) submit.disabled = true;
    if (cancel) cancel.disabled = true;
    showError(error);
    try {
      const result = await postJson<{ account: BankAccount }>("/api/accounts", {
        name: String(data.get("name") ?? "").trim(), institutionName: String(data.get("institutionName") ?? "").trim(),
        type, subtype, currencyCode: String(data.get("currencyCode") ?? "USD").trim().toUpperCase(),
        mask: String(data.get("mask") ?? "").trim() || undefined, currentBalance: balance === "" ? null : Number(balance),
      });
      dialog.close();
      form.reset();
      await onCreated(result.account);
    } catch (cause) {
      showError(error, cause instanceof Error ? cause.message : "Unable to create account.");
    } finally {
      busy = false;
      if (submit) submit.disabled = false;
      if (cancel) cancel.disabled = false;
    }
  });
}

interface CsvMapping {
  dateColumn?: number;
  nameColumn?: number;
  amountColumn?: number;
  debitColumn?: number;
  creditColumn?: number;
  idColumn?: number;
  dateFormat: string;
  amountConvention: string;
}
interface ImportRequest { fileName: string; content: string; csv?: CsvMapping }
interface ImportPreview {
  notes?: string[];
  columns: string[];
  mapping: CsvMapping | null;
  transactions: Array<{ date: string; name: string; amount: number; iso_currency_code: string }>;
  errors: string[];
  total: number;
  duplicates: number;
  importable: number;
}
export interface ImportResult { imported: number; skipped: number; account: BankAccount }

const columnFields = [
  ["dateColumn", "Date"], ["nameColumn", "Description"], ["amountColumn", "Signed amount"],
  ["debitColumn", "Debit / money out"], ["creditColumn", "Credit / money in"], ["idColumn", "Transaction ID (optional)"],
] as const;

function renderMapping(columns: string[], mapping: CsvMapping | null): string {
  const split = mapping?.amountColumn === undefined && (mapping?.debitColumn !== undefined || mapping?.creditColumn !== undefined);
  return `<label class="form-field"><span>Amount columns</span><select id="import-amount-mode"><option value="signed"${split ? "" : " selected"}>One signed amount column</option><option value="split"${split ? " selected" : ""}>Separate debit and credit columns</option></select></label>` + columnFields.map(([key, label]) =>
    `<label class="form-field"><span>${label}</span><select id="import-map-${key}"><option value="">Choose a column</option>${columns.map((name, index) => `<option value="${index}"${mapping?.[key] === index ? " selected" : ""}>${index + 1}. ${escapeHtml(name || "Unnamed column")}</option>`).join("")}</select></label>`,
  ).join("");
}

export function initializeAccountImport(account: BankAccount, onImported: (result: ImportResult) => Promise<void>): void {
  const dialog = document.querySelector<HTMLDialogElement>("#account-import-dialog");
  const form = document.querySelector<HTMLFormElement>("#account-import-form");
  const file = document.querySelector<HTMLInputElement>("#import-file");
  const next = document.querySelector<HTMLButtonElement>("#import-next");
  const back = document.querySelector<HTMLButtonElement>("#import-back");
  const fileStep = document.querySelector<HTMLElement>("#import-file-step");
  const previewStep = document.querySelector<HTMLElement>("#import-preview-step");
  const error = document.querySelector<HTMLElement>("#account-import-error");
  const mappingPanel = document.querySelector<HTMLElement>("#import-column-mapping");
  const fields = document.querySelector<HTMLElement>("#import-mapping-fields");
  const dateFormat = document.querySelector<HTMLSelectElement>("#import-date-format");
  const convention = document.querySelector<HTMLSelectElement>("#import-amount-convention");
  if (!dialog || !form || !file || !next || !back || !fileStep || !previewStep) return;
  let busy = false;
  let stage: "file" | "preview" = "file";
  let preview: ImportPreview | null = null;
  let confirmedRequest: ImportRequest | null = null;

  function showFileStep(): void {
    stage = "file";
    fileStep!.hidden = false;
    previewStep!.hidden = true;
    file!.required = true;
    next!.textContent = "Preview transactions";
    next!.disabled = false;
    back!.textContent = "Cancel";
    showError(error);
  }
  document.querySelector("#import-transactions")?.addEventListener("click", () => {
    showFileStep();
    dialog.showModal();
  });
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  back.addEventListener("click", () => {
    if (busy) return;
    if (stage === "preview") showFileStep();
    else dialog.close();
  });
  file.addEventListener("change", () => {
    preview = null;
    confirmedRequest = null;
    if (mappingPanel) mappingPanel.hidden = true;
    if (fields) fields.innerHTML = "";
    const csvOptions = document.querySelector<HTMLElement>("#import-csv-options");
    if (csvOptions) csvOptions.hidden = !file.files?.[0]?.name.toLowerCase().endsWith(".csv");
    showError(error);
  });
  function csvMapping(): CsvMapping {
    const mapping: CsvMapping = { dateFormat: dateFormat?.value ?? "mdy", amountConvention: convention?.value ?? "inflow-positive" };
    if (!preview?.columns.length) return mapping;
    const mode = document.querySelector<HTMLSelectElement>("#import-amount-mode")?.value;
    for (const [key] of columnFields) {
      if (mode === "split" && key === "amountColumn") continue;
      if (mode === "signed" && (key === "debitColumn" || key === "creditColumn")) continue;
      const select = document.querySelector<HTMLSelectElement>(`#import-map-${key}`);
      if (select) {
        if (select.value !== "") mapping[key] = Number(select.value);
      } else if (preview.mapping?.[key] !== undefined) mapping[key] = preview.mapping[key];
    }
    return mapping;
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    next.disabled = true;
    back.disabled = true;
    file.disabled = true;
    for (const control of form.querySelectorAll?.<HTMLInputElement | HTMLSelectElement>("input, select") ?? []) control.disabled = true;
    showError(error);
    try {
      if (stage === "file") {
        const selected = file.files?.[0];
        if (!selected) throw new Error("Choose a transaction file first.");
        if (selected.size > 4 * 1024 * 1024) throw new Error("Choose a file smaller than 4 MB.");
        if (!/\.(csv|ofx|qfx)$/i.test(selected.name)) throw new Error("Choose a CSV, OFX, or QFX file.");
        const request: ImportRequest = { fileName: selected.name, content: await readTransactionFile(selected) };
        if (/\.csv$/i.test(selected.name)) request.csv = csvMapping();
        const result = await postJson<ImportPreview>(`/api/accounts/${encodeURIComponent(account.id)}/import/preview`, request);
        preview = result;
        if (fields && result.columns.length) fields.innerHTML = renderMapping(result.columns, result.mapping);
        if (mappingPanel) mappingPanel.hidden = !result.columns.length;
        if (result.errors.length) throw new Error(result.errors.join("\n"));
        confirmedRequest = request;
        const summary = document.querySelector<HTMLElement>("#import-preview-summary");
        if (summary) summary.textContent = [`${result.total} transactions found · ${result.importable} new · ${result.duplicates} duplicates will be skipped`, ...(result.notes ?? [])].join("\n");
        const rows = document.querySelector<HTMLElement>("#import-preview-rows");
        if (rows) rows.innerHTML = result.transactions.map(transaction => {
          const value = transaction.amount === 0 ? 0 : -transaction.amount;
          const amount = new Intl.NumberFormat(undefined, { style: "currency", currency: transaction.iso_currency_code, signDisplay: "exceptZero" }).format(value);
          return `<tr><td>${escapeHtml(transaction.date)}</td><td>${escapeHtml(transaction.name)}</td><td>${escapeHtml(amount)}</td></tr>`;
        }).join("");
        const limit = document.querySelector<HTMLElement>("#import-preview-limit");
        if (limit) limit.textContent = result.total > result.transactions.length ? `Showing the first ${result.transactions.length} of ${result.total} transactions. The entire file has been validated.` : "All transactions shown.";
        fileStep.hidden = true;
        previewStep.hidden = false;
        file.required = false;
        stage = "preview";
        back.textContent = "Back";
        next.textContent = `Import ${result.importable} transaction${result.importable === 1 ? "" : "s"}`;
      } else if (confirmedRequest && preview && !preview.errors.length && preview.importable > 0) {
        const result = await postJson<ImportResult>(`/api/accounts/${encodeURIComponent(account.id)}/import`, confirmedRequest);
        dialog.close();
        await onImported(result);
      }
    } catch (cause) {
      showError(error, cause instanceof Error ? cause.message : "Unable to import transactions.");
    } finally {
      busy = false;
      next.disabled = stage === "preview" && !preview?.importable;
      back.disabled = false;
      file.disabled = false;
      for (const control of form.querySelectorAll?.<HTMLInputElement | HTMLSelectElement>("input, select") ?? []) control.disabled = false;
    }
  });
}
