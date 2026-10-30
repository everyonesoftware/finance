import { createAuthClient } from "better-auth/client";
import { usernameClient } from "better-auth/client/plugins";
import "./style.css";
import { renderDashboard } from "./dashboard";
import {
  formatTransactionAmount,
  initializeOverviewBankAccounts,
  initializeBankAccountsPage,
  renderBankAccountsPage,
} from "./bank_accounts";

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
          <p class="landing-disclaimer">Your dashboard currently uses sample financial data.</p>
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
      <footer class="landing-footer">Finance <span>Thoughtful tools for your financial life.</span></footer>
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

      window.location.assign("/dashboard");
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

function renderSettings(user: AuthUser): void {
  app.innerHTML = `
    <main class="settings-page">
      <header class="settings-header">
        <a class="brand" href="/dashboard" aria-label="Finance dashboard">
          <span class="brand-mark" aria-hidden="true">F</span>
          <span>Finance</span>
        </a>
        <nav class="settings-nav" aria-label="Account navigation">
          <a href="/dashboard">← Back to dashboard</a>
          <button class="text-button logout-button" type="button">Log out</button>
        </nav>
      </header>
      <section class="settings-content">
        <p class="eyebrow">YOUR ACCOUNT</p>
        <h1>Settings</h1>
        <p class="subheading">Manage your profile and sign-in details.</p>
        <p id="settings-message" class="auth-message" role="status" hidden></p>
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
      </section>
    </main>
  `;

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
        await loadSession();
        showSettingsMessage("Profile saved.", false);
      } catch (error: unknown) {
        showSettingsMessage(
          error instanceof Error ? error.message : "Unable to save your profile.",
          true,
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
        showSettingsMessage("The passwords do not match.", true);
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
        showSettingsMessage("Password updated.", false);
      } catch (error: unknown) {
        showSettingsMessage(
          error instanceof Error ? error.message : "Unable to update your password.",
          true,
        );
      }
    });

  attachLogoutHandler();
}

function showSettingsMessage(text: string, isError: boolean): void {
  const message: HTMLParagraphElement | null =
    document.querySelector<HTMLParagraphElement>("#settings-message");

  if (message) {
    message.hidden = false;
    message.textContent = text;
    message.classList.toggle("error", isError);
    message.classList.toggle("success", !isError);
  }
}

function attachLogoutHandler(): void {
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
        window.location.assign("/");
      } catch (error: unknown) {
        if (button) {
          button.disabled = false;
          button.textContent = "Log out";
        }
        showSettingsMessage(
          error instanceof Error ? error.message : "Unable to log out. Please try again.",
          true,
        );
      }
    });
}

async function loadSession(): Promise<void> {
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
  render();
}

function render(): void {
  const path: string = window.location.pathname;

  if (authLoading) {
    app.innerHTML = `<main class="loading-page" aria-live="polite">Loading your account…</main>`;
    return;
  }

  if (currentUser && path === "/") {
    window.location.replace("/dashboard");
    return;
  }

  if (path === "/dashboard" || path === "/settings" || path === "/accounts") {
    if (!currentUser) {
      authNotice = authNotice || "Log in or create an account to continue.";
      window.history.replaceState(null, "", "/");
      renderLanding();
      return;
    }

    if (path === "/settings") {
      renderSettings(currentUser);
      return;
    }

    if (path === "/accounts") {
      app.innerHTML = renderBankAccountsPage({
        displayName: displayNameFor(currentUser),
        username: currentUser.username ?? "",
      });
      attachLogoutHandler();
      initializeBankAccountsPage();
      return;
    }

    app.innerHTML = renderDashboard({
      displayName: displayNameFor(currentUser),
      username: currentUser.username ?? "",
    });
    attachLogoutHandler();
    void initializeOverviewBankAccounts();
    const transactionList = document.querySelector<HTMLDivElement>("#transaction-list");
    const transactionStatus = document.querySelector<HTMLParagraphElement>("#transaction-status");
    const renderTransactions = async (): Promise<void> => {
      try {
        const response = await fetch("/api/accounts/transactions", { credentials: "same-origin" });
        if (!response.ok) throw new Error("Unable to load transactions.");
        const body = await response.json() as { transactions: Array<Record<string, unknown>> };
        const transactions = body.transactions;
        if (!transactionList) return;
        transactionList.className = transactions.length ? "transaction-list" : "transaction-empty";
        transactionList.innerHTML = transactions.length ? transactions.map((transaction) => {
          const amount = typeof transaction.amount === "number" ? transaction.amount : Number.NaN;
          const currencyCode = typeof transaction.iso_currency_code === "string"
            ? transaction.iso_currency_code
            : typeof transaction.unofficial_currency_code === "string"
              ? transaction.unofficial_currency_code
              : null;
          return `<div class="account-row"><strong>${escapeHtml(String(transaction.name ?? "Transaction"))}</strong><span>${escapeHtml(String(transaction.date ?? ""))}</span><b>${escapeHtml(formatTransactionAmount(amount, currencyCode))}</b></div>`;
        }).join("") : "No transactions yet. Connect a bank and sync to get started.";
      } catch { if (transactionList) transactionList.textContent = "Unable to load transactions."; }
    };
    void renderTransactions();
    document.querySelector<HTMLButtonElement>("#sync-transactions")?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      if (transactionStatus) transactionStatus.textContent = "Syncing transactions…";
      try {
        const response = await fetch("/api/accounts/transactions/sync", { method: "POST", credentials: "same-origin" });
        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(body.error ?? "Sync failed.");
        if (transactionStatus) transactionStatus.textContent = "Transactions synced.";
        await renderTransactions();
      } catch (error) { if (transactionStatus) transactionStatus.textContent = error instanceof Error ? error.message : "Sync failed."; }
      finally { button.disabled = false; }
    });
    return;
  }

  renderLanding();
}

void loadSession();
