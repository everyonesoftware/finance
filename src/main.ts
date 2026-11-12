import { createAuthClient } from "better-auth/client";
import { usernameClient } from "better-auth/client/plugins";
import "./style.css";
import { renderAppNavigation } from "./navigation.ts";
import { renderDashboard } from "./dashboard";
import { initializeTransactionsPage, renderTransactionsPage } from "./transactions-page";
import {
  initializeOverviewBankAccounts,
  initializeBankAccountsPage,
  initializeConnectionsPage,
  initializeAccountDetailPage,
  renderBankAccountDetailPage,
  renderBankAccountsPage,
  renderConnectionsPage,
  type BankAccount,
} from "./bank_accounts";
import { renderRecentTransactionList } from "./transaction-list";
import { createClientRouter } from "./router.ts";
import { AppUpdates, type UpdateSnapshot } from "./pwa.ts";
import { appVersion } from "./app-version.ts";

function getAppRoot(): HTMLDivElement {
  const root: HTMLDivElement | null =
    document.querySelector<HTMLDivElement>("#app");
  if (!root) {
    throw new Error("App root element was not found");
  }
  return root;
}

const app: HTMLDivElement = getAppRoot();


const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [usernameClient()],
});

type AuthUser = typeof authClient.$Infer.Session.user;

let currentUser: AuthUser | null = null;
let authLoading: boolean = true;
let authNotice: string = "";
let pageLifetime = new AbortController();
const appUpdates = new AppUpdates(appVersion, {
  enabled: import.meta.env.PROD && window.isSecureContext,
  serviceWorker: navigator.serviceWorker,
  isOnline: () => navigator.onLine,
  fetch: window.fetch.bind(window),
  reload: () => window.location.reload(),
});
const router = createClientRouter(() => {
  render();
  const main = app.querySelector<HTMLElement>("main");
  main?.setAttribute("tabindex", "-1");
  main?.focus({ preventScroll: true });
});

/** Preserve the navigation shell while replacing only page-specific content. */
function mountPage(markup: string): void {
  const existing = app.querySelector<HTMLElement>(".app-shell");
  if (!existing) { app.innerHTML = markup; return; }
  const template = document.createElement("template");
  template.innerHTML = markup;
  const incoming = template.content.querySelector<HTMLElement>(".app-shell");
  if (!incoming) { app.innerHTML = markup; return; }
  existing.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach(dialog => dialog.close());
  for (const selector of [".sidebar", ".mobile-navigation"]) {
    const oldNavigation = existing.querySelector<HTMLElement>(selector);
    const newNavigation = incoming.querySelector<HTMLElement>(selector);
    if (oldNavigation && newNavigation) oldNavigation.innerHTML = newNavigation.innerHTML;
  }
  for (const child of [...existing.children]) {
    if (!child.matches(".sidebar, .mobile-navigation")) child.remove();
  }
  for (const child of [...incoming.children]) {
    if (!child.matches(".sidebar, .mobile-navigation")) existing.append(child);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character: string): string => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };

    return entities[character] ?? character;
  });
}

function displayNameFor(user: AuthUser): string {
  return user.name.trim() || user.username || user.email;
}

