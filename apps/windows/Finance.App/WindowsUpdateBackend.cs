using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Velopack;
using Velopack.Exceptions;
using Velopack.Locators;
using Velopack.Logging;
using Velopack.Sources;

namespace Finance.App;

internal interface IWindowsUpdateBackend
{
    bool IsInstalled { get; }
    bool IsStartupCheckDeferred { get; }
    Version CurrentVersion { get; }
    Task<Version?> CheckAsync();
    Task DownloadAsync(Version version, Action<int> progress, CancellationToken token);
    Task<IVerifiedWindowsUpdate> VerifyForRestartAsync(Version version, CancellationToken token);
}

internal interface IVerifiedWindowsUpdate : IDisposable
{
    void ApplyAndRestart();
}

// The caller serializes operations; discovery never downloads a package or starts Update.exe.
internal sealed class WindowsUpdateBackend : IWindowsUpdateBackend
{
    private readonly FinanceReleaseSource source;
    private readonly Lazy<PackageManager> manager;
    private UpdateInfo? offered;
    private VelopackAsset? staged;
    private bool downloaded;

    public WindowsUpdateBackend() : this(null, null, DefaultCooldownPath()) { }

    internal WindowsUpdateBackend(HttpClient? http, IVelopackLocator? locator, string? cooldownPath = null, TimeProvider? clock = null)
    {
        source = new(http, cooldownPath, clock ?? TimeProvider.System);
        manager = new(() => new PackageManager(source, new UpdateOptions
        {
            ExplicitChannel = FinanceReleaseSource.Channel,
            AllowVersionDowngrade = false,
            MaximumDeltasBeforeFallback = -1,
        }, locator));
    }

