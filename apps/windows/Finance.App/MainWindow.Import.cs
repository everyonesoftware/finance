using System.Net;
using System.Text;
using Finance.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Windows.Storage.Pickers;

namespace Finance.App;

internal sealed partial class MainWindow
{
    private const int MaxImportBytes = 4 * 1024 * 1024;

    private async Task ImportAsync(FinanceClient api, Account account, Button launcher)
    {
        bool OwnsImport() => !closed && ReferenceEquals(api, client) && page == DetailPage && accountId == account.Id;
        if (modal || !OwnsImport() || !account.CanImportTransactions) return;
        SetModal(true);
        var submitting = false;
        var reload = false;
        try
        {
            var ct = lifetime.Token;
            var picker = new FileOpenPicker(AppWindow.Id) { CommitButtonText = "Choose export" };
            foreach (var extension in new[] { ".csv", ".ofx", ".qfx" }) picker.FileTypeFilter.Add(extension);
            var picked = await picker.PickSingleFileAsync();
            if (picked is null || !OwnsImport()) return;
            var name = Path.GetFileName(picked.Path);
            var extensionLower = Path.GetExtension(name).ToLowerInvariant();
            if (name.Length > 255 || extensionLower is not (".csv" or ".ofx" or ".qfx"))
            {
                Status("Choose a CSV, OFX, or QFX file with a valid name.");
                return;
            }
            Status("Reading selected file…");
            var text = await ReadImportFileAsync(picked.Path, ct);
            if (!OwnsImport()) return;
            if (string.IsNullOrWhiteSpace(text)) { Status("The selected file is empty."); return; }
            CsvOptions? csv = null;
            if (extensionLower == ".csv")
            {
                csv = await ChooseCsvOptionsAsync(name, account.Name);
                if (csv is null || !OwnsImport()) { if (OwnsImport()) Status(""); return; }
            }
            var file = new ImportFile(name, text, csv);
            Status("Checking the export on the Finance server…");
            var preview = await api.PreviewAsync(account.Id, file, ct);
            if (!OwnsImport()) return;
            Status("");
            if (await ShowImportPreviewAsync(account, file.FileName, preview) != ContentDialogResult.Primary || !OwnsImport()) return;
            submitting = true;
            Status("Importing confirmed transactions…");
            var result = await api.CommitAsync(account.Id, file, preview, ct);
            if (!OwnsImport()) return;
            reload = true;
            await LoadPageAsync($"Imported {result.Imported:N0}; skipped {result.Skipped:N0} duplicate transactions.");
        }
        catch (Exception error) when (Expected(error) || error is UnauthorizedAccessException or System.Runtime.InteropServices.COMException)
        {
            if (!OwnsImport()) return;
            if (error is FinanceApiException { Status: HttpStatusCode.Unauthorized }) ClearSession(Friendly(error));
            else if (error is ImportFileException fileError) Status(fileError.Message);
            else if (submitting && (error is not FinanceApiException apiError || (int)apiError.Status >= 500))
                Status("Finance did not confirm the import. Refresh the account and run a new preview before trying again.");
            else Status(Friendly(error));
        }
        finally
        {
            if (!closed)
            {
                SetModal(false);
                if (OwnsImport())
                {
                    if (reload) C<Button>("Refresh").Focus(FocusState.Programmatic);
                    else launcher.Focus(FocusState.Programmatic);
                }
            }
        }
    }

    private static async Task<string> ReadImportFileAsync(string path, CancellationToken ct)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 8192, FileOptions.Asynchronous | FileOptions.SequentialScan);
        if (stream.Length > MaxImportBytes) throw new ImportFileException("Transaction exports can be up to 4 MB.");
        var bytes = new byte[MaxImportBytes + 1];
        var length = await stream.ReadAtLeastAsync(bytes, bytes.Length, throwOnEndOfStream: false, cancellationToken: ct);
        if (length > MaxImportBytes) throw new ImportFileException("Transaction exports can be up to 4 MB.");
        try { return new UTF8Encoding(false, true).GetString(bytes, 0, length).TrimStart('\uFEFF'); }
        catch (DecoderFallbackException) { throw new ImportFileException("Save this export as UTF-8 before importing."); }
    }

    private async Task<CsvOptions?> ChooseCsvOptionsAsync(string file, string account)
    {
        var panel = Panel();
        panel.Children.Add(Text($"{file} → {account}"));
        panel.Children.Add(Text("Finance detects standard date, description and amount columns. For custom column mapping use the web client."));
        var dates = new ComboBox { Header = "Dates in the CSV", ItemsSource = new[] { "Year / month / day", "Month / day / year", "Day / month / year" }, SelectedIndex = 0 };
        var signs = new ComboBox { Header = "Signed amounts in the CSV", ItemsSource = new[] { "Positive = money in", "Positive = money out" }, SelectedIndex = 0 };
        panel.Children.Add(dates);
        panel.Children.Add(signs);
        panel.Children.Add(Text("For Fidelity history exports, choose month/day/year and positive = money in."));
        var dialog = new ContentDialog { XamlRoot = root.XamlRoot, Title = "CSV format", Content = panel,
            PrimaryButtonText = "Preview", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Close };
        return await dialog.ShowAsync() == ContentDialogResult.Primary
            ? new CsvOptions(dates.SelectedIndex switch { 1 => "mdy", 2 => "dmy", _ => "ymd" }, signs.SelectedIndex == 1 ? "outflow-positive" : "inflow-positive") : null;
    }

    private async Task<ContentDialogResult> ShowImportPreviewAsync(Account account, string fileName, ImportPreview preview)
    {
        var canImport = preview.Errors.Length == 0 && preview.Importable > 0 && !string.IsNullOrWhiteSpace(preview.PreviewToken);
        var panel = Panel();
        panel.Children.Add(Text($"{fileName} → {account.InstitutionName} · {account.Name}"));
        panel.Children.Add(Text($"{preview.Total:N0} transactions · {preview.Importable:N0} new · {preview.Duplicates:N0} duplicates"));
        foreach (var error in preview.Errors.Take(20)) panel.Children.Add(Text(error));
        foreach (var note in preview.Notes ?? []) panel.Children.Add(Text(note));
        if (preview.BalanceImpact is { } impact)
        {
            panel.Children.Add(Text($"Balance before: {Money(impact.StartingBalance, account.CurrencyCode)}\nBalance after: {Money(impact.BalanceAfterImport, account.CurrencyCode)}"));
            panel.Children.Add(Text($"{impact.HistoricalCount:N0} new transactions through the reference date; {impact.AppliedCount:N0} later transactions affect the balance."));
            if (!string.IsNullOrWhiteSpace(impact.Reason)) panel.Children.Add(Text(impact.Reason));
        }
        if (!canImport) panel.Children.Add(Text("Nothing can be saved from this preview."));
        if (preview.PreviewTruncated) panel.Children.Add(Text("Showing the first 50 transactions only."));
        var names = new Dictionary<string, string>();
        foreach (var tx in preview.Transactions.Take(50)) panel.Children.Add(Text(TransactionLine(tx, names)));
        var scroll = Scroll(panel);
        scroll.MaxHeight = 330;
        var dialog = new ContentDialog { XamlRoot = root.XamlRoot, Title = "Review transaction import", Content = scroll,
            CloseButtonText = canImport ? "Cancel" : "Close", DefaultButton = ContentDialogButton.Close };
        if (canImport) dialog.PrimaryButtonText = $"Import {preview.Importable:N0}";
        return await dialog.ShowAsync();
    }

    private sealed class ImportFileException(string message) : IOException(message);
}
