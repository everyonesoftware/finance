namespace Finance.App;

internal enum WindowsUpdatePhase { Idle, Checking, Current, Available, Downloading, Ready, Restarting, Error, NotInstalled, StartupDeferred }
internal sealed record WindowsUpdateStatus(WindowsUpdatePhase Phase, string Message = "", Version? Version = null, int Progress = 0);

/// <summary>Serializes package operations independently of the Finance connection.</summary>
internal sealed class WindowsUpdateController(IWindowsUpdateBackend backend) : IDisposable
{
    private readonly object gate = new();
    private readonly CancellationTokenSource lifetime = new();
    private WindowsUpdateStatus status = new(WindowsUpdatePhase.Idle);
    private bool disposed, startupRequested;
    private long operation;

    public WindowsUpdateStatus Status { get { lock (gate) return status; } }
    // Subscribers must marshal to the UI thread; progress can arrive from the package worker.
    public event Action<WindowsUpdateStatus>? Changed;

    public Task CheckOnStartupAsync() => CheckAsync(startup: true);
    public Task CheckAsync() => CheckAsync(startup: false);

    private async Task CheckAsync(bool startup)
    {
        long id;
        lock (gate)
        {
            if (disposed || (startup && startupRequested)) return;
            if (startup) startupRequested = true;
            if (status.Phase is WindowsUpdatePhase.Checking or WindowsUpdatePhase.Downloading or
                WindowsUpdatePhase.Ready or WindowsUpdatePhase.Restarting or WindowsUpdatePhase.NotInstalled) return;
            id = ++operation;
            Publish(new(WindowsUpdatePhase.Checking, "Looking for a newer Windows version…"));
        }

        WindowsUpdateStatus result;
        try
        {
            // Hold the phase gate before dispatch, including lazy locator and cooldown I/O.
            result = await Task.Run(async () =>
            {
                if (!backend.IsInstalled)
                    return new WindowsUpdateStatus(WindowsUpdatePhase.NotInstalled,
                        "Install Finance using the Windows installer to enable in-app updates. Loose builds cannot update.");
                if (startup && backend.IsStartupCheckDeferred)
                    return new(WindowsUpdatePhase.StartupDeferred, "Automatic check deferred. You can still check manually.");
                lifetime.Token.ThrowIfCancellationRequested();
                var version = await backend.CheckAsync();
                return version is not null && version > backend.CurrentVersion
                    ? new(WindowsUpdatePhase.Available, Version: version)
                    : new(WindowsUpdatePhase.Current, "No newer Windows version is available.");
            }, lifetime.Token).ConfigureAwait(false);
        }
        catch
        {
            result = new(WindowsUpdatePhase.Error, "Could not check for updates. Check your connection and try again.");
        }
        Complete(id, result);
    }

    public async Task DownloadAsync()
    {
        long id;
        Version version;
        lock (gate)
        {
            if (disposed || status.Phase != WindowsUpdatePhase.Available || status.Version is not { } offered) return;
            id = ++operation;
            version = offered;
            Publish(new(WindowsUpdatePhase.Downloading, "Downloading update…", version));
        }

        WindowsUpdateStatus result;
        try
        {
            await Task.Run(() => backend.DownloadAsync(version, value => ReportProgress(id, value), lifetime.Token),
                lifetime.Token).ConfigureAwait(false);
            result = new(WindowsUpdatePhase.Ready, "The update is ready to install.", version, 100);
        }
        catch
        {
            result = new(WindowsUpdatePhase.Error, "Could not download or verify the update. Nothing was installed. Check for updates to try again.");
        }
        Complete(id, result);
    }

    public async Task Restart(Func<bool> allowed)
    {
        Version version;
        lock (gate)
        {
            if (disposed || status.Phase != WindowsUpdatePhase.Ready || status.Version is not { } ready || !allowed()) return;
            version = ready;
            Publish(new(WindowsUpdatePhase.Restarting, "Verifying the update before restarting Finance…", version, 100));
        }

        IVerifiedWindowsUpdate verified;
        try
        {
            // Resume on the UI context for the final eligibility check and handoff.
            verified = await Task.Run(() => backend.VerifyForRestartAsync(version, lifetime.Token), lifetime.Token);
        }
        catch
        {
            lock (gate)
            {
                if (!disposed)
                    Publish(new(WindowsUpdatePhase.Error, "Could not verify the staged update. Check for updates to download it again."));
            }
            return;
        }

        lock (gate)
        {
            WindowsUpdateStatus? result = null;
            using (verified)
            {
                if (disposed) return;
                try
                {
                    if (allowed()) verified.ApplyAndRestart();
                    else result = new(WindowsUpdatePhase.Ready, "The update is ready to install.", version, 100);
                }
                catch
                {
                    result = new(WindowsUpdatePhase.Ready, "Could not start the installer. Try Restart and install again.", version, 100);
                }
            }
            if (!disposed && result is not null) Publish(result);
        }
    }

    private void ReportProgress(long id, int value)
    {
        lock (gate)
        {
            var progress = Math.Clamp(value, 0, 100);
            if (!disposed && operation == id && status.Phase == WindowsUpdatePhase.Downloading && progress > status.Progress)
                Publish(status with { Progress = progress });
        }
    }

    private void Complete(long id, WindowsUpdateStatus result)
    {
        lock (gate)
        {
            if (!disposed && operation == id) Publish(result);
        }
    }

    private void Publish(WindowsUpdateStatus next)
    {
        status = next;
        Changed?.Invoke(next);
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            Changed = null;
        }
        // Leave the token source usable by the in-flight worker until it unwinds.
        lifetime.Cancel();
    }
}