    private static string? DefaultCooldownPath()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolderOption.DoNotVerify);
        return local.Length == 0 ? null : Path.Combine(local, "EveryoneSoftware", "Finance", "windows-update-cooldown");
    }

    public bool IsInstalled => manager.Value.IsInstalled && manager.Value.AppId == FinanceReleaseSource.PackageId;
    public bool IsStartupCheckDeferred => source.IsStartupCheckDeferred;
    public Version CurrentVersion => Version.Parse(manager.Value.CurrentVersion?.ToString() ?? "0.0.0");

    public async Task<Version?> CheckAsync()
    {
        offered = null;
        bool wasDownloaded = downloaded;
        downloaded = false;
        if (!IsInstalled) throw new InvalidOperationException("Finance is not installed through Velopack.");
        var update = await manager.Value.CheckForUpdatesAsync().ConfigureAwait(false);
        if (update is null) return null;
        var target = update.TargetFullRelease;
        var version = Version.Parse(target.Version.ToString());
        if (update.IsDowngrade || version <= CurrentVersion)
            throw new InvalidDataException("Unsafe Finance update target.");

        bool sameVersion = staged is not null && staged.Version == target.Version;
        if (sameVersion && (staged!.FileName != target.FileName || staged.Size != target.Size
            || !string.Equals(staged.SHA256, target.SHA256, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(staged.SHA1, target.SHA1, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidDataException("Published metadata differs from the staged Finance package.");
        offered = update;
        downloaded = wasDownloaded && sameVersion;
        return version;
    }

    private UpdateInfo RequireOffer(Version version) => offered is { } update
        && update.TargetFullRelease.Version.ToString() == version.ToString() && version > CurrentVersion
        ? update : throw new InvalidOperationException("No matching newer Finance update.");

    public async Task DownloadAsync(Version version, Action<int> progress, CancellationToken token)
    {
        downloaded = false;
        var update = RequireOffer(version);
        token.ThrowIfCancellationRequested();
        await manager.Value.DownloadAndVerifyAsync(update, p => { if (p < 100) progress(p); }, token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        staged = update.TargetFullRelease;
        progress(100);
        downloaded = true;
    }

    public async Task<IVerifiedWindowsUpdate> VerifyForRestartAsync(Version version, CancellationToken token)
    {
        var offer = RequireOffer(version).TargetFullRelease;
        if (!downloaded || staged is not { } asset || asset.Version != offer.Version)
            throw new InvalidOperationException("Download and verify the Finance update first.");
        try { return await manager.Value.VerifyForRestartAsync(asset, token).ConfigureAwait(false); }
        catch
        {
            downloaded = false;
            throw;
        }
    }

    private sealed class PackageManager(IUpdateSource source, UpdateOptions options, IVelopackLocator? locator)
        : UpdateManager(source, options, locator)
    {
        private bool verifiedDuringDownload;

        public async Task<IVerifiedWindowsUpdate> VerifyForRestartAsync(VelopackAsset asset, CancellationToken token)
        {
            var updateLock = await AcquireUpdateLock().ConfigureAwait(false);
            FileStream? file = null;
            try
            {
                token.ThrowIfCancellationRequested();
                var path = Path.GetFullPath(Path.Combine(Locator.PackagesDir!, asset.FileName));
                // On Windows, deny write/delete sharing until the exact path has been handed off.
                file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, useAsync: true);
                await VerifyBytesAsync(asset, file, token).ConfigureAwait(false);
                return new VerifiedPackage(Locator, file, updateLock);
            }
            catch
            {
                file?.Dispose();
                updateLock.Dispose();
                throw;
            }
        }

        private sealed class VerifiedPackage(IVelopackLocator locator, FileStream package, IDisposable updateLock)
            : IVerifiedWindowsUpdate
        {
            public void ApplyAndRestart()
            {
                var updater = locator.UpdateExePath;
                if (!File.Exists(updater)) throw new FileNotFoundException("Cannot find Update.exe to apply updates.", updater);
                // Velopack 1.2.161's managed helper can omit --package; the native updater
                // then selects the newest local package. Always supply the verified path instead.
                locator.Process.StartProcess(updater!,
                    ["apply", "--package", package.Name, "--waitPid", locator.Process.GetCurrentProcessId().ToString(CultureInfo.InvariantCulture),
                     "--rootDir", locator.RootAppDir!, "--packageDir", locator.PackagesDir!],
                    Path.GetDirectoryName(updater)!, false);
                locator.Process.Exit(0);
            }

            public void Dispose()
            {
                package.Dispose();
                updateLock.Dispose();
            }
        }

        public async Task DownloadAndVerifyAsync(UpdateInfo update, Action<int> progress, CancellationToken token)
        {
            verifiedDuringDownload = false;
            await DownloadUpdatesAsync(update, progress, token).ConfigureAwait(false);
            if (verifiedDuringDownload) return;

            // The SDK skips the verifier on a cache hit. Verify under the same update lock.
            using var updateLock = await AcquireUpdateLock().ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            var asset = update.TargetFullRelease;
            // The source accepts only the exact version-derived, filesystem-safe filename.
            string file = Path.Combine(Locator.PackagesDir!, asset.FileName);
            try { await VerifyPackageChecksumAsync(asset, file).ConfigureAwait(false); }
            catch (ChecksumFailedException)
            {
                File.Delete(file);
                throw;
            }
        }

        protected override async Task VerifyPackageChecksumAsync(VelopackAsset asset, string? file = null)
        {
            file ??= Path.Combine(Locator.PackagesDir!, asset.FileName);
            await using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, useAsync: true);
            await VerifyBytesAsync(asset, stream, default).ConfigureAwait(false);
            verifiedDuringDownload = true;
        }

        private static async Task VerifyBytesAsync(VelopackAsset asset, FileStream stream, CancellationToken token)
        {
            if (stream.Length != asset.Size)
                throw new ChecksumFailedException(stream.Name, "Finance package size mismatch.");

            // The feed requires both digests. Compute them in one pass over the same open file.
            using var sha256 = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            using var sha1 = IncrementalHash.CreateHash(HashAlgorithmName.SHA1);
            var buffer = new byte[64 * 1024];
            int read;
            while ((read = await stream.ReadAsync(buffer, token).ConfigureAwait(false)) != 0)
            {
                sha256.AppendData(buffer, 0, read);
                sha1.AppendData(buffer, 0, read);
            }
            if (!string.Equals(Convert.ToHexString(sha256.GetHashAndReset()), asset.SHA256, StringComparison.OrdinalIgnoreCase))
                throw new ChecksumFailedException(stream.Name, "Finance package SHA-256 mismatch.");
            if (!string.Equals(Convert.ToHexString(sha1.GetHashAndReset()), asset.SHA1, StringComparison.OrdinalIgnoreCase))
                throw new ChecksumFailedException(stream.Name, "Finance package SHA-1 mismatch.");
        }
    }
}

internal sealed class FinanceReleaseSource(HttpClient? http, string? cooldownPath, TimeProvider clock) : IUpdateSource
{
    public const string PackageId = "EveryoneSoftware.Finance";
    public const string Channel = "win-x64";
    private const string FeedName = "releases." + Channel + ".json";
    private const string Catalog = "https://api.github.com/repos/everyonesoftware/finance/releases?per_page=25&page=";
    private const string DownloadRoot = "https://github.com/everyonesoftware/finance/releases/download/";
    private const string TagPrefix = "native-v";
    private const int PageSize = 25;
    private const int MaxPages = 20;
    private const int MaxPageBytes = 2 * 1024 * 1024;
    private const int MaxFeedBytes = 64 * 1024;
    private const int MaxRedirects = 5;
    private static readonly TimeSpan MaxCooldown = TimeSpan.FromHours(1);
    private static readonly HttpClient AnonymousHttp = new(new HttpClientHandler
    {
        AllowAutoRedirect = false,
        UseCookies = false,
        AutomaticDecompression = DecompressionMethods.All,
    });
    private readonly HttpClient client = http ?? AnonymousHttp;

    private static string FullName(string version) => $"{PackageId}-{version}-{Channel}-full.nupkg";
    private static bool IsFinanceVersion(string version) => Version.TryParse(version, out var parsed)
        && parsed is { Major: 0, Minor: 1, Build: >= 1 and <= 65534, Revision: -1 }
        && parsed.ToString() == version;

    public async Task<VelopackAssetFeed> GetReleaseFeed(IVelopackLogger logger, string? appId, string channel,
        Guid? stagingId = null, VelopackAsset? latestLocalRelease = null)
    {
        if (appId != PackageId || channel != Channel) throw new InvalidDataException("Unexpected Finance update identity.");
        var release = await FindReleaseAsync().ConfigureAwait(false);
        if (release is null) throw new InvalidDataException("No stable Finance Windows update feed was published.");
        var (tag, assets) = release.Value;
        string version = tag[TagPrefix.Length..];
        string packageName = FullName(version);
        var feed = RequiredAsset(assets, tag, FeedName);
        var package = RequiredAsset(assets, tag, packageName);
        byte[] body = await ReadMetadataAsync(feed.Url, MaxFeedBytes, isCatalog: false).ConfigureAwait(false);
        if (body.LongLength != feed.Size || feed.Digest is { } feedDigest &&
            !string.Equals(feedDigest, "sha256:" + Convert.ToHexString(SHA256.HashData(body)), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Finance update feed bytes differ from the release inventory.");
        using var document = Parse(body);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("Assets", out var entries)
            || entries.ValueKind != JsonValueKind.Array || entries.GetArrayLength() != 1)
            throw new InvalidDataException("Expected exactly one Finance update package.");
        var asset = entries[0];
        if (Text(asset, "PackageId") != PackageId || Text(asset, "Version") != version || Text(asset, "Type") != "Full"
            || Text(asset, "FileName") != packageName || PositiveSize(asset, "Size") != package.Size
            || !IsHex(Text(asset, "SHA1"), 40) || !IsHex(Text(asset, "SHA256"), 64)
            || package.Digest is { } digest && !string.Equals(digest, "sha256:" + Text(asset, "SHA256"), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Finance update feed and release inventory disagree.");
        return new() { Assets = [new VelopackAsset
        {
            PackageId = PackageId,
            Version = SemanticVersion.Parse(version),
            Type = VelopackAssetType.Full,
            FileName = packageName,
            Size = package.Size,
            SHA1 = Text(asset, "SHA1")!.ToUpperInvariant(),
            SHA256 = Text(asset, "SHA256")!.ToUpperInvariant(),
        }] };
    }

    private async Task<(string Tag, JsonElement Assets)?> FindReleaseAsync()
    {
        (string Tag, JsonElement Assets)? selected = null;
        int rank = 0;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        for (int page = 1; page <= MaxPages; page++)
        {
            using var document = Parse(await ReadMetadataAsync(Catalog + page.ToString(CultureInfo.InvariantCulture), MaxPageBytes, isCatalog: true, timeout.Token).ConfigureAwait(false));
            var items = document.RootElement;
            if (items.ValueKind != JsonValueKind.Array || items.GetArrayLength() > PageSize)
                throw new InvalidDataException("Invalid Finance release catalog page.");
            foreach (var item in items.EnumerateArray())
            {
                string? tag = Text(item, "tag_name");
                if (tag is null) throw new InvalidDataException("Missing release tag.");
                if (!tag.StartsWith(TagPrefix, StringComparison.Ordinal) || !IsFinanceVersion(tag[TagPrefix.Length..])) continue;
                if (Flag(item, "draft") || Flag(item, "prerelease")) continue;
                if (!seen.Add(tag)) throw new InvalidDataException("Ambiguous Finance release catalog.");
                if (!item.TryGetProperty("assets", out var assets) || assets.ValueKind != JsonValueKind.Array)
                    throw new InvalidDataException("Missing Finance release inventory.");
                string packageName = FullName(tag[TagPrefix.Length..]);
                // Android-only publications may have the highest tag. A Windows manifest, feed,
                // or package is a Windows declaration; don't silently fall back if it's broken.
                if (!assets.EnumerateArray().Any(a => Text(a, "name") is { } name &&
                    (name.Equals(FeedName, StringComparison.OrdinalIgnoreCase) || name.Equals(packageName, StringComparison.OrdinalIgnoreCase)
                     || name.Equals("windows.json", StringComparison.OrdinalIgnoreCase)))) continue;
                int build = Version.Parse(tag[TagPrefix.Length..]).Build;
                if (build <= rank) continue;
                rank = build;
                selected = (tag, assets.Clone());
            }
            if (items.GetArrayLength() < PageSize) return selected;
        }
        throw new InvalidDataException("Finance release catalog exceeded the page limit.");
    }

    private static (string Url, long Size, string? Digest) RequiredAsset(JsonElement assets, string tag, string name)
    {
        var matches = assets.EnumerateArray().Where(a => string.Equals(Text(a, "name"), name, StringComparison.OrdinalIgnoreCase)).ToArray();
        string url = $"{DownloadRoot}{tag}/{name}";
        if (matches.Length != 1 || Text(matches[0], "name") != name || Text(matches[0], "state") != "uploaded"
            || Text(matches[0], "browser_download_url") != url || PositiveSize(matches[0], "size") is not > 0)
            throw new InvalidDataException("Missing or invalid Finance release asset: " + name);
        var asset = matches[0];
        string? digest = null;
        if (asset.TryGetProperty("digest", out var value) && value.ValueKind != JsonValueKind.Null)
        {
            digest = Text(asset, "digest");
            if (digest is null || !digest.StartsWith("sha256:", StringComparison.Ordinal) || !IsHex(digest[7..], 64))
                throw new InvalidDataException("Invalid Finance release asset digest.");
        }
        return (url, PositiveSize(asset, "size"), digest);
    }

    public async Task DownloadReleaseEntry(IVelopackLogger logger, VelopackAsset releaseEntry, string localFile,
        Action<int> progress, CancellationToken cancelToken)
    {
        string version = releaseEntry.Version.ToString();
        if (!IsFinanceVersion(version) || releaseEntry.PackageId != PackageId || releaseEntry.Type != VelopackAssetType.Full
            || releaseEntry.FileName != FullName(version) || releaseEntry.Size <= 0)
            throw new InvalidDataException("Unexpected Finance package download.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancelToken);
        timeout.CancelAfter(TimeSpan.FromMinutes(15));
        using var response = await GetAsync($"{DownloadRoot}{TagPrefix}{version}/{releaseEntry.FileName}", isCatalog: false, timeout.Token).ConfigureAwait(false);
        if (response.Content.Headers.ContentLength is { } length && length != releaseEntry.Size)
            throw new ChecksumFailedException(localFile, "Finance package download size mismatch.");
        await using var file = new FileStream(localFile, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024, useAsync: true);
        await ReadBoundedAsync(response.Content, file, releaseEntry.Size, timeout.Token,
            count => progress((int)(count * 98d / releaseEntry.Size))).ConfigureAwait(false);
    }

    private async Task<byte[]> ReadMetadataAsync(string url, int limit, bool isCatalog, CancellationToken token = default)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        using var response = await GetAsync(url, isCatalog, timeout.Token).ConfigureAwait(false);
        if (response.Content.Headers.ContentLength > limit) throw new InvalidDataException("Finance update metadata exceeds its size limit.");
        using var buffer = new MemoryStream();
        await ReadBoundedAsync(response.Content, buffer, limit, timeout.Token).ConfigureAwait(false);
        return buffer.ToArray();
    }

    private static async Task ReadBoundedAsync(HttpContent content, Stream output, long limit, CancellationToken token, Action<long>? progress = null)
    {
        await using var input = await content.ReadAsStreamAsync(token).ConfigureAwait(false);
        var buffer = new byte[64 * 1024];
        long count = 0;
        int read;
        while ((read = await input.ReadAsync(buffer.AsMemory(0, 1 + (int)Math.Min(buffer.Length - 1, limit - count)), token).ConfigureAwait(false)) != 0)
        {
            if (read > limit - count) throw new InvalidDataException("Finance update response exceeds its size limit.");
            await output.WriteAsync(buffer.AsMemory(0, read), token).ConfigureAwait(false);
            count += read;
            progress?.Invoke(count);
        }
    }

    private async Task<HttpResponseMessage> GetAsync(string url, bool isCatalog, CancellationToken token)
    {
        var uri = new Uri(url);
        for (int hop = 0; ; hop++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.UserAgent.ParseAdd("FinanceWindows-Updates/1.0");
            request.Headers.Accept.ParseAdd(isCatalog ? "application/vnd.github+json" : "application/octet-stream");
            var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token).ConfigureAwait(false);
            if (response.IsSuccessStatusCode) return response;
            using (response)
            {
                if (response.StatusCode is HttpStatusCode.MovedPermanently or HttpStatusCode.Found or HttpStatusCode.SeeOther
                    or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect)
                {
                    if (isCatalog || hop >= MaxRedirects || response.Headers.Location is not { } location
                        || !Uri.TryCreate(uri, location, out var next) || next.Scheme != Uri.UriSchemeHttps || !next.IsDefaultPort
                        || next.UserInfo.Length != 0 || next.Fragment.Length != 0
                        || next.IdnHost is not ("release-assets.githubusercontent.com" or "objects.githubusercontent.com"))
                        throw new InvalidDataException("Unexpected Finance update redirect.");
                    uri = next;
                    continue;
                }
                RecordCooldown(response);
                response.EnsureSuccessStatusCode();
            }
        }
    }

    private static JsonDocument Parse(byte[] bytes) => JsonDocument.Parse(bytes,
        new JsonDocumentOptions { MaxDepth = 16, AllowDuplicateProperties = false });
    private static string? Text(JsonElement element, string key) => element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static long PositiveSize(JsonElement element, string key) => element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out long size) && size > 0 ? size : 0;
    private static bool Flag(JsonElement element, string key) => element.TryGetProperty(key, out var value)
        && value.ValueKind is JsonValueKind.True or JsonValueKind.False ? value.GetBoolean() : throw new InvalidDataException("Invalid release status.");
    private static bool IsHex(string? text, int length) => text?.Length == length && text.All(Uri.IsHexDigit);

    internal bool IsStartupCheckDeferred => ReadCooldown() is not null;

    private long? ReadCooldown()
    {
        if (cooldownPath is null) return null;
        try
        {
            using var file = new FileStream(cooldownPath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            Span<byte> bytes = stackalloc byte[sizeof(long) + 1];
            if (file.ReadAtLeast(bytes, bytes.Length, throwOnEndOfStream: false) != sizeof(long)) return null;
            long ticks = BinaryPrimitives.ReadInt64LittleEndian(bytes);
            long now = clock.GetUtcNow().UtcTicks;
            return ticks > now && ticks <= now + MaxCooldown.Ticks ? ticks : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return null; }
    }

    private void RecordCooldown(HttpResponseMessage response)
    {
        if (cooldownPath is null || response.StatusCode is not (HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests)) return;
        var headers = response.Headers;
        var retry = headers.RetryAfter;
        bool exhausted = headers.TryGetValues("X-RateLimit-Remaining", out var remaining) && remaining.FirstOrDefault() == "0";
        if (response.StatusCode == HttpStatusCode.Forbidden && retry is null && !exhausted) return;
        var now = clock.GetUtcNow();
        var delay = retry?.Delta ?? (retry?.Date is { } date ? date - now : TimeSpan.Zero);
        if (exhausted && headers.TryGetValues("X-RateLimit-Reset", out var resets)
            && long.TryParse(resets.FirstOrDefault(), NumberStyles.None, CultureInfo.InvariantCulture, out var reset)
            && reset <= DateTimeOffset.MaxValue.ToUnixTimeSeconds())
        {
            var resetDelay = DateTimeOffset.FromUnixTimeSeconds(reset) - now;
            if (resetDelay > delay) delay = resetDelay;
        }
        if (delay <= TimeSpan.Zero) delay = TimeSpan.FromMinutes(1);
        long deadline = now.UtcTicks + Math.Min(delay.Ticks, MaxCooldown.Ticks);
        string temp = cooldownPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            if (ReadCooldown() >= deadline) return;
            Directory.CreateDirectory(Path.GetDirectoryName(cooldownPath)!);
            var bytes = new byte[sizeof(long)];
            BinaryPrimitives.WriteInt64LittleEndian(bytes, deadline);
            File.WriteAllBytes(temp, bytes);
            File.Move(temp, cooldownPath, overwrite: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            try { File.Delete(temp); }
            catch (Exception cleanup) when (cleanup is IOException or UnauthorizedAccessException) { }
        }
    }
}
