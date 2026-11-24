using Finance.App;

var newer = new Version(0, 2, 0);
var checks = new (string Name, Func<Task> Run)[]
{
    ("Startup reserves discovery before blocking locator work and never downloads", Startup),
    ("Deferred startup allows manual retry", Deferred),
    ("Failed startup allows manual retry", CheckFailure),
    ("Unmanaged installs and equal or older releases never offer an update", NoOffer),
    ("Only explicit download and restart advance a validated offer", ExplicitActions),
    ("Losing restart eligibility during verification prevents handoff", RestartGate),
    ("Failed restart verification requires a new check and download", RestartVerificationFailure),
    ("Download and restart failures remain retryable", Retry),
    ("Closing during locator initialization prevents discovery", CloseDuringLocator),
    ("Closing cancels download and suppresses late progress and completion", Close),
};
foreach (var check in checks)
{
    await check.Run().WaitAsync(TimeSpan.FromSeconds(10));
    Console.WriteLine($"PASS {check.Name}");
}

async Task Startup()
{
    var entered = Signal();
    var release = Signal();
    var backend = new FakeBackend
    {
        Installed = () => { entered.SetResult(); release.Task.GetAwaiter().GetResult(); return true; },
        Discover = () => Task.FromResult<Version?>(newer)
    };
    using var controller = new WindowsUpdateController(backend);
    var started = controller.CheckOnStartupAsync();
    try
    {
        Equal(WindowsUpdatePhase.Checking, controller.Status.Phase);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        await controller.CheckAsync();
        await controller.CheckOnStartupAsync();
        await controller.DownloadAsync();
        await controller.Restart(() => true);
        Equal(0, backend.Checks);
    }
    finally { release.TrySetResult(); }
    await started;
    await controller.CheckOnStartupAsync();
    Equal(1, backend.Checks);
    Equal(WindowsUpdatePhase.Available, controller.Status.Phase);
    Equal(0, backend.Downloads);
    Equal(0, backend.Restarts);
}

async Task Deferred()
{
    var backend = new FakeBackend { IsStartupCheckDeferred = true, Discover = () => Task.FromResult<Version?>(newer) };
    using var controller = new WindowsUpdateController(backend);
    await controller.CheckOnStartupAsync();
    Equal(WindowsUpdatePhase.StartupDeferred, controller.Status.Phase);
    Equal(0, backend.Checks);
    await controller.CheckAsync();
    Equal(WindowsUpdatePhase.Available, controller.Status.Phase);
    Equal(1, backend.Checks);
}

async Task CheckFailure()
{
    var backend = new FakeBackend { Discover = () => throw new IOException("not for display") };
    using var controller = new WindowsUpdateController(backend);
    await controller.CheckOnStartupAsync();
    Equal(WindowsUpdatePhase.Error, controller.Status.Phase);
    Equal(false, controller.Status.Message.Contains("not for display", StringComparison.Ordinal));
    backend.Discover = () => Task.FromResult<Version?>(newer);
    await controller.CheckAsync();
    Equal(WindowsUpdatePhase.Available, controller.Status.Phase);
    Equal(2, backend.Checks);
}

async Task NoOffer()
{
    var backend = new FakeBackend { Installed = () => false };
    using var unmanaged = new WindowsUpdateController(backend);
    await unmanaged.CheckOnStartupAsync();
    await unmanaged.CheckAsync();
    Equal(WindowsUpdatePhase.NotInstalled, unmanaged.Status.Phase);
    Equal(0, backend.Checks);
    foreach (var version in new[] { null, backend.CurrentVersion, new Version(0, 0, 1) })
    {
        using var current = new WindowsUpdateController(new FakeBackend { Discover = () => Task.FromResult(version) });
        await current.CheckAsync();
        Equal(WindowsUpdatePhase.Current, current.Status.Phase);
        Equal<Version?>(null, current.Status.Version);
    }
}

