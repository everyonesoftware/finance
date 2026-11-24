using System.Reflection;
using EveryoneSoftware.WindowsCommon;
using Finance.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Finance.App;

internal sealed partial class MainWindow
{
    private async Task<UIElement> BuildOverviewAsync(FinanceClient api, CancellationToken ct)
    {
        var summaryTask = api.OverviewAsync(ct);
        var ledgerTask = api.TransactionsAsync(true, ct);
        await Task.WhenAll(summaryTask, ledgerTask);
        var summary = await summaryTask;
        var ledger = await ledgerTask;
        var panel = Section(18);
        var balance = Section();
        balance.Children.Add(Heading("Net worth"));
        balance.Children.Add(Value(summary.Total is null && summary.AccountCount == 0 ? "No accounts yet" : DisplayMoney(summary.Total, "USD"), 38));
        balance.Children.Add(Secondary("Tracked USD accounts minus liabilities · Property excluded"));
        if (summary.ExcludedAccountCount > 0) balance.Children.Add(Secondary($"{summary.ExcludedAccountCount} non-USD or unknown-currency accounts excluded."));
        if (summary.UnknownBalanceCount > 0) balance.Children.Add(Secondary($"{summary.UnknownBalanceCount} USD accounts have an unknown balance."));
        var points = summary.Points.OrderBy(point => point.Date, StringComparer.Ordinal).ToArray();
        var history = Section();
        history.Children.Add(Heading("Net-worth history"));
        history.Children.Add(BuildNetWorthChart(points));
        if (points.Length > 0)
        {
            var records = new ListView
            {
                ItemsSource = points.Reverse().Select(point => $"{point.Date} · {DisplayMoney(point.Total, "USD")} · {(point.Source == "reconstructed" ? "Reconstructed estimate" : "Saved observation")}").ToArray(),
                MaxHeight = 220, SelectionMode = ListViewSelectionMode.None,
                ItemTemplate = (DataTemplate)root.Resources["HistoryRow"]
            };
            history.Children.Add(new Expander { Header = $"{points.Length:N0} days recorded", Content = records,
                HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch });
        }
        panel.Children.Add(Card(ResponsivePair(balance, history, 540, 0.9, 1.3)));

        var recent = Section();
        recent.Children.Add(Pair(Heading("Recent transactions"), Action("See all", () => NavigateAsync(TransactionsPage), "See all transactions")));
        var accounts = AccountNames(ledger.Accounts);
        if (ledger.Transactions.Length == 0) recent.Children.Add(Secondary("No transactions yet."));
        else recent.Children.Add(new ItemsControl { ItemsSource = ledger.Transactions.Select(tx => LedgerEntryFor(tx, accounts)).ToArray(),
            ItemTemplate = LedgerTemplate });
        var bankAccounts = Section();
        bankAccounts.Children.Add(Pair(Heading("Bank accounts"), Action("See all", () => NavigateAsync(AccountsPage), "See all accounts")));
        bankAccounts.Children.Add(Secondary($"{summary.AccountCount:N0} tracked accounts"));
        foreach (var account in ledger.Accounts.Take(5)) bankAccounts.Children.Add(AccountButton(account));
        var recentCard = Card(recent);
        var accountsCard = Card(bankAccounts);
        panel.Children.Add(ResponsivePair(recentCard, accountsCard, 720, 1.4, 1));
        return Scroll(panel);
    }

    private UIElement BuildAccounts(Account[] accounts)
    {
        var panel = Section(16);
        if (accounts.Length == 0) panel.Children.Add(Card(Secondary("No accounts yet. Add or manage accounts in Finance on the web.")));
        foreach (var group in accounts.GroupBy(account => account.InstitutionName).OrderBy(group => group.Key, StringComparer.CurrentCultureIgnoreCase))
        {
            var institution = Section();
            institution.Children.Add(Heading(group.Key));
            foreach (var account in group.OrderBy(account => account.Name, StringComparer.CurrentCultureIgnoreCase))
                institution.Children.Add(AccountButton(account));
            panel.Children.Add(Card(institution));
        }
        return Scroll(panel);
    }

