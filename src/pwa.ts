export type UpdateStatus = "idle" | "checking" | "current" | "available" | "offline" | "error" | "unsupported";
export interface UpdateSnapshot {
  status: UpdateStatus;
  message: string;
  version?: string;
  applying?: boolean;
}
interface UpdateEnvironment {
  enabled: boolean;
  serviceWorker?: ServiceWorkerContainer;
  isOnline: () => boolean;
  fetch: typeof fetch;
  reload: () => void;
}

function within<T>(promise: Promise<T>, milliseconds = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The update check timed out. Please try again.")), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/** One application-wide update lifecycle; Settings subscribes without owning registration. */
export class AppUpdates {
  snapshot: UpdateSnapshot = { status: "idle", message: "Updates are applied only when you choose to reload." };
  private listeners = new Set<(state: UpdateSnapshot) => void>();
  private registration: ServiceWorkerRegistration | null = null;
  private starting: Promise<ServiceWorkerRegistration> | null = null;
  private checking: Promise<void> | null = null;
  private applying = false;
  private applyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private currentVersion: string, private environment: UpdateEnvironment) {
    environment.serviceWorker?.addEventListener("controllerchange", () => {
      // Other tabs and first installation must never unexpectedly reload this tab.
      if (!this.applying) return;
      this.applying = false;
      clearTimeout(this.applyTimer);
      environment.reload();
    });
  }

  subscribe(listener: (state: UpdateSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => { this.listeners.delete(listener); };
  }

  private publish(snapshot: UpdateSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private available(version = this.snapshot.version): void {
    this.publish({ status: "available", version, message: `${version ? `Version ${version}` : "A new version"} is ready. Finish any unsaved changes before reloading.` });
  }

  private register(): Promise<ServiceWorkerRegistration> {
    if (this.registration) return Promise.resolve(this.registration);
    if (!this.starting) {
      this.starting = within(this.environment.serviceWorker!.register("/sw.js", { scope: "/", updateViaCache: "none" }))
        .then(registration => {
          this.registration = registration;
          const observe = (): void => {
            const worker = registration.installing;
            worker?.addEventListener("statechange", () => {
              if (worker.state === "installed" && registration.waiting && registration.active) this.available();
            });
          };
          registration.addEventListener("updatefound", observe);
          observe();
          if (registration.waiting && registration.active) this.available();
          return registration;
        }).finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  async start(): Promise<void> {
    if (!this.environment.enabled || !this.environment.serviceWorker) return;
    try { await this.register(); }
    catch { this.publish({ status: "error", message: "App update support couldn’t start. Check your connection and try again." }); }
  }

  check(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = this.checkNow().finally(() => { this.checking = null; });
    return this.checking;
  }

  private async checkNow(): Promise<void> {
    if (!this.environment.enabled || !this.environment.serviceWorker) {
      this.publish({ status: "unsupported", message: "Update checks require a supported browser over HTTPS (or localhost) and a production build." });
      return;
    }
    if (!this.environment.isOnline()) {
      this.publish({ status: "offline", message: "Connect to the internet, then try again. Your current version is unchanged." });
      return;
    }
    this.publish({ status: "checking", message: "Looking for a new version…" });
    try {
      const registration = await this.register();
      const response = await within(this.environment.fetch("/version.json", { cache: "no-store", credentials: "same-origin" }));
      if (!response.ok) throw new Error("Update metadata unavailable.");
      const metadata: unknown = await within(response.json());
      if (!metadata || typeof metadata !== "object" || !("version" in metadata) || typeof metadata.version !== "string" || !metadata.version.trim()) {
        throw new Error("Invalid update metadata.");
      }
      await within(registration.update());
      const worker = registration.installing;
      if (worker && worker.state !== "installed" && worker.state !== "activated" && worker.state !== "redundant") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { cleanup(); reject(new Error("Update download timed out.")); }, 15_000);
          const cleanup = (): void => { clearTimeout(timer); worker.removeEventListener("statechange", changed); };
          const changed = (): void => {
            if (worker.state === "redundant") { cleanup(); reject(new Error("Update installation failed.")); }
            else if (worker.state === "installed" || worker.state === "activated") { cleanup(); resolve(); }
          };
          worker.addEventListener("statechange", changed);
          changed();
        });
      } else if (worker?.state === "redundant") {
        throw new Error("Update installation failed.");
      }
      if (registration.waiting || metadata.version !== this.currentVersion) this.available(metadata.version !== this.currentVersion ? metadata.version : undefined);
      else this.publish({ status: "current", message: "You’re using the latest version. Checked just now." });
    } catch {
      // A known waiting update remains usable even if a metadata refresh fails.
      if (this.registration?.waiting) this.available();
      else this.publish({ status: this.environment.isOnline() ? "error" : "offline", message: "Couldn’t check for updates. Check your connection and try again." });
    }
  }

  defer(): void {
    if (this.snapshot.status !== "available" || this.applying) return;
    this.publish({ ...this.snapshot, message: "Update postponed. Keep using Finance; apply it when you’re ready." });
  }

  apply(): void {
    if (this.snapshot.status !== "available" || this.applying) return;
    const worker = this.registration?.waiting;
    if (!worker) { this.environment.reload(); return; }
    this.applying = true;
    this.publish({ ...this.snapshot, applying: true, message: "Applying update… Finance will reload when it’s ready." });
    this.applyTimer = setTimeout(() => {
      this.applying = false;
      this.publish({ status: "error", message: "The update couldn’t be applied. Check for updates and try again." });
    }, 15_000);
    try { worker.postMessage({ type: "SKIP_WAITING" }); }
    catch {
      clearTimeout(this.applyTimer);
      this.applying = false;
      this.publish({ status: "error", message: "The update couldn’t be applied. Check for updates and try again." });
    }
  }
}