async Task ExplicitActions()
{
    var downloading = Signal();
    var release = Signal();
    Action<int>? progress = null;
    var backend = new FakeBackend
    {
        Discover = () => Task.FromResult<Version?>(newer),
        Download = async (report, _) => { progress = report; report(35); downloading.SetResult(); await release.Task; }
    };
    using var controller = new WindowsUpdateController(backend);
    await controller.DownloadAsync();
    await controller.Restart(() => true);
    await controller.CheckAsync();
    Equal(0, backend.Downloads);
    Equal(newer, controller.Status.Version);
    var download = controller.DownloadAsync();
    await downloading.Task;
    Equal(35, controller.Status.Progress);
    progress!(12);
    Equal(35, controller.Status.Progress);
    progress(150);
    Equal(100, controller.Status.Progress);
    Equal(WindowsUpdatePhase.Downloading, controller.Status.Phase);
    await controller.CheckAsync();
    await controller.DownloadAsync();
    await controller.Restart(() => true);
    Equal(1, backend.Checks);
    Equal(1, backend.Downloads);
    Equal(0, backend.Restarts);
    Equal(newer, backend.DownloadVersion);
    release.SetResult();
    await download;
    progress(50);
    Equal(WindowsUpdatePhase.Ready, controller.Status.Phase);
    Equal(0, backend.Restarts);
    await controller.Restart(() => false);
    Equal(WindowsUpdatePhase.Ready, controller.Status.Phase);
    Equal(0, backend.Restarts);
    await controller.Restart(() => true);
    await controller.Restart(() => true);
    Equal(WindowsUpdatePhase.Restarting, controller.Status.Phase);
    Equal(1, backend.Restarts);
    Equal(newer, backend.RestartVersion);
}

async Task Retry()
{
    var entered = Signal();
    var release = Signal();
    Action<int>? abandonedProgress = null;
    var backend = new FakeBackend
    {
        Discover = () => Task.FromResult<Version?>(newer),
        Download = (report, _) => { abandonedProgress = report; throw new IOException(); }
    };
    using var controller = new WindowsUpdateController(backend);
    await controller.CheckAsync();
    await controller.DownloadAsync();
    Equal(WindowsUpdatePhase.Error, controller.Status.Phase);
    await controller.Restart(() => true);
    Equal(0, backend.Restarts);
    await controller.CheckAsync();
    backend.Download = async (report, _) => { report(20); entered.SetResult(); await release.Task; };
    var retry = controller.DownloadAsync();
    await entered.Task;
    abandonedProgress!(90);
    Equal(20, controller.Status.Progress);
    release.SetResult();
    await retry;
    backend.Apply = () => throw new IOException();
    await controller.Restart(() => true);
    Equal(WindowsUpdatePhase.Ready, controller.Status.Phase);
    Equal(newer, controller.Status.Version);
    backend.Apply = () => { };
    await controller.Restart(() => true);
    Equal(WindowsUpdatePhase.Restarting, controller.Status.Phase);
    Equal(2, backend.Restarts);
}

async Task Close()
{
    var entered = Signal();
    var release = Signal();
    CancellationToken observedToken = default;
    var backend = new FakeBackend
    {
        Discover = () => Task.FromResult<Version?>(newer),
        Download = async (report, token) =>
        {
            observedToken = token;
            entered.SetResult();
            await release.Task;
            report(100);
        }
    };
    using var controller = new WindowsUpdateController(backend);
    // Wait for progress and completion even when the backend ignores cancellation.
    var publications = 0;
    controller.Changed += _ => publications++;
    await controller.CheckAsync();
    var download = controller.DownloadAsync();
    await entered.Task;
    controller.Dispose();
    var before = publications;
    Equal(true, observedToken.IsCancellationRequested);
    release.SetResult();
    await download;
    await controller.CheckAsync();
    await controller.Restart(() => true);
    Equal(before, publications);
    Equal(1, backend.Checks);
    Equal(0, backend.Restarts);
}