    private async Task<UIElement> BuildAccountAsync(FinanceClient api, string id, CancellationToken ct)
    {
        var detail = await api.AccountAsync(id, ct);
        var account = detail.Account;
        var head = Section();
        head.Children.Add(Action("Back to accounts", () => NavigateAsync(AccountsPage)));
        head.Children.Add(Heading(account.Name));
        head.Children.Add(Text($"{account.InstitutionName} · {account.Subtype ?? account.Type}"));
        head.Children.Add(Text($"{(account.Type is "credit" or "loan" ? "Amount owed" : "Current balance")} · {Money(account.CurrentBalance, account.CurrencyCode)}", 20));
        if (account.BalanceReference is { } reference)
            head.Children.Add(Text($"Balance reference · {reference.Date} · {Money(reference.Amount, account.CurrencyCode)}{(reference.Verified ? "" : " · Unverified")}"));
        if (account.CanImportTransactions)
        {
            var import = new Button { Content = "Import transactions" };
            import.Click += async (_, _) => await ImportAsync(api, account, import);
            head.Children.Add(import);
        }
        else head.Children.Add(Text("Saved account · Read-only"));
        if (account.Type == "investment")
        {
            var snapshots = await api.InvestmentsAsync(account.Id, ct);
            var holdings = Panel();
            if (snapshots.MaxBy(snapshot => snapshot.ValuationDate, StringComparer.Ordinal) is { } latest)
            {
                holdings.Children.Add(Text($"{latest.ValuationDate} · {latest.Source} · Account value {Money(latest.AccountValue, account.CurrencyCode)}"));
                holdings.Children.Add(Text($"Separate cash · {Money(latest.CashBalance, account.CurrencyCode)}"));
                foreach (var holding in latest.Holdings.Take(100))
                    holdings.Children.Add(Text($"{holding.Symbol} {holding.Name} · {Money(holding.MarketValue, account.CurrencyCode)}{(holding.IsCash ? " · Cash" : "")}"));
                if (latest.Holdings.Length > 100) holdings.Children.Add(Text("Showing the first 100 holdings. Open Finance on the web for the full list."));
            }
            else holdings.Children.Add(Text("No holdings snapshot yet."));
            var holdingsScroll = Scroll(holdings);
            holdingsScroll.MaxHeight = 240;
            head.Children.Add(new Expander { Header = "Latest holdings snapshot", Content = holdingsScroll });
        }
        var view = BuildTransactions(new Ledger(detail.Transactions, [account]));
        return WithHeader(Card(head), view, scrollHeader: true);
    }

    private Grid BuildTransactions(Ledger ledger)
    {
        var search = new TextBox { Header = "Search transactions", PlaceholderText = "Description, date, or account" };
        var header = Section();
        header.Children.Add(search);
        var count = Secondary("");
        header.Children.Add(count);
        var names = AccountNames(ledger.Accounts);
        var rows = ledger.Transactions.OrderByDescending(tx => tx.Date, StringComparer.Ordinal)
            .Select(tx => LedgerEntryFor(tx, names)).ToArray();
        var transactions = new ListView
        {
            SelectionMode = ListViewSelectionMode.None, ItemTemplate = LedgerTemplate,
            ItemContainerStyle = (Style)root.Resources["LedgerContainer"], Padding = new Thickness(0, 0, 12, 0)
        };
        var list = Card(transactions);
        void Filter()
        {
            var query = search.Text.Trim();
            var matches = query.Length == 0 ? rows : rows.Where(row => row.SearchText.Contains(query, StringComparison.CurrentCultureIgnoreCase)).ToArray();
            transactions.ItemsSource = matches;
            count.Text = matches.Length == 0 ? rows.Length == 0 ? "No transactions yet." : "No transactions match your search."
                : $"{matches.Length:N0} transactions";
        }
        search.TextChanged += (_, _) => Filter();
        Filter();
        return WithHeader(header, list);
    }

    private UIElement BuildProperties(Property[] properties)
    {
        var panel = Section(16);
        if (properties.Length == 0) panel.Children.Add(Card(Secondary("No properties yet. Add or manage properties in Finance on the web.")));
        foreach (var property in properties)
        {
            var card = Section();
            card.Children.Add(Heading(property.Address));
            var details = Section();
            var estimates = property.Estimates.OrderByDescending(estimate => estimate.CreatedAt).ToArray();
            if (estimates.Length == 0) card.Children.Add(Secondary("No estimates supplied."));
            else card.Children.Add(Value(DisplayMoney(estimates[0].Amount, "USD"), 24));
            foreach (var estimate in estimates)
            {
                var provider = estimate.Provider switch { "zillow" => "Zillow", "redfin" => "Redfin", _ => "Manual" };
                var date = estimate.CreatedAt is >= -62135596800000 and <= 253402300799999 ?
                    DateTimeOffset.FromUnixTimeMilliseconds(estimate.CreatedAt).ToString("yyyy-MM-dd") : "Date unavailable";
                details.Children.Add(Text($"{Money(estimate.Amount, "USD")} · {provider} · {date}"));
                if (!string.IsNullOrWhiteSpace(estimate.SourceNotes)) details.Children.Add(Text(estimate.SourceNotes));
            }
            if (estimates.Length > 0) card.Children.Add(new Expander { Header = $"Estimate history · {estimates.Length:N0}", Content = details, HorizontalAlignment = HorizontalAlignment.Stretch });
            panel.Children.Add(Card(card));
        }
        return Scroll(panel);
    }

