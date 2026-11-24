using Finance.Core;

static void Check(bool condition, string reason)
{
    if (!condition) throw new Exception(reason);
}

foreach (var invalid in new[] { "http://example.com", "http://127.example.com", "https://u:p@example.com", "https://example.com/path", "https://example.com?x=1", "https://example.com/#fragment" })
{
    try { _ = FinanceClient.ParseOrigin(invalid); throw new Exception("Accepted an invalid server URL"); }
    catch (ArgumentException) { }
}
Check(FinanceClient.ParseOrigin("https://example.com:8443/").Authority == "example.com:8443", "port preserved");
Check(FinanceClient.ParseOrigin("http://[::1]:8080/").IsLoopback, "loopback accepted");
if (args.Length == 0) return;
var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(25)).Token;
using var client = new FinanceClient(FinanceClient.ParseOrigin(args[0]));
using var other = new FinanceClient(FinanceClient.ParseOrigin(args[0]));
var password = Environment.GetEnvironmentVariable("FINANCE_FIXTURE_PASSWORD")!;
await client.SignInAsync("nativeowner", password, cancellation);
await other.SignInAsync("nativeother", password, cancellation);
var accounts = await client.AccountsAsync(cancellation);
var account = accounts.Single();
Check(account.Name == "Imported checking" && account.CurrentBalance == 174.39m, "seeded account");
Check((await other.AccountsAsync(cancellation)).Length == 0, "isolated cookies");
Check((await client.OverviewAsync(cancellation)).Total == 174.39m, "overview");
Check((await client.PropertiesAsync(cancellation)).Single().Estimates.Single().Amount == 250000m, "real estate estimates");
Check((await client.AccountAsync(account.Id, cancellation)).Transactions.Length == 0, "empty ledger before preview");
var import = new ImportFile("checking.csv", "Date,Description,Amount\n2024-01-02,Sample merchant,-7.25\n", new("ymd", "inflow-positive"));
var preview = await client.PreviewAsync(account.Id, import, cancellation);
Check(preview.Errors.Length == 0 && preview.Importable == 1 && preview.Transactions[0].Amount == 7.25m, "preview and outflow sign");
Check((await client.AccountAsync(account.Id, cancellation)).Transactions.Length == 0, "preview is nonmutating");
try { await client.CommitAsync(account.Id, import, preview with { PreviewToken = "stale" }, cancellation); throw new Exception("Accepted stale preview"); }
catch (FinanceApiException error) when (error.Status == System.Net.HttpStatusCode.Conflict) { }
Check((await client.CommitAsync(account.Id, import, preview, cancellation)).Imported == 1, "confirmed import");
Check((await client.AccountAsync(account.Id, cancellation)).Transactions.Single().Name == "Sample merchant", "account ledger readback");
Check((await client.TransactionsAsync(false, cancellation)).Transactions.Single().Amount == 7.25m, "global ledger readback");
Check((await client.PreviewAsync(account.Id, import, cancellation)).Importable == 0, "duplicate preview");
await client.SignOutAsync(cancellation);
try { await client.AccountsAsync(cancellation); throw new Exception("Signed-out client read data"); }
catch (FinanceApiException error) when (error.Status == System.Net.HttpStatusCode.Unauthorized) { }
Console.WriteLine("Windows Finance HTTP integration passed: auth, isolation, overview, properties, import, readback, sign-out.");
