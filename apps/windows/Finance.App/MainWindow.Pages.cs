using System.Reflection;
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
        var panel = Panel();
        panel.Children.Add(Heading("Net worth"));
        panel.Children.Add(Text(summary.Total is null && summary.AccountCount == 0 ? "No accounts yet" : Money(summary.Total, "USD"), 36));
        panel.Children.Add(Text("Tracked USD accounts minus liabilities · Property excluded"));
        if (summary.ExcludedAccountCount > 0) panel.Children.Add(Text($"{summary.ExcludedAccountCount} non-USD or unknown-currency accounts excluded."));
        if (summary.UnknownBalanceCount > 0) panel.Children.Add(Text($"{summary.UnknownBalanceCount} USD accounts have an unknown balance."));
        var points = summary.Points.OrderByDescending(point => point.Date, StringComparer.Ordinal).ToArray();
        if (points.Length == 0) panel.Children.Add(Text("No saved net-worth history yet."));
        else
        {
            var history = Panel();
            history.Children.Add(Text("Reconstructed points are estimates, not verified balances."));
            history.Children.Add(Scroll(ListFor(points.Select(point =>
                $"{point.Date}   {Money(point.Total, "USD")}{(point.Source == "reconstructed" ? " · Reconstructed estimate" : " · Saved observation")}"))));
            ((ScrollViewer)history.Children.Last()).MaxHeight = 250;
            panel.Children.Add(new Expander { Header = $"Net-worth history · {points.Length} days recorded", Content = history, HorizontalAlignment = HorizontalAlignment.Stretch });
        }
        panel.Children.Add(Heading("Recent transactions"));
        var accounts = AccountNames(ledger.Accounts);
        foreach (var tx in ledger.Transactions) panel.Children.Add(Text(TransactionLine(tx, accounts)));
        if (ledger.Transactions.Length == 0) panel.Children.Add(Text("No transactions yet."));
        panel.Children.Add(Action("See all transactions", () => NavigateAsync(TransactionsPage)));
        panel.Children.Add(Action($"Bank accounts · {summary.AccountCount}", () => NavigateAsync(AccountsPage)));
        return Scroll(panel);
    }

    private UIElement BuildAccounts(Account[] accounts)
    {
        var panel = Panel();
        if (accounts.Length == 0) panel.Children.Add(Text("No accounts yet. Add or manage accounts in Finance on the web."));
        foreach (var group in accounts.GroupBy(account => account.InstitutionName).OrderBy(group => group.Key, StringComparer.CurrentCultureIgnoreCase))
        {
            panel.Children.Add(Heading(group.Key));
            foreach (var account in group.OrderBy(account => account.Name, StringComparer.CurrentCultureIgnoreCase))
            {
                var label = $"{account.Name}{(string.IsNullOrWhiteSpace(account.Mask) ? "" : $" · ••••{account.Mask}")}\n" +
                    $"{Money(account.CurrentBalance, account.CurrencyCode)} · {(account.Source == "manual" ? "Manual account" : "Saved · Read-only")}";
                var button = Action(label, () => NavigateAsync(DetailPage, account.Id));
                button.Content = Text(label);
                button.HorizontalAlignment = HorizontalAlignment.Stretch;
                button.HorizontalContentAlignment = HorizontalAlignment.Left;
                panel.Children.Add(button);
            }
        }
        return Scroll(panel);
    }

    private async Task<UIElement> BuildAccountAsync(FinanceClient api, string id, CancellationToken ct)
    {
        var detail = await api.AccountAsync(id, ct);
        var account = detail.Account;
        var head = Panel();
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
        return WithHeader(head, view, scrollHeader: true);
    }

    private Grid BuildTransactions(Ledger ledger)
    {
        var search = new TextBox { Header = "Search transactions", PlaceholderText = "Description, date, or account" };
        var header = Panel();
        header.Children.Add(search);
        var count = Text("");
        header.Children.Add(count);
        var names = AccountNames(ledger.Accounts);
        var rows = ledger.Transactions.OrderByDescending(tx => tx.Date, StringComparer.Ordinal)
            .Select(tx => TransactionLine(tx, names)).ToArray();
        var list = ListFor(rows);
        void Filter()
        {
            var query = search.Text.Trim();
            var matches = query.Length == 0 ? rows : rows.Where(row => row.Contains(query, StringComparison.CurrentCultureIgnoreCase)).ToArray();
            list.ItemsSource = matches;
            count.Text = matches.Length == 0 ? rows.Length == 0 ? "No transactions yet." : "No transactions match your search."
                : $"{matches.Length:N0} transactions";
        }
        search.TextChanged += (_, _) => Filter();
        Filter();
        return WithHeader(header, list);
    }

    private static UIElement BuildProperties(Property[] properties)
    {
        var panel = Panel();
        if (properties.Length == 0) panel.Children.Add(Text("No properties yet. Add or manage properties in Finance on the web."));
        foreach (var property in properties)
        {
            var details = Panel();
            if (property.Estimates.Length == 0) details.Children.Add(Text("No estimates supplied."));
            foreach (var estimate in property.Estimates.OrderByDescending(estimate => estimate.CreatedAt))
            {
                var provider = estimate.Provider switch { "zillow" => "Zillow", "redfin" => "Redfin", _ => "Manual" };
                var date = estimate.CreatedAt is >= -62135596800000 and <= 253402300799999 ?
                    DateTimeOffset.FromUnixTimeMilliseconds(estimate.CreatedAt).ToString("yyyy-MM-dd") : "Date unavailable";
                details.Children.Add(Text($"{Money(estimate.Amount, "USD")} · {provider} · {date}"));
                if (!string.IsNullOrWhiteSpace(estimate.SourceNotes)) details.Children.Add(Text(estimate.SourceNotes));
            }
            panel.Children.Add(new Expander { Header = Text(property.Address), Content = details, HorizontalAlignment = HorizontalAlignment.Stretch });
        }
        return Scroll(panel);
    }

    private UIElement BuildSettings(FinanceClient api)
    {
        var panel = Panel();
        panel.Children.Add(Heading("Connection"));
        panel.Children.Add(Text(api.Origin.GetLeftPart(UriPartial.Authority)));
        panel.Children.Add(Text("Only the server URL and username are remembered. Your password and session are not saved on this PC."));
        var signOut = new Button { Content = "Sign out" };
        signOut.Click += async (_, _) => await SignOutAsync(api, signOut);
        panel.Children.Add(signOut);
        panel.Children.Add(Action("Disconnect locally", async () =>
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
        panel.Children.Add(Heading($"Current Version: {Assembly.GetExecutingAssembly().GetName().Version!.ToString(3)}"));
        panel.Children.Add(Text("Update checking is unavailable because there is no published Finance for Windows update feed."));
        return Scroll(panel);
    }

    private ListView ListFor(IEnumerable<string> items) => new()
    {
        ItemsSource = items.ToArray(), SelectionMode = ListViewSelectionMode.None,
        ItemTemplate = (DataTemplate)root.Resources["LedgerRow"], Padding = new Thickness(0, 0, 12, 0)
    };

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
        // Server storage is outflow-positive. Show cash-flow signs, as on the web.
        var amount = tx.Amount is { } value ? $"{(value > 0 ? "−" : value < 0 ? "+" : "")}{Money(decimal.Abs(value), tx.CurrencyCode ?? tx.UnofficialCurrencyCode)}" : "Amount unavailable";
        var account = tx.AccountId is { } id && names.TryGetValue(id, out var name) ? $" · {name}" : "";
        return $"{tx.Name ?? "Unnamed transaction"}   {amount}\n{tx.Date ?? "Date unavailable"}{account}{(tx.Pending == true ? " · Pending" : "")}";
    }
}
