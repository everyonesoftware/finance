using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Finance.App;
using Velopack.Exceptions;
using Velopack.Locators;
using Velopack.Logging;

const string id = "EveryoneSoftware.Finance";
const string feed = "releases.win-x64.json";
const string package = id + "-0.1.20-win-x64-full.nupkg";
const string catalog = "https://api.github.com/repos/everyonesoftware/finance/releases?per_page=25&page=";
const string root = "https://github.com/everyonesoftware/finance/releases/download/native-v0.1.20/";
var version = new Version(0, 1, 20);
byte[] bytes = "finance test package"u8.ToArray();
byte[] corrupt = "invalid test package"u8.ToArray();
if (args is ["--live"])
{
    await using var directory = new Scratch();
    var backend = new WindowsUpdateBackend(null, Locator(directory.Path));
    Console.WriteLine($"Live discovery, no download: {await backend.CheckAsync()}");
    return;
}

await Run("Windows discovery ranks numeric tags across pages and ignores Android-only, drafts and prereleases", async (fixture, backend, _) =>
{
    fixture.Pages[1] = new[] { Release(21, windows: false), Release(23, draft: true), Release(22, prerelease: true) }
        .Concat(Enumerable.Range(1, 19).Select(n => Release(n)))
        .Concat(Enumerable.Range(100, 3).Select(n => Release(n, windows: false))).ToArray();
    fixture.Pages[2] = [Release(20)];
    Require(await backend.CheckAsync() == version, "Wrong Windows offer");
    Require(fixture.Requests.SequenceEqual([catalog + "1", catalog + "2", root + feed]), "Unexpected discovery requests");
    await ExpectAsync<InvalidOperationException>(() => RestartAsync(backend, version));
});

await Run("Fresh download follows the package CDN, reports progress and verifies bytes", async (fixture, backend, path) =>
{
    fixture.PackageRedirect = "https://release-assets.githubusercontent.com/fixture";
    Require(await backend.CheckAsync() == version, "Missing offer");
    var progress = new List<int>();
    await backend.DownloadAsync(version, progress.Add, default);
    Require(progress.Count > 0 && progress[^1] == 100, "No completed progress");
    Require(File.ReadAllBytes(Path.Combine(path, package)).SequenceEqual(bytes), "Wrong staged bytes");
    Require(fixture.Requests.SequenceEqual([catalog + "1", root + feed, root + package, fixture.PackageRedirect]), "Unexpected download requests");
});

await Run("Corrupt fresh package cannot stage", async (fixture, backend, path) =>
{
    fixture.Payload = corrupt;
    Require(await backend.CheckAsync() == version, "Missing offer");
    await ExpectAsync<ChecksumFailedException>(() => backend.DownloadAsync(version, _ => { }, default));
    Require(!File.Exists(Path.Combine(path, package)), "Corrupt package staged");
    await ExpectAsync<InvalidOperationException>(() => RestartAsync(backend, version));
});

await Run("A valid SHA-256 cannot mask an incorrect published SHA-1", async (fixture, backend, path) =>
{
    fixture.Fault = "mismatched-sha1";
    Require(await backend.CheckAsync() == version, "Missing offer");
    await ExpectAsync<ChecksumFailedException>(() => backend.DownloadAsync(version, _ => { }, default));
    Require(!File.Exists(Path.Combine(path, package)), "Package with mismatched SHA-1 staged");
});

await Run("Valid cached package is verified without download", async (fixture, backend, path) =>
{
    Require(await backend.CheckAsync() == version, "Missing offer");
    File.WriteAllBytes(Path.Combine(path, package), bytes);
    await backend.DownloadAsync(version, _ => { }, default);
    Require(fixture.Requests.Count == 2, "Cached package downloaded again");
});

await Run("Same-size corrupt cache is removed and explicit retry downloads fresh bytes", async (fixture, backend, path) =>
{
    Require(await backend.CheckAsync() == version, "Missing offer");
    var staged = Path.Combine(path, package);
    File.WriteAllBytes(staged, corrupt);
    await ExpectAsync<ChecksumFailedException>(() => backend.DownloadAsync(version, _ => { }, default));
    Require(!File.Exists(staged) && fixture.Requests.Count == 2, "Did not reject cached bytes without network");
    await ExpectAsync<InvalidOperationException>(() => RestartAsync(backend, version));
    await backend.DownloadAsync(version, _ => { }, default);
    Require(File.ReadAllBytes(staged).SequenceEqual(bytes), "Retry did not stage good bytes");
});

foreach (var fault in new[] { "identity", "version", "delta", "filename", "size", "sha256", "sha1", "duplicate", "missing-package", "origin", "redirect", "feed-size", "feed-digest" })
{
    await Run($"Reject {fault} in discovery", async (fixture, backend, _) =>
    {
        fixture.Fault = fault;
        await ExpectAsync<InvalidDataException>(async () => await backend.CheckAsync());
        Require(!fixture.Requests.Any(x => x.EndsWith(".nupkg") || x.Contains("untrusted.invalid")), "Unsafe request");
    });
}

