import test from 'node:test';
import assert from 'node:assert/strict';

test('Twelve Data Settings renders a private password field with honest read-only setup copy', async () => {
  let module;
  try { module=await import('../src/twelve-data-settings.ts'); } catch {}
  assert.equal(typeof module?.renderTwelveDataSettings,'function','Twelve Data Settings panel exists');
  const html=module.renderTwelveDataSettings();
  assert.match(html,/Twelve Data/);
  assert.match(html,/id="twelve-data-key"[^>]*type="password"/);
  assert.match(html,/autocomplete="off"/);
  assert.match(html,/encrypted/i);
  assert.match(html,/not.*verif|without.*verif|does not.*verif/i);
  assert.match(html,/id="twelve-data-save"[^>]*disabled/);
  assert.match(html,/id="twelve-data-remove"[^>]*hidden/);
  assert.doesNotMatch(html,/value="[^"\s]+"/);
});
