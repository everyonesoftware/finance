using System.Globalization;
using System.Net;
using System.Text.Json;
using Finance.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.System;

namespace Finance.App;

internal sealed partial class MainWindow : Window
{
    private const string OverviewPage = "Overview", AccountsPage = "Accounts", TransactionsPage = "Transactions",
        PropertyPage = "Real Estate", SettingsPage = "Settings", DetailPage = "Account details";
    private readonly Grid root;
    private readonly NavigationView navigation;
    private readonly ContentControl content;
    private readonly CancellationTokenSource lifetime = new();
    private CancellationTokenSource? pageRequest;
    private FinanceClient? client;
    private string page = OverviewPage;
    private string? accountId;
    private bool signingIn, modal, closed;

    internal MainWindow()
    {
        using var stream = typeof(MainWindow).Assembly.GetManifestResourceStream("Finance.App.Shell.xaml")
            ?? throw new InvalidOperationException("The Finance shell resource is missing.");
        using var reader = new StreamReader(stream);
        root = (Grid)XamlReader.Load(reader.ReadToEnd());
        if (ConnectionPreferences.Load() is { } preferences)
        {
            C<TextBox>("ServerUrl").Text = preferences.Server;
            C<TextBox>("Username").Text = preferences.Username;
        }
        navigation = C<NavigationView>("Navigation");
        content = C<ContentControl>("PageContent");
        Content = root;
        Title = "Finance";
        C<Image>("BrandIcon").Source = new BitmapImage(new Uri(Path.Combine(AppContext.BaseDirectory, "Assets", "Finance.png")));
        var titleBar = C<Border>("TitleBar");
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(titleBar);
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1200, 800));
        void ApplyInsets()
        {
            if (root.XamlRoot is not { RasterizationScale: > 0 } xamlRoot) return;
            var caption = AppWindow.TitleBar;
            titleBar.Padding = new Thickness(14 + caption.LeftInset / xamlRoot.RasterizationScale, 0,
                14 + caption.RightInset / xamlRoot.RasterizationScale, 0);
        }
        root.Loaded += (_, _) =>
        {
            ApplyInsets();
            root.XamlRoot.Changed += (_, _) => ApplyInsets();
            C<TextBox>("ServerUrl").Focus(FocusState.Programmatic);
        };
        root.SizeChanged += (_, _) => ApplyInsets();
        void ApplyCaptionTheme()
        {
            if (closed || titleBar.Background is not SolidColorBrush surface ||
                C<TextBlock>("BrandName").Foreground is not SolidColorBrush ink) return;
            var caption = AppWindow.TitleBar;
            caption.ButtonBackgroundColor = caption.ButtonInactiveBackgroundColor = surface.Color;
            caption.ButtonForegroundColor = caption.ButtonInactiveForegroundColor = ink.Color;
        }
        root.Loaded += (_, _) => ApplyCaptionTheme();
        root.ActualThemeChanged += (_, _) => DispatcherQueue.TryEnqueue(ApplyCaptionTheme);
        Closed += (_, _) =>
        {
            closed = true;
            lifetime.Cancel();
            client?.Dispose();
            lifetime.Dispose();
        };

        C<Button>("SignIn").Click += async (_, _) => await SignInAsync();
        C<PasswordBox>("Password").KeyDown += async (_, args) =>
        {
            if (args.Key != VirtualKey.Enter) return;
            args.Handled = true;
            await SignInAsync();
        };
        C<Button>("Refresh").Click += async (_, _) => { if (!modal) await LoadPageAsync(); };
        navigation.ItemInvoked += async (_, args) =>
        {
            if (modal || client is null) return;
            if (args.IsSettingsInvoked) await NavigateAsync(SettingsPage);
            else if (args.InvokedItemContainer?.Tag is string target) await NavigateAsync(target);
        };
    }

    private T C<T>(string name) where T : class => (T)root.FindName(name);

    private async Task SignInAsync()
    {
        if (signingIn || closed || client is not null) return;
        var server = C<TextBox>("ServerUrl");
        var username = C<TextBox>("Username");
        var password = C<PasswordBox>("Password");
        var submit = C<Button>("SignIn");
        var status = C<TextBlock>("SignInStatus");
        if (string.IsNullOrWhiteSpace(username.Text) || password.Password.Length == 0)
        {
            status.Text = "Enter your Finance username and password.";
            return;
        }
        FinanceClient? candidate = null;
        signingIn = true;
        submit.IsEnabled = server.IsEnabled = username.IsEnabled = password.IsEnabled = false;
        status.Text = "Signing in…";
        try
        {
            candidate = new FinanceClient(FinanceClient.ParseOrigin(server.Text));
            var signIn = candidate.SignInAsync(username.Text.Trim(), password.Password, lifetime.Token);
            password.Password = string.Empty;
            await signIn;
            if (closed) return;
            new ConnectionPreferences(candidate.Origin.AbsoluteUri, username.Text.Trim()).Save();
            client = candidate;
            candidate = null;
            status.Text = string.Empty;
            C<ScrollViewer>("SignInView").Visibility = Visibility.Collapsed;
            navigation.Visibility = Visibility.Visible;
            await NavigateAsync(OverviewPage);
            if (!closed && client is not null) C<Button>("Refresh").Focus(FocusState.Programmatic);
        }
        catch (Exception error) when (Expected(error)) { if (!closed) status.Text = Friendly(error); }
        finally
        {
            candidate?.Dispose();
            signingIn = false;
            if (!closed) submit.IsEnabled = server.IsEnabled = username.IsEnabled = password.IsEnabled = true;
        }
    }

    private void ClearSession(string message)
    {
        var previous = client;
        client = null;
        pageRequest?.Cancel();
        previous?.Dispose();
        content.Content = null;
        C<TextBlock>("PageTitle").Text = string.Empty;
        Status(string.Empty);
        navigation.Visibility = Visibility.Collapsed;
        C<ScrollViewer>("SignInView").Visibility = Visibility.Visible;
        C<TextBlock>("SignInStatus").Text = message;
        C<PasswordBox>("Password").Focus(FocusState.Programmatic);
        page = OverviewPage;
        accountId = null;
    }

    private async Task NavigateAsync(string target, string? id = null)
    {
        if (closed || modal || client is null) return;
        page = target;
        accountId = id;
        if (target == SettingsPage) navigation.SelectedItem = navigation.SettingsItem;
        else navigation.SelectedItem = navigation.MenuItems.OfType<NavigationViewItem>()
            .First(item => Equals(item.Tag, target == DetailPage ? AccountsPage : target));
        await LoadPageAsync();
    }

    private async Task LoadPageAsync(string success = "")
    {
        if (closed || client is not { } api) return;
        pageRequest?.Cancel();
        using var request = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        pageRequest = request;
        var target = page;
        var id = accountId;
        var refresh = C<Button>("Refresh");
        refresh.IsEnabled = false;
        C<TextBlock>("PageTitle").Text = target;
        content.Content = null;
        Status(target == SettingsPage ? "" : "Loading…");
        var token = request.Token;
        try
        {
            var view = target switch
            {
                OverviewPage => await BuildOverviewAsync(api, token),
                AccountsPage => BuildAccounts(await api.AccountsAsync(token)),
                TransactionsPage => BuildTransactions((await api.TransactionsAsync(false, token))),
                DetailPage => await BuildAccountAsync(api, id!, token),
                PropertyPage => BuildProperties(await api.PropertiesAsync(token)),
                SettingsPage => BuildSettings(api),
                _ => throw new InvalidOperationException("Unknown Finance page.")
            };
            if (OwnsPage(request, api))
            {
                content.Content = view;
                Status(success);
            }
        }
        catch (Exception error) when (Expected(error))
        {
            if (OwnsPage(request, api))
            {
                if (error is FinanceApiException { Status: HttpStatusCode.Unauthorized }) ClearSession(Friendly(error));
                else
                {
                    Status(success.Length > 0 ? $"{success} {Friendly(error)} Select Refresh to reload." : $"{Friendly(error)} Select Refresh to retry.");
                    if (target == DetailPage)
                    {
                        var retryView = Panel();
                        retryView.Children.Add(Action("Back to accounts", () => NavigateAsync(AccountsPage)));
                        content.Content = retryView;
                    }
                }
            }
        }
        finally
        {
            if (ReferenceEquals(pageRequest, request))
            {
                pageRequest = null;
                if (!closed) refresh.IsEnabled = !modal;
            }
        }
    }

    private bool OwnsPage(CancellationTokenSource request, FinanceClient api) =>
        !closed && ReferenceEquals(pageRequest, request) && ReferenceEquals(client, api) && !request.IsCancellationRequested;
    private void Status(string message)
    {
        var status = C<TextBlock>("PageStatus");
        status.Visibility = message.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        status.Text = message;
    }

    private async Task SignOutAsync(FinanceClient api, Button button)
    {
        if (closed || modal || !ReferenceEquals(client, api)) return;
        SetModal(true);
        button.IsEnabled = false;
        Status("Signing out…");
        try
        {
            await api.SignOutAsync(lifetime.Token);
            if (!closed && ReferenceEquals(client, api)) ClearSession("Signed out.");
        }
        catch (Exception error) when (Expected(error))
        {
            if (!closed && ReferenceEquals(client, api))
            {
                if (error is FinanceApiException { Status: HttpStatusCode.Unauthorized }) ClearSession("Session expired.");
                else Status($"Sign-out was not confirmed. {Friendly(error)} You can retry or disconnect locally.");
            }
        }
        finally
        {
            if (!closed) { button.IsEnabled = true; SetModal(false); }
        }
    }

    private void SetModal(bool active)
    {
        modal = active;
        content.IsEnabled = !active;
        foreach (var item in navigation.MenuItems.OfType<NavigationViewItem>()) item.IsEnabled = !active;
        if (navigation.SettingsItem is NavigationViewItem settings) settings.IsEnabled = !active;
        C<Button>("Refresh").IsEnabled = !active && pageRequest is null;
    }

    private static bool Expected(Exception error) => error is FinanceApiException or HttpRequestException or
        OperationCanceledException or JsonException or ArgumentException or IOException or ObjectDisposedException;

    private static string Friendly(Exception error) => error switch
    {
        FinanceApiException api => api.Message,
        HttpRequestException => "Could not reach Finance. Check the server URL and your connection.",
        OperationCanceledException => "The request did not finish.",
        JsonException => "Finance returned an unexpected response.",
        _ => "Could not complete the request. Check your input and try again."
    };

    private static string Money(decimal? amount, string? currency) => amount is not { } value ? "Unavailable" :
        $"{value.ToString("N2", CultureInfo.CurrentCulture)} {currency ?? "(currency unknown)"}";
    private static StackPanel Panel() => new() { Spacing = 10, Padding = new Thickness(0, 0, 12, 12) };
    private static TextBlock Text(string text, double size = 15) => new() { Text = text, FontSize = size, TextWrapping = TextWrapping.Wrap };
    private static TextBlock Heading(string label)
    {
        var text = Text(label, 20);
        text.FontWeight = Microsoft.UI.Text.FontWeights.SemiBold;
        AutomationProperties.SetHeadingLevel(text, AutomationHeadingLevel.Level2);
        return text;
    }
    private static ScrollViewer Scroll(UIElement element) => new()
    {
        Content = element, HorizontalScrollMode = ScrollMode.Disabled, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled
    };
    private static Button Action(string label, Func<Task> invoke, string? automationName = null)
    {
        var button = new Button { Content = label, CornerRadius = new CornerRadius(8) };
        if (automationName is not null) AutomationProperties.SetName(button, automationName);
        button.Click += async (_, _) => await invoke();
        return button;
    }
}