    private UIElement BuildSettings(FinanceClient api)
    {
        var panel = Section(16);
        var connection = Section();
        connection.Children.Add(Heading("Connection"));
        connection.Children.Add(Value(api.Origin.GetLeftPart(UriPartial.Authority), 16));
        connection.Children.Add(Secondary("Only the server URL and username are remembered. Your password and session are not saved on this PC."));
        var actions = Section();
        var signOut = new Button { Content = "Sign out" };
        signOut.Click += async (_, _) => await SignOutAsync(api, signOut);
        actions.Children.Add(signOut);
        actions.Children.Add(Action("Disconnect locally", async () =>
        {
            if (modal || closed || !ReferenceEquals(client, api)) return;
            SetModal(true);
            try
            {
                var dialog = new ContentDialog { Title = "Disconnect locally?", XamlRoot = root.XamlRoot,
                    Content = Text("This clears the session from this window but does not revoke it on the Finance server."),
                    PrimaryButtonText = "Disconnect", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Close };
                if (await dialog.ShowAsync() == ContentDialogResult.Primary && !closed && ReferenceEquals(client, api))
                    ClearSession("Disconnected locally. The server session was not revoked.");
            }
            finally { if (!closed) SetModal(false); }
        }));
        connection.Children.Add(actions);
        panel.Children.Add(Card(connection));
        var installedVersion = Assembly.GetExecutingAssembly().GetName().Version!.ToString(3);
        // This client has no update backend; the shared panel presents one static, non-interactive snapshot.
        using var updates = new WindowsUpdatesPanel("Finance", installedVersion);
        updates.Render(new(UpdatePhase.NotInstalled, "This version of Finance is not configured to check for updates."), restartAllowed: false);
        panel.Children.Add(Card(updates.View));
        return Scroll(panel);
    }

    private DataTemplate LedgerTemplate => (DataTemplate)root.Resources["LedgerRow"];

    private static Grid WithHeader(FrameworkElement header, FrameworkElement body, bool scrollHeader = false)
    {
        var grid = new Grid { RowSpacing = 10 };
        grid.RowDefinitions.Add(new RowDefinition { Height = scrollHeader ? new GridLength(1, GridUnitType.Star) : GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(scrollHeader ? 2 : 1, GridUnitType.Star) });
        grid.Children.Add(scrollHeader ? Scroll(header) : header);
        Grid.SetRow(body, 1);
        grid.Children.Add(body);
        return grid;
    }

    private static Dictionary<string, string> AccountNames(Account[] accounts) => accounts
        .Where(account => !string.IsNullOrWhiteSpace(account.ProviderAccountId))
        .GroupBy(account => account.ProviderAccountId!, StringComparer.Ordinal)
        .Where(group => group.Count() == 1)
        .ToDictionary(group => group.Key, group => group.First().Name, StringComparer.Ordinal);

    private static string TransactionLine(Transaction tx, Dictionary<string, string> names)
    {
        var row = LedgerEntryFor(tx, names);
        return $"{row.Description}   {row.Amount}\n{row.Details}";
    }

    private static LedgerEntry LedgerEntryFor(Transaction tx, Dictionary<string, string> names)
    {
        // Server storage is outflow-positive. Show cash-flow signs, as on the web.
        var currency = tx.CurrencyCode ?? tx.UnofficialCurrencyCode;
        var sign = tx.Amount > 0 ? "−" : tx.Amount < 0 ? "+" : "";
        var magnitude = tx.Amount is { } value ? decimal.Abs(value) : (decimal?)null;
        var amount = magnitude is null ? "Amount unavailable" : sign + DisplayMoney(magnitude, currency);
        var searchAmount = magnitude is null ? amount : sign + Money(magnitude, currency);
        var account = tx.AccountId is { } id && names.TryGetValue(id, out var name) ? $" · {name}" : "";
        var details = $"{tx.Date ?? "Date unavailable"}{account}{(tx.Pending == true ? " · Pending" : "")}";
        return new(tx.Name ?? "Unnamed transaction", details, amount, searchAmount);
    }
}

// Public for classic {Binding} on the embedded runtime XAML template.
public sealed record LedgerEntry(string Description, string Details, string Amount, string SearchAmount)
{
    internal string SearchText => $"{Description}   {SearchAmount}\n{Details}\n{Amount}";
}