foreach (string installed in new[] { "0.1.20", "0.1.21" })
{
    await Run($"No equal-version offer or downgrade from {installed}", async (fixture, _, path) =>
    {
        var backend = new WindowsUpdateBackend(fixture.Client, Locator(path, installed));
        Require(await backend.CheckAsync() is null, "Unexpected offer for equal or newer install");
    });
}

await Run("Changed metadata cannot reuse a verified staged version", async (fixture, backend, _) =>
{
    Require(await backend.CheckAsync() == version, "Missing offer");
    await backend.DownloadAsync(version, _ => { }, default);
    fixture.Fault = "changed";
    await ExpectAsync<InvalidDataException>(async () => await backend.CheckAsync());
    await ExpectAsync<InvalidOperationException>(() => RestartAsync(backend, version));
});

foreach (string change in new[] { "missing", "replaced" })
{
    await Run($"Restart refuses a {change} staged package without launching Update.exe", async (fixture, _, path) =>
    {
        var locator = new RestartLocator(id, path);
        var backend = new WindowsUpdateBackend(fixture.Client, locator);
        Require(await backend.CheckAsync() == version, "Missing offer");
        await backend.DownloadAsync(version, _ => { }, default);
        var staged = Path.Combine(path, package);
        if (change == "missing") File.Delete(staged);
        else File.WriteAllBytes(staged, corrupt);

        bool rejected = false;
        try { await RestartAsync(backend, version); }
        catch (Exception ex) when (ex is IOException or ChecksumFailedException) { rejected = true; }
        Require(locator.Arguments is null && locator.ExitCode is null, "Invalid staged package reached the updater or exited Finance");
        Require(rejected, "Invalid staged package was not rejected");
    });
}

await Run("Restart hands off the exact verified package even after a matching recheck", async (fixture, _, path) =>
{
    var locator = new RestartLocator(id, path);
    var backend = new WindowsUpdateBackend(fixture.Client, locator);
    Require(await backend.CheckAsync() == version, "Missing offer");
    await backend.DownloadAsync(version, _ => { }, default);
    Require(await backend.CheckAsync() == version, "Missing matching offer");
    await RestartAsync(backend, version);
    Require(locator.Arguments is ["apply", "--package", var exact, "--waitPid", "123", "--rootDir", var rootDir,
        "--packageDir", var packageDir] && exact == Path.Combine(path, package) && rootDir == path && packageDir == path,
        "Restart did not pin the exact package and wait for Finance to exit");
    Require(locator.ExitCode == 0, "Finance did not exit after launching Update.exe");
});

await Run("429 cooldown persists, is bounded, and does not block manual retry", async (fixture, _, path) =>
{
    var clock = new Clock();
    var marker = Path.Combine(path, "cooldown");
    WindowsUpdateBackend Create() => new(fixture.Client, Locator(path), marker, clock);
    fixture.Fault = "rate-limit";
    await ExpectAsync<HttpRequestException>(async () => await Create().CheckAsync());
    Require(Create().IsStartupCheckDeferred, "Missing persisted cooldown");
    fixture.Fault = null;
    Require(await Create().CheckAsync() == version, "Manual retry blocked");
    clock.Now += TimeSpan.FromHours(1);
    Require(!Create().IsStartupCheckDeferred, "Cooldown not bounded");
});

async Task Run(string name, Func<Fixture, WindowsUpdateBackend, string, Task> body)
{
    await using var directory = new Scratch();
    using var fixture = new Fixture(catalog, root, feed, package, bytes, Release(20));
    var backend = new WindowsUpdateBackend(fixture.Client, Locator(directory.Path));
    await body(fixture, backend, directory.Path);
    Console.WriteLine($"PASS {name}");
}

static TestVelopackLocator Locator(string path, string installed = "0.1.19") => new(id, installed, path, NullVelopackLogger.Instance);
object Release(int n, bool windows = true, bool draft = false, bool prerelease = false)
{
    string tag = $"native-v0.1.{n}";
    object Asset(string name, long size) => new { name, state = "uploaded", size, browser_download_url = $"https://github.com/everyonesoftware/finance/releases/download/{tag}/{name}" };
    return new { tag_name = tag, draft, prerelease, assets = windows ? new[] { Asset(feed, 1), Asset($"{id}-0.1.{n}-win-x64-full.nupkg", bytes.Length) } : [Asset("android.json", 1)] };
}
static void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
static async Task RestartAsync(WindowsUpdateBackend backend, Version version)
{
    using var verified = await backend.VerifyForRestartAsync(version, default);
    verified.ApplyAndRestart();
}
static async Task ExpectAsync<T>(Func<Task> action) where T : Exception
{
    try { await action(); } catch (T) { return; }
    throw new Exception($"Expected {typeof(T).Name}");
}

