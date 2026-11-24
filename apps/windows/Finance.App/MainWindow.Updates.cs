using System.Reflection;
using EveryoneSoftware.WindowsCommon;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Finance.App;

internal sealed partial class MainWindow
{
    private readonly WindowsUpdateController updateController = new(new WindowsUpdateBackend());
    private WindowsUpdatesPanel updatesPanel = null!;
    private ContentControl signedOutUpdates = null!;
    private ContentControl? updatesHost;
    private Expander updateNotes = null!;
    private Action<WindowsUpdateStatus> updateChanged = null!;

    private void InitializeUpdates()
    {
        var installedVersion = Assembly.GetExecutingAssembly().GetName().Version!.ToString(3);
        updatesPanel = new WindowsUpdatesPanel("Finance", installedVersion);
        updateNotes = new Expander
        {
            Header = "What’s new", Content = Secondary("A changelog is not available for this update."),
            HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch
        };
        signedOutUpdates = NewUpdatesHost();
        var signInForm = (StackPanel)((Border)C<ScrollViewer>("SignInView").Content).Child;
        signInForm.Children.Add(new Expander
        {
            Header = "Updates", Content = signedOutUpdates, HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch
        });
        var dispatcher = DispatcherQueue;
        updateChanged = _ => dispatcher.TryEnqueue(RenderUpdates);
        updateController.Changed += updateChanged;
        updatesPanel.CheckRequested += CheckRequested;
        updatesPanel.DownloadRequested += DownloadRequested;
        updatesPanel.RestartRequested += RestartRequested;
        ShowSignedOutUpdates();
    }

    internal void StartUpdateCheck() => _ = updateController.CheckOnStartupAsync();

    private static ContentControl NewUpdatesHost() => new()
    {
        IsTabStop = false, HorizontalContentAlignment = HorizontalAlignment.Stretch
    };

    private void ShowSignedOutUpdates() => AttachUpdates(signedOutUpdates);

    private UIElement BuildSettingsUpdates()
    {
        var host = NewUpdatesHost();
        AttachUpdates(host);
        return Card(host);
    }

    private void AttachUpdates(ContentControl host)
    {
        DetachUpdates();
        host.Content = updatesPanel.View;
        updatesHost = host;
        RenderUpdates();
    }

    private void DetachUpdates()
    {
        if (updatesHost is null) return;
        updatesHost.Content = null;
        updatesHost = null;
    }

    private bool CanUseUpdates() => !closed && !modal && !signingIn && pageRequest is null &&
        (client is null ? ReferenceEquals(updatesHost, signedOutUpdates) : page == SettingsPage && updatesHost is not null);

    private async void CheckRequested(object? sender, EventArgs e)
    {
        if (CanUseUpdates()) await updateController.CheckAsync();
    }

    private async void DownloadRequested(object? sender, EventArgs e)
    {
        if (CanUseUpdates()) await updateController.DownloadAsync();
    }

    // Finance remembers only server URL and username; do not save or revoke the in-memory session here.
    private async void RestartRequested(object? sender, EventArgs e) => await updateController.Restart(CanUseUpdates);

    private void RenderUpdates()
    {
        if (closed || updatesHost is not { } host) return;
        var status = updateController.Status;
        var allowed = CanUseUpdates();
        host.IsEnabled = allowed;
        if (status.Version is null) updateNotes.IsExpanded = false;
        updatesPanel.Render(new(ToSharedPhase(status.Phase), status.Message, status.Version, status.Progress),
            restartAllowed: allowed, changelog: status.Version is null ? null : updateNotes);
    }

    private static UpdatePhase ToSharedPhase(WindowsUpdatePhase phase) => phase switch
    {
        WindowsUpdatePhase.Idle => UpdatePhase.Idle,
        WindowsUpdatePhase.Checking => UpdatePhase.Checking,
        WindowsUpdatePhase.Current => UpdatePhase.Current,
        WindowsUpdatePhase.Available => UpdatePhase.Available,
        WindowsUpdatePhase.Downloading => UpdatePhase.Downloading,
        WindowsUpdatePhase.Ready => UpdatePhase.Ready,
        WindowsUpdatePhase.Restarting => UpdatePhase.Restarting,
        WindowsUpdatePhase.Error => UpdatePhase.Error,
        WindowsUpdatePhase.NotInstalled => UpdatePhase.NotInstalled,
        WindowsUpdatePhase.StartupDeferred => UpdatePhase.StartupDeferred,
        _ => throw new ArgumentOutOfRangeException(nameof(phase), phase, null)
    };

    private void DisposeUpdates()
    {
        updateController.Changed -= updateChanged;
        updatesPanel.CheckRequested -= CheckRequested;
        updatesPanel.DownloadRequested -= DownloadRequested;
        updatesPanel.RestartRequested -= RestartRequested;
        DetachUpdates();
        updatesPanel.Dispose();
        updateController.Dispose();
    }
}