function renderLanding(): void {
  const isSignUp: boolean = new URLSearchParams(window.location.search).get("mode") === "signup";
  const noticeMarkup: string = authNotice
    ? `<p class="auth-message error" role="alert">${escapeHtml(authNotice)}</p>`
    : "";

  app.innerHTML = `
    <main class="landing-page">
      <header class="landing-header">
        <a class="brand" href="/" aria-label="Finance home">
          <span class="brand-mark" aria-hidden="true">F</span>
          <span>Finance</span>
        </a>
        <span class="landing-header-note">A clearer view of your money</span>
      </header>
      <section class="landing-content">
        <div class="landing-copy">
          <p class="eyebrow">YOUR MONEY, IN FOCUS</p>
          <h1>A little more clarity.<br />A lot more confidence.</h1>
          <p class="landing-description">
            Bring your finances into one calm, clear space. Sign in to pick up
            where you left off, or create an account to get started.
          </p>
          <div class="landing-highlights">
            <div><span aria-hidden="true">✓</span><span>See your finances at a glance</span></div>
            <div><span aria-hidden="true">✓</span><span>Keep your financial picture in one place</span></div>
            <div><span aria-hidden="true">✓</span><span>Manage your account securely</span></div>
          </div>
          <p class="landing-disclaimer">Create manual financial accounts and import transactions from your bank exports. No automatic bank connection is required.</p>
        </div>
        <section class="auth-card" aria-labelledby="auth-title">
          <div class="auth-tabs" role="tablist" aria-label="Account access">
            <a class="${isSignUp ? "" : "selected"}" href="/" role="tab" aria-selected="${!isSignUp}">Log in</a>
            <a class="${isSignUp ? "selected" : ""}" href="/?mode=signup" role="tab" aria-selected="${isSignUp}">Create account</a>
          </div>
          <h2 id="auth-title">${isSignUp ? "Create your account" : "Welcome back"}</h2>
          <p class="auth-subtitle">${isSignUp ? "Choose a username and password to get started." : "Log in with your username and password."}</p>
          ${noticeMarkup}
          <form id="auth-form">
            <fieldset class="auth-fields">
            ${isSignUp ? `
              <label class="form-field">
                <span>Your name</span>
                <input name="name" type="text" autocomplete="name" placeholder="Alex Morgan" required />
              </label>
              <label class="form-field">
                <span>Username</span>
                <input name="username" type="text" autocomplete="username" minlength="3" maxlength="30" required />
              </label>
              <label class="form-field">
                <span>Email address</span>
                <input name="email" type="email" autocomplete="email" placeholder="you@example.com" required />
                <small>Saved as part of your account profile.</small>
              </label>
            ` : `
              <label class="form-field">
                <span>Username</span>
                <input name="username" type="text" autocomplete="username" required />
              </label>
            `}
            <label class="form-field">
              <span>Password</span>
              <input name="password" type="password" autocomplete="${isSignUp ? "new-password" : "current-password"}" minlength="8" required />
            </label>
            <button class="primary-button auth-submit" type="submit">
              ${isSignUp ? "Create account" : "Log in"} <span aria-hidden="true">→</span>
            </button>
            </fieldset>
          </form>
          <p class="auth-terms">Your account is hosted by this application.</p>
        </section>
      </section>

    </main>
  `;

  const form: HTMLFormElement | null =
    document.querySelector<HTMLFormElement>("#auth-form");

  form?.addEventListener("submit", async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const formData: FormData = new FormData(form);
    const username: string = String(formData.get("username") ?? "").trim();
    const password: string = String(formData.get("password") ?? "");
    const submitButton: HTMLButtonElement | null =
      form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const message: HTMLParagraphElement = document.createElement("p");
    message.className = "auth-message";
    message.setAttribute("role", "status");
    form.prepend(message);

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = isSignUp ? "Creating account…" : "Logging in…";
    }

    try {
      const result = isSignUp
        ? await authClient.signUp.email({
            name: String(formData.get("name") ?? "").trim(),
            username,
            email: String(formData.get("email") ?? "").trim(),
            password,
          })
        : await authClient.signIn.username({ username, password });

      if (result.error) {
        throw new Error(result.error.message);
      }

      await loadSession(false);
      if (!currentUser) throw new Error("Unable to load your account session. Please try again.");
      router.navigate("/dashboard");
    } catch (error: unknown) {
      message.textContent =
        error instanceof Error ? error.message : "Unable to authenticate. Please try again.";
      message.classList.add("error");
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = isSignUp ? "Create account →" : "Log in →";
      }
    }
  });
}

