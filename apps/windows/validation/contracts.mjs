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
