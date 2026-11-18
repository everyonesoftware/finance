export function renderTwelveDataSettings(): string {
  return `
    <section id="twelve-data-panel" class="settings-card twelve-data-card" aria-labelledby="twelve-data-title">
      <div class="settings-heading"><h2 id="twelve-data-title">Twelve Data</h2><span id="twelve-data-status" class="settings-badge" role="status">Loading…</span></div>
      <p>Set up a market-data API key for investment prices.</p>
      <p class="twelve-data-note">Stored encrypted on the Finance server for your user only. Saving does not verify the key, contact Twelve Data, or start price downloads. Price fetching is not available yet.</p>
      <form id="twelve-data-form" method="post" autocomplete="off">
        <label class="form-field" for="twelve-data-key"><span>API key</span>
          <input id="twelve-data-key" name="apiKey" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="1024" aria-describedby="twelve-data-key-help" required disabled />
        </label>
        <p id="twelve-data-key-help" class="twelve-data-help">Saved keys are never displayed. Enter a new key to replace one.</p>
        <div class="twelve-data-actions">
          <button id="twelve-data-save" class="primary-button" type="submit" disabled>Save API key</button>
          <button id="twelve-data-remove" class="secondary-button" type="button" hidden disabled>Remove key</button>
          <button id="twelve-data-retry" class="secondary-button" type="button" hidden>Try again</button>
        </div>
      </form>
      <p id="twelve-data-message" class="auth-message" role="status" aria-live="polite" hidden></p>
    </section>
  `;
}

export function initializeTwelveDataSettings(signal: AbortSignal): void {
  const panel = document.querySelector<HTMLElement>("#twelve-data-panel");
  if (!panel || signal.aborted) return;
  const form = panel.querySelector<HTMLFormElement>("#twelve-data-form")!;
  const input = panel.querySelector<HTMLInputElement>("#twelve-data-key")!;
  const save = panel.querySelector<HTMLButtonElement>("#twelve-data-save")!;
  const remove = panel.querySelector<HTMLButtonElement>("#twelve-data-remove")!;
  const retry = panel.querySelector<HTMLButtonElement>("#twelve-data-retry")!;
  const badge = panel.querySelector<HTMLElement>("#twelve-data-status")!;
  const message = panel.querySelector<HTMLElement>("#twelve-data-message")!;
  let configured = false, loaded = false, busy = false;
  const active = () => !signal.aborted && panel.isConnected;
  function controls(): void {
    input.disabled = !loaded || busy;
    save.disabled = !loaded || busy || !input.value;
    remove.disabled = !loaded || busy;
    retry.disabled = busy;
    remove.hidden = !configured;
    save.textContent = configured ? "Replace API key" : "Save API key";
    badge.textContent = loaded ? configured ? "Key saved · not verified" : "Not configured" : "Unavailable";
  }
  function notice(text: string, error = false): void {
    message.hidden = false;
    message.textContent = text;
    message.classList.toggle("error", error);
    message.classList.toggle("success", !error);
  }
  async function request(method: "GET" | "PUT" | "DELETE", body?: string): Promise<boolean> {
    const response = await fetch("/api/settings/twelve-data", {
      method, credentials: "same-origin", cache: "no-store", signal,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body }),
    });
    if (!response.ok) throw Error();
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || !("configured" in data) || typeof data.configured !== "boolean") throw Error();
    return data.configured;
  }
  async function load(): Promise<void> {
    if (!active() || busy) return;
    busy = true;
    controls();
    badge.textContent = "Loading…";
    retry.hidden = true;
    message.hidden = true;
    try {
      const status = await request("GET");
      if (!active()) return;
      configured = status;
      loaded = true;
    } catch {
      if (!active()) return;
      loaded = false;
      retry.hidden = false;
      notice("Unable to load Twelve Data settings. Try again.", true);
    } finally {
      busy = false;
      if (active()) controls();
    }
  }
  async function mutate(method: "PUT" | "DELETE"): Promise<void> {
    if (!active() || busy || !loaded) return;
    // Capture only for this request; never retain a key in component state/storage.
    const body = method === "PUT" ? JSON.stringify({ apiKey: input.value }) : "{}";
    if (method === "PUT" && !/^[\x21-\x7e]{1,1024}$/.test(input.value)) {
      notice("Enter an API key without spaces, up to 1,024 characters.", true);
      return;
    }
    input.value = "";
    busy = true;
    controls();
    notice(method === "PUT" ? "Saving API key…" : "Removing API key…");
    try {
      const status = await request(method, body);
      if (!active()) return;
      if (status !== (method === "PUT")) throw Error();
      configured = status;
      notice(method === "PUT" ? "API key saved securely. It has not been verified with Twelve Data." : "API key removed. Your accounts and imported data are unchanged.");
    } catch {
      if (!active()) return;
      notice(method === "PUT" ? "Unable to confirm the API key was saved. Reload settings to check, or re-enter the key and try again." : "Unable to confirm the API key was removed. Reload settings to check, or try again.", true);
    } finally {
      busy = false;
      if (active()) controls();
    }
  }
  input.addEventListener("input", controls, { signal });
  form.addEventListener("submit", event => { event.preventDefault(); void mutate("PUT"); }, { signal });
  remove.addEventListener("click", () => { void mutate("DELETE"); }, { signal });
  retry.addEventListener("click", () => { void load(); }, { signal });
  signal.addEventListener("abort", () => { input.value = ""; }, { once: true });
  void load();
}