function renderSettings(user: AuthUser, signal: AbortSignal): void {
  mountPage(`
    <div class="app-shell">
      ${renderAppNavigation({ displayName: displayNameFor(user), username: user.username ?? "" }, "settings")}
      <main class="main-content settings-main">
      <section class="settings-content">
        <p class="eyebrow">YOUR ACCOUNT</p>
        <h1>Settings</h1>
        <p class="subheading">Manage your app, profile, and sign-in details.</p>
        <p id="settings-message" class="auth-message" role="status" hidden></p>
        <section class="settings-card update-card" aria-labelledby="update-title">
          <div class="update-heading"><h2 id="update-title">App updates</h2><span id="update-badge" class="update-badge">Ready to check</span></div>
          <p>Check for a new version of Finance.</p>
          <div class="version-row"><span>Current version</span><strong id="current-version">${escapeHtml(appVersion)}</strong></div>
          <p id="update-message" role="status" aria-live="polite">Updates are applied only when you choose to reload.</p>
          <div class="update-actions">
            <button id="check-update" class="primary-button" type="button">Check for updates</button>
            <button id="reload-update" class="primary-button" type="button" hidden>Reload to update</button>
            <button id="later-update" class="secondary-button" type="button" hidden>Later</button>
          </div>
        </section>
        <section class="settings-card">
          <h2>Profile</h2>
          <p>Update your display name and username.</p>
          <form id="profile-form">
            <label class="form-field">
              <span>Display name</span>
              <input name="name" type="text" autocomplete="name" value="${escapeHtml(user.name)}" required />
            </label>
            <label class="form-field">
              <span>Username</span>
              <input name="username" type="text" autocomplete="username" value="${escapeHtml(user.username ?? "")}" minlength="3" maxlength="30" required />
            </label>
            <label class="form-field">
              <span>Email address</span>
              <input type="email" value="${escapeHtml(user.email)}" disabled />
            </label>
            <button class="primary-button" type="submit">Save profile</button>
          </form>
        </section>
        <section class="settings-card">
          <h2>Change password</h2>
          <p>Confirm your current password before choosing a new one.</p>
          <form id="password-form">
            <label class="form-field">
              <span>Current password</span>
              <input name="currentPassword" type="password" autocomplete="current-password" required />
            </label>
            <label class="form-field">
              <span>New password</span>
              <input name="newPassword" type="password" autocomplete="new-password" minlength="8" required />
            </label>
            <label class="form-field">
              <span>Confirm new password</span>
              <input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required />
            </label>
            <button class="primary-button" type="submit">Update password</button>
          </form>
        </section>
        <section class="settings-card settings-logout-section">
          <h2>Log out</h2>
          <p>Sign out of your Finance account on this device.</p>
          <button class="primary-button logout-button" type="button">Log out</button>
        </section>
      </section>
      </main>
    </div>
  `);

  bindAppUpdates(signal);

  document
    .querySelector<HTMLFormElement>("#profile-form")
    ?.addEventListener("submit", async (event: SubmitEvent): Promise<void> => {
      event.preventDefault();
      if (!(event.currentTarget instanceof HTMLFormElement)) {
        return;
      }
      const form: HTMLFormElement = event.currentTarget;
      const formData: FormData = new FormData(form);
      const name: string = String(formData.get("name") ?? "").trim();
      const username: string = String(formData.get("username") ?? "").trim();

      try {
        const { error } = await authClient.updateUser({ name, username });
        if (error) {
          throw new Error(error.message);
        }
        await loadSession(false);
        if (signal.aborted) return;
        render();
        showSettingsMessage("Profile saved.", false);
      } catch (error: unknown) {
        showSettingsMessage(
          error instanceof Error ? error.message : "Unable to save your profile.",
          true,
          signal,
        );
      }
    });

  document
    .querySelector<HTMLFormElement>("#password-form")
    ?.addEventListener("submit", async (event: SubmitEvent): Promise<void> => {
      event.preventDefault();
      if (!(event.currentTarget instanceof HTMLFormElement)) {
        return;
      }
      const form: HTMLFormElement = event.currentTarget;
      const formData: FormData = new FormData(form);
      const currentPassword: string = String(formData.get("currentPassword") ?? "");
      const newPassword: string = String(formData.get("newPassword") ?? "");
      const confirmPassword: string = String(formData.get("confirmPassword") ?? "");

      if (newPassword !== confirmPassword) {
        showSettingsMessage("The passwords do not match.", true, signal);
        return;
      }

      try {
        const { error } = await authClient.changePassword({
          currentPassword,
          newPassword,
        });
        if (error) {
          throw new Error(error.message);
        }
        form.reset();
        showSettingsMessage("Password updated.", false, signal);
      } catch (error: unknown) {
        showSettingsMessage(
          error instanceof Error ? error.message : "Unable to update your password.",
          true,
          signal,
        );
      }
    });

  attachLogoutHandler(signal);
}

