using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Finance.Core;

public sealed class FinanceApiException(HttpStatusCode status, string message) : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
}

public sealed class FinanceClient : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly HttpClient http;
    public Uri Origin { get; }

    public FinanceClient(Uri origin)
    {
        Origin = ParseOrigin(origin.AbsoluteUri);
        http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, CookieContainer = new CookieContainer() })
        { BaseAddress = Origin, Timeout = TimeSpan.FromSeconds(35), MaxResponseContentBufferSize = 64 * 1024 * 1024 };
    }

    public static Uri ParseOrigin(string input)
    {
        if (!Uri.TryCreate(input.Trim(), UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && (uri.Scheme != Uri.UriSchemeHttp || !uri.IsLoopback)) ||
            uri.Host.Length == 0 || uri.UserInfo.Length != 0 || uri.AbsolutePath != "/" ||
            uri.Query.Length != 0 || uri.Fragment.Length != 0 || input.Contains('\\'))
            throw new ArgumentException("Enter a Finance server origin, such as https://finance.example.com, with no path or query. HTTP is only allowed on loopback.");
        return new Uri(uri.GetLeftPart(UriPartial.Authority));
    }

    public async Task SignInAsync(string username, string password, CancellationToken ct)
    {
        using var login = await SendAsync("api/auth/sign-in/username", HttpMethod.Post, new { username, password }, ct);
        using var session = await SendAsync("api/auth/get-session", HttpMethod.Get, null, ct);
        var body = await session.Content.ReadFromJsonAsync<JsonElement>(Json, ct);
        if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty("user", out var user) ||
            user.ValueKind != JsonValueKind.Object || !user.TryGetProperty("id", out var id) ||
            id.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(id.GetString()))
            throw new FinanceApiException(HttpStatusCode.Unauthorized, "Finance did not establish a session.");
    }

    public async Task SignOutAsync(CancellationToken ct)
    {
        using var response = await SendAsync("api/auth/sign-out", HttpMethod.Post, new { }, ct);
    }

    public async Task<Account[]> AccountsAsync(CancellationToken ct) =>
        Required((await Get<AccountsResponse>("api/accounts", ct)).Accounts);
    public Task<Overview> OverviewAsync(CancellationToken ct) => Get<Overview>("api/accounts/net-worth", ct);
    public Task<Ledger> TransactionsAsync(bool recent, CancellationToken ct) =>
        Get<Ledger>(recent ? "api/accounts/transactions" : "api/accounts/transactions/all", ct);
    public async Task<AccountDetail> AccountAsync(string id, CancellationToken ct)
    {
        var result = await Get<AccountDetail>($"api/accounts/{Segment(id)}/transactions", ct);
        if (result.Account?.Id != id) throw new JsonException("Account identity did not match the request.");
        return result;
    }
    public async Task<InvestmentSnapshot[]> InvestmentsAsync(string id, CancellationToken ct) =>
        Required((await Get<InvestmentResponse>($"api/accounts/{Segment(id)}/investments", ct)).Snapshots);
    public async Task<Property[]> PropertiesAsync(CancellationToken ct) =>
        Required((await Get<PropertiesResponse>("api/real-estate", ct)).Properties);
    public Task<ImportPreview> PreviewAsync(string id, ImportFile file, CancellationToken ct) =>
        Read<ImportPreview>($"api/accounts/{Segment(id)}/import/preview", HttpMethod.Post, file, ct);
    public Task<ImportResult> CommitAsync(string id, ImportFile file, ImportPreview preview, CancellationToken ct)
    {
        if (preview.Errors is not { Length: 0 } || preview.Importable <= 0 || string.IsNullOrWhiteSpace(preview.PreviewToken))
            throw new ArgumentException("Run a valid import preview before saving.");
        return Read<ImportResult>($"api/accounts/{Segment(id)}/import", HttpMethod.Post,
            new { file.FileName, file.Content, file.Csv, preview.PreviewToken }, ct);
    }

    private static string Segment(string value) => !string.IsNullOrWhiteSpace(value) && value is not "." and not ".."
        ? Uri.EscapeDataString(value) : throw new ArgumentException("Invalid account ID.");
    private static T Required<T>(T? value) where T : class => value ?? throw new JsonException("Missing Finance data.");
    private Task<T> Get<T>(string path, CancellationToken ct) where T : class => Read<T>(path, HttpMethod.Get, null, ct);
    private async Task<T> Read<T>(string path, HttpMethod method, object? body, CancellationToken ct) where T : class
    {
        using var response = await SendAsync(path, method, body, ct);
        return Required(await response.Content.ReadFromJsonAsync<T>(Json, ct));
    }

    private async Task<HttpResponseMessage> SendAsync(string path, HttpMethod method, object? body, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.CacheControl = new CacheControlHeaderValue { NoStore = true };
        if (body is not null)
        {
            request.Headers.Add("Origin", Origin.GetLeftPart(UriPartial.Authority));
            request.Content = JsonContent.Create(body, options: Json);
        }
        var response = await http.SendAsync(request, ct);
        if (response.IsSuccessStatusCode) return response;
        var status = response.StatusCode;
        response.Dispose();
        // Never display raw proxy/authorization responses, which can echo request data.
        var message = status switch
        {
            HttpStatusCode.Unauthorized => "Finance rejected the sign-in or your session expired.",
            HttpStatusCode.Forbidden => "The Finance server denied the request. Check the configured server origin.",
            HttpStatusCode.NotFound => "The Finance resource was not found.",
            HttpStatusCode.Conflict => "The Finance data changed. Refresh or run the import preview again.",
            HttpStatusCode.RequestEntityTooLarge => "The Finance server rejected a request that was too large.",
            _ when (int)status is >= 300 and < 400 => "The server redirected the request. Enter the final Finance origin directly.",
            _ => $"Finance could not complete the request (HTTP {(int)status})."
        };
        throw new FinanceApiException(status, message);
    }

    public void Dispose() => http.Dispose();
}

