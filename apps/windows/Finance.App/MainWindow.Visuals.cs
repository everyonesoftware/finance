using System.Globalization;
using Finance.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace Finance.App;

internal sealed partial class MainWindow
{
    private static StackPanel Section(double spacing = 10) => new() { Spacing = spacing };
    private Border Card(UIElement content) => new() { Style = (Style)root.Resources["FinanceCard"], Child = content };
    private TextBlock Secondary(string text, double size = 13) => new()
    {
        Text = text, FontSize = size, TextWrapping = TextWrapping.Wrap,
        Style = (Style)root.Resources["FinanceSecondaryText"]
    };

    private TextBlock Value(string text, double size)
    {
        var label = Text(text, size);
        label.Style = (Style)root.Resources["FinanceText"];
        label.FontWeight = Microsoft.UI.Text.FontWeights.SemiBold;
        return label;
    }

    private static string DisplayMoney(decimal? amount, string? currency)
    {
        if (amount is not { } value || !string.Equals(currency, "USD", StringComparison.OrdinalIgnoreCase))
            return Money(amount, currency);
        var magnitude = decimal.Abs(value).ToString("N2", CultureInfo.CurrentCulture);
        return $"{(value < 0 ? "−" : "")}${magnitude}";
    }

    private Button AccountButton(Account account)
    {
        var details = Section(3);
        details.Children.Add(Value(account.Name, 14));
        var kind = account.Source == "manual" ? "Manual account" : "Saved · Read-only";
        var mask = string.IsNullOrWhiteSpace(account.Mask) ? "" : $"••••{account.Mask} · ";
        details.Children.Add(Secondary($"{mask}{kind}", 12));
        var amount = DisplayMoney(account.CurrentBalance, account.CurrencyCode);
        var button = Action(account.Name, () => NavigateAsync(DetailPage, account.Id), $"{account.Name}, {mask}{kind}, {amount}");
        var balance = Value(amount, 14);
        balance.MaxWidth = 132;
        balance.TextAlignment = TextAlignment.Right;
        button.Content = Pair(details, balance);
        button.HorizontalAlignment = HorizontalAlignment.Stretch;
        button.HorizontalContentAlignment = HorizontalAlignment.Stretch;
        button.Padding = new Thickness(10, 8, 10, 8);
        return button;
    }

    private static Grid Pair(FrameworkElement left, FrameworkElement right)
    {
        var grid = new Grid { ColumnSpacing = 12 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        left.VerticalAlignment = right.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(right, 1);
        grid.Children.Add(left);
        grid.Children.Add(right);
        return grid;
    }

    // Decide from available content width, not from monitor pixels or the window width including its rail.
    private static Grid ResponsivePair(FrameworkElement left, FrameworkElement right, double breakpoint, double leftWeight, double rightWeight)
    {
        var grid = new Grid { ColumnSpacing = 18, RowSpacing = 16 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(0) });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.Children.Add(left);
        grid.Children.Add(right);
        bool? wasWide = null;
        void Arrange(double width)
        {
            var wide = width >= breakpoint;
            if (wide == wasWide) return;
            wasWide = wide;
            grid.ColumnSpacing = wide ? 18 : 0;
            grid.RowSpacing = wide ? 0 : 16;
            grid.ColumnDefinitions[0].Width = new GridLength(wide ? leftWeight : 1, GridUnitType.Star);
            grid.ColumnDefinitions[1].Width = wide ? new GridLength(rightWeight, GridUnitType.Star) : new GridLength(0);
            Grid.SetColumn(right, wide ? 1 : 0);
            Grid.SetRow(right, wide ? 0 : 1);
        }
        Arrange(0);
        grid.SizeChanged += (_, args) => Arrange(args.NewSize.Width);
        return grid;
    }

    private UIElement BuildNetWorthChart(NetWorthPoint[] points)
    {
        var series = new SortedDictionary<DateOnly, NetWorthPoint>();
        foreach (var point in points)
            if (DateOnly.TryParseExact(point.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
                series[date] = point;
        if (series.Count < 2)
            return Secondary(series.Count == 0 ? "No saved net-worth history yet." : "Not enough history to chart yet. Open the recorded days to see the saved value.");

        var first = series.First();
        var last = series.Last();
        var low = series.Values.Min(p => (double)p.Total);
        var high = series.Values.Max(p => (double)p.Total);
        var padding = Math.Max(1d, Math.Max((high - low) * .15, Math.Abs(high) * .02));
        var min = low - padding;
        var max = high + padding;
        var height = 104d;
        var canvas = new Canvas { Height = height, IsHitTestVisible = false };
        AutomationProperties.SetAccessibilityView(canvas, AccessibilityView.Raw);
        var gridStyle = (Style)root.Resources["FinanceChartGrid"];
        var guideLines = Enumerable.Range(0, 3).Select(i => new Line { Style = gridStyle, Y1 = 1 + i * 51, Y2 = 1 + i * 51 }).ToArray();
        foreach (var guide in guideLines) canvas.Children.Add(guide);
        var stroke = new Polyline { Style = (Style)root.Resources["FinanceChartLine"] };
        canvas.Children.Add(stroke);
        var daySpan = last.Key.DayNumber - first.Key.DayNumber;
        canvas.SizeChanged += (_, args) =>
        {
            var plotWidth = Math.Max(0, args.NewSize.Width - 4);
            foreach (var guide in guideLines) guide.X2 = args.NewSize.Width;
            var geometry = new PointCollection();
            foreach (var (day, point) in series)
                geometry.Add(new Windows.Foundation.Point(2 + (day.DayNumber - first.Key.DayNumber) * plotWidth / daySpan,
                    2 + (max - (double)point.Total) / (max - min) * (height - 4)));
            stroke.Points = geometry;
        };

        var plot = Section(5);
        var estimated = series.Values.Any(point => point.Source == "reconstructed");
        plot.Children.Add(Secondary(estimated ? "Includes reconstructed estimates, not verified balances." : "Saved observations · Lines connect dates with records."));
        plot.Children.Add(canvas);
        plot.Children.Add(Secondary($"{first.Key:MMM d, yyyy} – {last.Key:MMM d, yyyy}", 12));
        return plot;
    }
}
