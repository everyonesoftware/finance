interface TellerSettings {
  applicationId: string;
  environment: "sandbox" | "development" | "production";
  hasCertificate: boolean;
  hasPrivateKey: boolean;
  signingKey: string;
  configured: boolean;
}

export async function initializeTellerSettings(): Promise<void> {
  const form = document.querySelector<HTMLFormElement>("#teller-settings-form");
  const fields = document.querySelector<HTMLFieldSetElement>("#teller-settings-fields");
  const status = document.querySelector<HTMLElement>("#teller-settings-status");
  if (!form || !fields || !status) return;
  const applicationId = document.querySelector<HTMLInputElement>("#teller-application-id")!;
  const environment = document.querySelector<HTMLSelectElement>("#teller-environment")!;
  const certificate = document.querySelector<HTMLTextAreaElement>("#teller-certificate")!;
  const privateKey = document.querySelector<HTMLTextAreaElement>("#teller-private-key")!;
  const signingKey = document.querySelector<HTMLInputElement>("#teller-signing-key")!;
  const retry = document.querySelector<HTMLButtonElement>("#teller-settings-retry");
  const message = (text: string, error = false): void => {
    status.textContent = text;
    status.classList.toggle("error", error);
    status.classList.toggle("success", !error);
  };
  let uploadGeneration = 0;
  const wipe = (): void => {
    uploadGeneration++;
    certificate.value = "";
    privateKey.value = "";
    for (const id of ["certificate", "private-key"]) {
      const input = document.querySelector<HTMLInputElement>(`#teller-${id}-file`);
      if (input) input.value = "";
    }
  };
  const load = async (): Promise<void> => {
    fields.disabled = true;
    if (retry) retry.hidden = true;
    const response = await fetch("/api/settings/teller", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error("Unable to load Teller settings.");
    const data = await response.json() as TellerSettings;
    if (!data || typeof data.applicationId !== "string" || !["sandbox", "development", "production"].includes(data.environment) || typeof data.hasCertificate !== "boolean" || typeof data.hasPrivateKey !== "boolean" || typeof data.configured !== "boolean") throw new Error("Invalid Teller settings response.");
    applicationId.value = data.applicationId;
    environment.value = data.environment;
    signingKey.value = data.signingKey ?? "";
    document.querySelector<HTMLElement>("#teller-certificate-status")!.textContent = data.hasCertificate ? "Saved" : "Not saved";
    document.querySelector<HTMLElement>("#teller-private-key-status")!.textContent = data.hasPrivateKey ? "Saved" : "Not saved";
    wipe();
    fields.disabled = false;
    message(data.configured ? "Teller is configured and ready to connect banks." : "Complete your Teller configuration to connect banks.");
  };
  const loadSafely = async (): Promise<void> => {
    try { await load(); } catch { message("Unable to load Teller settings. Try again.", true); if (retry) retry.hidden = false; }
  };
  const save = async (clearCredentials = false): Promise<void> => {
    if (fields.disabled) return;
    fields.disabled = true;
    message("Saving Teller settings…");
    // Keep private material only in this request, never browser storage or status text.
    const body = JSON.stringify(clearCredentials ? { clearCredentials: true } : {
      applicationId: applicationId.value.trim(), environment: environment.value,
      certificate: certificate.value.trim(), privateKey: privateKey.value.trim(), signingKey: signingKey.value.trim(),
    });
    wipe();
    try {
      const response = await fetch("/api/settings/teller", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body });
      if (!response.ok) {
        // Only display bounded validation messages, never credentials or server diagnostics.
        if (response.status === 400) {
          const data: unknown = await response.json();
          const submitted = JSON.parse(body) as { certificate?: string; privateKey?: string };
          const errorText = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "";
          if (errorText && errorText.length <= 300 &&
              !/-----BEGIN|-----END|[\r\n]/.test(errorText) &&
              ![submitted.certificate, submitted.privateKey].some(secret => secret && errorText.includes(secret))) {
            message(errorText, true);
            return;
          }
        }
        throw new Error("Unable to save Teller settings.");
      }
      await load();
      message(clearCredentials ? "Saved credentials cleared." : "Teller settings saved.");
    } catch { message("Unable to save or verify Teller settings. Check your configuration and try again.", true); }
    finally { fields.disabled = false; }
  };
  form.addEventListener("submit", async event => { event.preventDefault(); await save(); });
  document.querySelector("#teller-clear-credentials")?.addEventListener("click", async () => {
    if (window.confirm("Clear the saved Teller certificate and private key? New bank connections will be unavailable until credentials are configured again.")) await save(true);
  });
  for (const [id, target] of [["certificate", certificate], ["private-key", privateKey]] as const) {
    const input = document.querySelector<HTMLInputElement>(`#teller-${id}-file`);
    input?.addEventListener("change", async () => {
      const generation = uploadGeneration;
      const file = input.files?.[0];
      if (!file) return;
      try {
        if (file.size > 100_000) throw new Error("PEM file too large");
        const text = await file.text();
        if (generation === uploadGeneration && !fields.disabled) target.value = text;
      } catch { message("Unable to read PEM file. Choose a text PEM file smaller than 100 KB.", true); }
      finally { input.value = ""; }
    });
  }
  retry?.addEventListener("click", loadSafely);
  await loadSafely();
}

export function renderTellerSettings(): string {
  return `<section class="settings-card teller-settings-card">
    <h2>Teller integration</h2>
    <p>Sandbox needs only your application ID. Development and production require a matching certificate and private key plus your public signing key. Credentials are encrypted on the server and never returned to this browser.</p>
    <form id="teller-settings-form" autocomplete="off">
      <fieldset id="teller-settings-fields" disabled>
        <label class="form-field"><span>Application ID</span><input name="applicationId" id="teller-application-id" type="text" maxlength="200" /></label>
        <label class="form-field"><span>Environment</span><select name="environment" id="teller-environment"><option value="sandbox">Sandbox</option><option value="development">Development</option><option value="production">Production</option></select></label>
        <div class="teller-credential-inset">
          <label class="form-field"><span>Certificate PEM <small id="teller-certificate-status">Not saved</small></span><textarea name="certificate" id="teller-certificate" rows="4" spellcheck="false" placeholder="Leave blank to keep the saved certificate"></textarea></label>
          <label class="form-field"><span>Upload certificate PEM</span><input type="file" id="teller-certificate-file" accept=".pem,.crt,.cert,text/plain" /></label>
          <label class="form-field"><span>Private key PEM <small id="teller-private-key-status">Not saved</small></span><textarea name="privateKey" id="teller-private-key" rows="4" spellcheck="false" placeholder="Leave blank to keep the saved private key"></textarea></label>
          <label class="form-field"><span>Upload private key PEM</span><input type="file" id="teller-private-key-file" accept=".pem,.key,text/plain" /></label>
          <p class="teller-credential-help">Leave blank to keep saved credentials. Uploads are read locally and sent only when you save. Private credentials are cleared from this form after submission.</p>
        </div>
        <label class="form-field"><span>Public signing key (required for development and production)</span><input name="signingKey" id="teller-signing-key" type="text" placeholder="Public signing key for enrollment verification" /></label>
        <div class="teller-settings-actions"><button class="primary-button" type="submit">Save Teller settings</button><button class="secondary-button" id="teller-clear-credentials" type="button">Clear saved credentials</button></div>
      </fieldset>
      <p id="teller-settings-status" class="auth-message" role="status" aria-live="polite">Loading Teller settings…</p>
      <button class="text-button" id="teller-settings-retry" type="button" hidden>Retry loading settings</button>
    </form>
  </section>`;
}