function bindAppUpdates(signal: AbortSignal): void {
  const check = document.querySelector<HTMLButtonElement>("#check-update")!;
  const reload = document.querySelector<HTMLButtonElement>("#reload-update")!;
  const later = document.querySelector<HTMLButtonElement>("#later-update")!;
  const badge = document.querySelector<HTMLElement>("#update-badge")!;
  const message = document.querySelector<HTMLElement>("#update-message")!;
  let postponed = false;
  const labels: Record<UpdateSnapshot["status"], string> = {
    idle: "Ready to check", checking: "Checking", current: "Up to date", available: "Update available",
    offline: "Offline", error: "Couldn’t check", unsupported: "Unavailable",
  };
  const update = (state: UpdateSnapshot): void => {
    if (signal.aborted) return;
    badge.textContent = labels[state.status];
    badge.dataset.state = state.status;
    message.textContent = state.message;
    const offered = state.status === "available" && !postponed;
    check.hidden = offered;
    check.disabled = state.status === "checking" || Boolean(state.applying);
    check.textContent = state.status === "checking" ? "Checking…" : postponed && state.status === "available" ? "Show update" : ["error", "offline"].includes(state.status) ? "Try again" : "Check for updates";
    reload.hidden = !offered;
    later.hidden = !offered;
    reload.disabled = later.disabled = Boolean(state.applying);
  };
  const unsubscribe = appUpdates.subscribe(update);
  signal.addEventListener("abort", unsubscribe, { once: true });
  check.addEventListener("click", () => {
    if (postponed && appUpdates.snapshot.status === "available") { postponed = false; update(appUpdates.snapshot); }
    else void appUpdates.check();
  });
  reload.addEventListener("click", () => appUpdates.apply());
  later.addEventListener("click", () => { postponed = true; appUpdates.defer(); });
}

function showSettingsMessage(text: string, isError: boolean, signal?: AbortSignal): void {
  if (signal?.aborted) return;
  const message: HTMLParagraphElement | null =
    document.querySelector<HTMLParagraphElement>("#settings-message");

  if (message) {
    message.hidden = false;
    message.textContent = text;
    message.classList.toggle("error", isError);
    message.classList.toggle("success", !isError);
  }
}

function attachLogoutHandler(signal: AbortSignal = pageLifetime.signal): void {
  document
    .querySelector<HTMLButtonElement>(".logout-button")
    ?.addEventListener("click", async (): Promise<void> => {
      const button: HTMLButtonElement | null =
        document.querySelector<HTMLButtonElement>(".logout-button");
      if (button) {
        button.disabled = true;
        button.textContent = "Logging out…";
      }

      try {
        const { error } = await authClient.signOut();
        if (error) {
          throw new Error(error.message);
        }
        currentUser = null;
        authNotice = "";
        router.navigate("/");
      } catch (error: unknown) {
        if (button) {
          button.disabled = false;
          button.textContent = "Log out";
        }
        showSettingsMessage(
          error instanceof Error ? error.message : "Unable to log out. Please try again.",
          true,
          signal,
        );
      }
    });
}