public sealed record Account(string Id, string Name, string InstitutionName, string? Type, string? Subtype, string? Mask,
    decimal? CurrentBalance, string? CurrencyCode, string? Source, bool CanImport, string? ProviderAccountId, BalanceReference? BalanceReference)
{
    public bool CanImportTransactions => Source == "manual" && CanImport;
}
public sealed record BalanceReference(decimal Amount, string Date, bool Verified);
public sealed record AccountDetail([property: JsonRequired] Account Account, [property: JsonRequired] Transaction[] Transactions);
public sealed record Ledger([property: JsonRequired] Transaction[] Transactions, [property: JsonRequired] Account[] Accounts);
public sealed record Transaction(string? Date, string? Name, decimal? Amount, bool? Pending,
    [property: JsonPropertyName("iso_currency_code")] string? CurrencyCode,
    [property: JsonPropertyName("unofficial_currency_code")] string? UnofficialCurrencyCode,
    [property: JsonPropertyName("account_id")] string? AccountId);
public sealed record Overview([property: JsonRequired] decimal? Total, [property: JsonRequired] int AccountCount,
    int ExcludedAccountCount, int UnknownBalanceCount, [property: JsonRequired] NetWorthPoint[] Points);
public sealed record NetWorthPoint(string Date, decimal Total, string? Source);
public sealed record Property(string Id, string Address, [property: JsonRequired] Estimate[] Estimates);
public sealed record Estimate(decimal Amount, long CreatedAt, string? Provider, string? SourceNotes);
public sealed record InvestmentSnapshot(string ValuationDate, string Source, decimal AccountValue, decimal CashBalance,
    [property: JsonRequired] Holding[] Holdings);
public sealed record Holding(string Symbol, string Name, decimal MarketValue, bool IsCash);
public sealed record CsvOptions(string DateFormat, string AmountConvention);
public sealed record ImportFile(string FileName, string Content, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] CsvOptions? Csv);
public sealed record ImportPreview([property: JsonRequired] string[] Errors, string[]? Notes,
    [property: JsonRequired] Transaction[] Transactions, int Total, int Duplicates,
    [property: JsonRequired] int Importable, bool PreviewTruncated, string? PreviewToken, BalanceImpact? BalanceImpact);
public sealed record BalanceImpact(decimal? StartingBalance, decimal? BalanceAfterImport, int HistoricalCount,
    int AppliedCount, string? Reason);
public sealed record ImportResult([property: JsonRequired] int Imported, [property: JsonRequired] int Skipped);
internal sealed record AccountsResponse(Account[] Accounts);
internal sealed record PropertiesResponse(Property[] Properties);
internal sealed record InvestmentResponse(InvestmentSnapshot[] Snapshots);
