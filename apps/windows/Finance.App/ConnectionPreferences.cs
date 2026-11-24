using System.Text.Json;
using Finance.Core;

namespace Finance.App;

internal sealed record ConnectionPreferences(string Server, string Username)
{
    private static string Location => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "EveryoneSoftware", "Finance", "connection.json");

    public static ConnectionPreferences? Load()
    {
        try
        {
            using var stream = File.OpenRead(Location);
            if (stream.Length > 16 * 1024) return null;
            var preferences = JsonSerializer.Deserialize<ConnectionPreferences>(stream);
            if (preferences?.Server is not { Length: > 0 and <= 2048 } || preferences.Username is not { Length: > 0 and <= 30 }) return null;
            return preferences with { Server = FinanceClient.ParseOrigin(preferences.Server).AbsoluteUri };
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        {
            return null;
        }
    }

    public void Save()
    {
        try
        {
            var destination = Location;
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            var staging = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(staging, JsonSerializer.Serialize(this));
                File.Move(staging, destination, overwrite: true);
            }
            finally { File.Delete(staging); }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // A failed preference write does not invalidate a server session.
        }
    }
}