async function loadSession(renderAfter = true): Promise<void> {
  try {
    const { data, error } = await authClient.getSession();
    if (error) {
      throw new Error(error.message);
    }

    currentUser = data?.user ?? null;
  } catch (error: unknown) {
    authNotice =
      error instanceof Error ? error.message : "Unable to load your account session.";
    currentUser = null;
  }

  authLoading = false;
  if (renderAfter) render();
}

function render(): void {
  pageLifetime.abort();
  pageLifetime = new AbortController();
  const signal = pageLifetime.signal;
  const path: string = window.location.pathname;
  const accountDetailMatch = path.match(/^\/accounts\/([^/]+)$/);

  if (authLoading) {
    app.innerHTML = `<main class="loading-page" aria-live="polite">Loading your account…</main>`;
    return;
  }

  if (currentUser && path === "/") {
    router.navigate("/dashboard", { replace: true });
    return;
  }

  if (path === "/dashboard" || path === "/transactions" || path === "/settings" || path === "/accounts" || path === "/real-estate" || accountDetailMatch) {
    if (!currentUser) {
      authNotice = authNotice || "Log in or create an account to continue.";
      window.history.replaceState(null, "", "/");
      renderLanding();
      return;
    }

    if (path === "/settings") {
      renderSettings(currentUser, signal);
      return;
    }

    if (path === "/transactions") {
      mountPage(renderTransactionsPage({
        displayName: displayNameFor(currentUser),
        username: currentUser.username ?? "",
      }));
      attachLogoutHandler();
      void initializeTransactionsPage(signal);
      return;
    }

    if (path === "/accounts") {
      mountPage(renderBankAccountsPage({
        displayName: displayNameFor(currentUser),
        username: currentUser.username ?? "",
      }));
      attachLogoutHandler();
      initializeBankAccountsPage(signal);
      return;
    }

    if (path === "/real-estate") {
      mountPage(renderConnectionsPage({ displayName: displayNameFor(currentUser), username: currentUser.username ?? "" }));
      attachLogoutHandler();
      void initializeConnectionsPage(signal);
      return;
    }

    if (accountDetailMatch) {
      let accountId: string;
      try {
        accountId = decodeURIComponent(accountDetailMatch[1]);
      } catch {
        window.history.replaceState(null, "", "/accounts");
        render();
        return;
      }
      mountPage(renderBankAccountDetailPage({
        displayName: displayNameFor(currentUser),
        username: currentUser.username ?? "",
      }));
      attachLogoutHandler();
      void initializeAccountDetailPage(accountId, signal);
      return;
    }

    mountPage(renderDashboard({
      displayName: displayNameFor(currentUser),
      username: currentUser.username ?? "",
    }));
    attachLogoutHandler();
    void initializeOverviewBankAccounts(signal);
    const transactionList = document.querySelector<HTMLDivElement>("#transaction-list");
    const renderTransactions = async (): Promise<void> => {
      try {
        const response = await fetch("/api/accounts/transactions/all", { credentials: "same-origin" });
        if (!response.ok) throw new Error("Unable to load transactions.");
        const body = await response.json() as {
          transactions: Array<Record<string, unknown>>;
          accounts?: BankAccount[];
        };
        const transactions = body.transactions;
        if (!transactionList || signal.aborted) return;
        transactionList.className = transactions.length ? "transaction-list" : "transaction-empty";
        transactionList.innerHTML = renderRecentTransactionList(transactions, body.accounts ?? []);
      } catch { if (transactionList && !signal.aborted) transactionList.textContent = "Unable to load transactions."; }
    };
    void renderTransactions();
    return;
  }

  renderLanding();
}

void loadSession();
void appUpdates.start();