async Task RestartGate()
{
    var entered = Signal();
    var release = Signal();
    var backend = new FakeBackend
    {
        Discover = () => Task.FromResult<Version?>(newer),
        Verify = async _ => { entered.SetResult(); await release.Task; },
    };
    using var controller = new WindowsUpdateController(backend);
    await controller.CheckAsync();
    await controller.DownloadAsync();
    bool allowed = true;
    var restart = controller.Restart(() => allowed);
    await entered.Task;
    try
    {
        Equal(WindowsUpdatePhase.Restarting, controller.Status.Phase);
        await controller.Restart(() => true);
        await controller.CheckAsync();
        await controller.DownloadAsync();
        Equal(1, backend.Checks);
        Equal(1, backend.Downloads);
        Equal(0, backend.Restarts);
        allowed = false;
    }
    finally { release.TrySetResult(); }
    await restart;
    Equal(WindowsUpdatePhase.Ready, controller.Status.Phase);
    Equal(0, backend.Restarts);
}

async Task RestartVerificationFailure()
{
    var backend = new FakeBackend
    {
        Discover = () => Task.FromResult<Version?>(newer),
        Verify = _ => throw new IOException("Staged package no longer matches"),
    };
    using var controller = new WindowsUpdateController(backend);
    await controller.CheckAsync();
    await controller.DownloadAsync();
    await controller.Restart(() => true);
    Equal(WindowsUpdatePhase.Error, controller.Status.Phase);
    await controller.Restart(() => true);
    Equal(0, backend.Restarts);
    await controller.CheckAsync();
    Equal(WindowsUpdatePhase.Available, controller.Status.Phase);
    await controller.DownloadAsync();
    Equal(WindowsUpdatePhase.Ready, controller.Status.Phase);
    Equal(2, backend.Downloads);
}

async Task CloseDuringLocator()
{
    var entered = Signal();
    var release = Signal();
    var backend = new FakeBackend
    {
        Installed = () => { entered.SetResult(); release.Task.GetAwaiter().GetResult(); return true; }
    };
    using var controller = new WindowsUpdateController(backend);
    var check = controller.CheckOnStartupAsync();
    await entered.Task;
    controller.Dispose();
    release.SetResult();
    await check;
    Equal(0, backend.Checks);
}

static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
static void Equal<T>(T expected, T actual)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
        throw new InvalidOperationException($"Expected {expected}, got {actual}.");
}

sealed class FakeBackend : IWindowsUpdateBackend
{
    public Func<bool> Installed = () => true;
    public Func<Task<Version?>> Discover = () => Task.FromResult<Version?>(null);
    public Func<Action<int>, CancellationToken, Task> Download = (_, _) => Task.CompletedTask;
    public Func<CancellationToken, Task> Verify = _ => Task.CompletedTask;
    public Action Apply = () => { };
    public int Checks, Downloads, Restarts;
    public Version? DownloadVersion, RestartVersion;
    public bool IsInstalled => Installed();
    public bool IsStartupCheckDeferred { get; set; }
    public Version CurrentVersion { get; } = new(0, 1, 0);
    public Task<Version?> CheckAsync() { Interlocked.Increment(ref Checks); return Discover(); }
    public Task DownloadAsync(Version version, Action<int> progress, CancellationToken token)
    {
        DownloadVersion = version;
        Interlocked.Increment(ref Downloads);
        return Download(progress, token);
    }
    public async Task<IVerifiedWindowsUpdate> VerifyForRestartAsync(Version version, CancellationToken token)
    {
        await Verify(token);
        return new Verified(() =>
        {
            RestartVersion = version;
            Interlocked.Increment(ref Restarts);
            Apply();
        });
    }

    private sealed class Verified(Action apply) : IVerifiedWindowsUpdate
    {
        public void ApplyAndRestart() => apply();
        public void Dispose() { }
    }
}
