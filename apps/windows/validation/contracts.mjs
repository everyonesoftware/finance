import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';

const source = path => new URL(`../Finance.App/${path}`, import.meta.url);
test('native client declares a WinUI executable and a credential-entry shell', () => {
  assert.ok(existsSync(source('Finance.App.csproj')), 'Finance must have its own native project');
  const project = readFileSync(source('Finance.App.csproj'), 'utf8');
  const shell = readFileSync(source('Shell.xaml'), 'utf8');
  assert.match(project, /<UseWinUI>true<\/UseWinUI>/);
  assert.match(project, /<OutputType>WinExe<\/OutputType>/);
  for (const field of ['ServerUrl', 'Username']) assert.match(shell, new RegExp(`<TextBox[^>]+x:Name="${field}"`));
  assert.match(shell, /<PasswordBox[^>]+x:Name="Password"/);
  assert.doesNotMatch(shell, /WebView|x:Class|x:Bind/);
});

test('Finance shell uses a themed canvas and compact native navigation', () => {
  const shell = readFileSync(source('Shell.xaml'), 'utf8');
  assert.match(shell, /x:Name="ShellCanvas"[^>]+\{ThemeResource FinanceCanvas\}/);
  assert.match(shell, /OpenPaneLength="246"/);
  for (const theme of ['Light', 'Dark', 'HighContrast']) assert.match(shell, new RegExp(`x:Key="${theme}"`));
  assert.match(shell, /x:Name="PageStatus"[^>]+Visibility="Collapsed"/);
});

test('Settings uses the published shared panel without inventing update actions', () => {
  const project = readFileSync(source('Finance.App.csproj'), 'utf8');
  const pages = readFileSync(source('MainWindow.Pages.cs'), 'utf8');
  assert.match(project, /Include="EveryoneSoftware.WindowsCommon" Version="\[0\.1\.0-alpha\.1\]"/);
  assert.match(pages, /new WindowsUpdatesPanel\("Finance", installedVersion/);
  assert.match(pages, /UpdatePhase\.NotInstalled/);
  assert.doesNotMatch(pages, /\.CheckRequested\s*\+=/);
});

test('Dashboard shares structured ledger rows with the bounded transaction list', () => {
  const shell = readFileSync(source('Shell.xaml'), 'utf8');
  const pages = readFileSync(source('MainWindow.Pages.cs'), 'utf8');
  for (const field of ['Description', 'Details', 'Amount']) assert.match(shell, new RegExp(`Text="\\{Binding ${field}\\}"`));
  assert.match(pages, /BuildNetWorthChart\(points\)/);
  assert.match(pages, /ResponsivePair\(recentCard, accountsCard/);
  assert.match(pages, /WithHeader\(header, list\)/);
  assert.doesNotMatch(pages, /Scroll\(list\)/);
});