sealed class Scratch : IAsyncDisposable
{
    public string Path { get; } = Directory.CreateTempSubdirectory("finance-updates-").FullName;
    public ValueTask DisposeAsync() { Directory.Delete(Path, recursive: true); return ValueTask.CompletedTask; }
}

sealed class Clock : TimeProvider
{
    public DateTimeOffset Now { get; set; } = DateTimeOffset.UnixEpoch;
    public override DateTimeOffset GetUtcNow() => Now;
}

sealed class RestartLocator(string id, string path)
    : TestVelopackLocator(id, "0.1.19", path, path, path, CreateUpdater(path)), IProcessImpl
{
    public override IProcessImpl Process => this;
    public string[]? Arguments { get; private set; }
    uint IProcessImpl.GetCurrentProcessId() => 123;
    void IProcessImpl.StartProcess(string exePath, IEnumerable<string> args, string workDir, bool showWindow)
        => Arguments = args.ToArray();

    private static string CreateUpdater(string path)
    {
        var exe = Path.Combine(path, "Update.exe");
        File.WriteAllBytes(exe, []);
        return exe;
    }
}

sealed class Fixture(string catalog, string root, string feed, string package, byte[] bytes, object release) : IDisposable
{
    private HttpClient? client;
    public HttpClient Client => client ??= new(new Handler(this));
    public Dictionary<int, object[]> Pages { get; } = new() { [1] = [release] };
    public List<string> Requests { get; } = [];
    public string? Fault { get; set; }
    public string? PackageRedirect { get; set; }
    private byte[]? payload;
    public byte[] Payload { get => payload ?? bytes; set => payload = value; }
    public void Dispose() => client?.Dispose();

    private HttpResponseMessage Send(HttpRequestMessage request)
    {
        if (request.Headers.Authorization is not null || request.Headers.Contains("Cookie")) throw new Exception("Credentials leaked");
        string url = request.RequestUri!.AbsoluteUri;
        Requests.Add(url);
        if (url.StartsWith(catalog, StringComparison.Ordinal))
        {
            if (Fault == "rate-limit")
            {
                var response = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
                response.Headers.RetryAfter = new(TimeSpan.FromDays(10));
                return response;
            }
            var page = JsonSerializer.SerializeToNode(Pages.GetValueOrDefault(int.Parse(url[catalog.Length..])) ?? [])!.AsArray();
            var feedBytes = Encoding.UTF8.GetBytes(FeedJson());
            foreach (var item in page)
            foreach (var asset in item!["assets"]!.AsArray())
            {
                if (asset!["browser_download_url"]?.GetValue<string>() != root + feed) continue;
                asset["size"] = feedBytes.Length + (Fault == "feed-size" ? 1 : 0);
                asset["digest"] = "sha256:" + (Fault == "feed-digest" ? new string('a', 64) : Convert.ToHexString(SHA256.HashData(feedBytes)).ToLowerInvariant());
            }
            string json = page.ToJsonString();
            if (Fault == "missing-package") json = json.Replace(package, "not-a-windows-artifact");
            if (Fault == "origin") json = json.Replace(root + feed, "https://untrusted.invalid/" + feed);
            return Ok(new StringContent(json));
        }
        if (url == root + feed) return Fault == "redirect" ? Redirect("https://untrusted.invalid/fixture") : Ok(new StringContent(FeedJson()));
        if (url == root + package) return PackageRedirect is { } redirect ? Redirect(redirect) : Ok(new ByteArrayContent(Payload));
        if (url == PackageRedirect) return Ok(new ByteArrayContent(Payload));
        throw new Exception($"Unexpected request: {url}");
    }

    private string FeedJson()
    {
        var asset = new
        {
            PackageId = Fault == "identity" ? "Other" : "EveryoneSoftware.Finance",
            Version = Fault == "version" ? "0.1.21" : "0.1.20",
            Type = Fault == "delta" ? "Delta" : "Full",
            FileName = Fault == "filename" ? "../" + package : package,
            Size = Fault == "size" ? 0 : bytes.Length,
            SHA256 = Fault == "sha256" ? "bad" : Fault == "changed" ? new string('A', 64) : Convert.ToHexString(SHA256.HashData(bytes)),
            SHA1 = Fault == "sha1" ? "bad" : Fault == "mismatched-sha1" ? new string('A', 40) : Convert.ToHexString(SHA1.HashData(bytes)),
        };
        return JsonSerializer.Serialize(new { Assets = Fault == "duplicate" ? new[] { asset, asset } : [asset] });
    }

    private static HttpResponseMessage Ok(HttpContent content) => new(HttpStatusCode.OK) { Content = content };
    private static HttpResponseMessage Redirect(string url) => new(HttpStatusCode.Found) { Headers = { Location = new Uri(url) } };
    private sealed class Handler(Fixture fixture) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => Task.FromResult(fixture.Send(request));
    }
}
