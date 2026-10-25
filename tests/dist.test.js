import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const distDirectory = new URL("../dist/", import.meta.url);

test("production HTML references existing JavaScript and CSS assets", async () => {
  const html = await readFile(new URL("index.html", distDirectory), "utf8");
  const scriptPath = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  const stylesheetPath = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];

  assert.match(html, /<title>Finance/);
  assert.ok(scriptPath, "production HTML should reference a JavaScript asset");
  assert.ok(stylesheetPath, "production HTML should reference a CSS asset");

  await access(new URL(`.${scriptPath}`, distDirectory));
  await access(new URL(`.${stylesheetPath}`, distDirectory));
});
