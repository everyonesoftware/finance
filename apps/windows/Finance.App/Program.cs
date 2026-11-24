using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.XamlTypeInfo;
using Velopack;

namespace Finance.App;

internal static class Program
{
    [STAThread]
    public static void Main()
    {
        // Handle installer lifecycle arguments before opening WinUI or Finance preferences.
        VelopackApp.Build().SetAutoApplyOnStartup(false).Run();
        WinRT.ComWrappersSupport.InitializeComWrappers();
        Application.Start(callback =>
        {
            SynchronizationContext.SetSynchronizationContext(new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread()));
            _ = new FinanceApplication();
        });
    }
}

public sealed partial class FinanceApplication : Application, IXamlMetadataProvider
{
    private readonly XamlControlsXamlMetaDataProvider metadata = new();
    private MainWindow? window;
    public IXamlType GetXamlType(Type type) => metadata.GetXamlType(type);
    public IXamlType GetXamlType(string fullName) => metadata.GetXamlType(fullName);
    public XmlnsDefinition[] GetXmlnsDefinitions() => metadata.GetXmlnsDefinitions();

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        Resources.MergedDictionaries.Add(new XamlControlsResources());
        window = new MainWindow();
        window.Activate();
    }
}
