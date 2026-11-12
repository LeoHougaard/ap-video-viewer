// Owns only its isolated test server and project. Reuses actual AP media silently.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  fs.mkdirSync('.test-artifacts', { recursive: true });
  const state = fs.mkdtempSync(path.resolve('.test-artifacts/restart-'));
  const port = process.env.VIEWER_TEST_PORT || '8770';
  const base = `http://127.0.0.1:${port}`;
  const fixture = JSON.parse(fs.readFileSync(process.env.AP_IMPORT_FILE || 'recovered-import.json', 'utf8'));
  let server, browser;
  const start = async () => {
    server = spawn(process.env.PYTHON || 'python', ['tests/serve.py', state, port], { windowsHide: true });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.once('exit', code => reject(new Error(`Test server exited: ${code}`)));
      server.stdout.on('data', chunk => { if (String(chunk).includes('ready')) resolve(); });
      server.stderr.on('data', chunk => process.stderr.write(chunk));
    });
  };
  const stop = async () => { if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; } };
  try {
    await start();
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--mute-audio'] });
    const context = await browser.newContext();
    let page = await context.newPage();
    await page.goto(`${base}/#ap-import=${encodeURIComponent(JSON.stringify(fixture))}`);
    await page.waitForFunction(() => !document.querySelector('#play').disabled);
    await page.locator('.clip-play').nth(1).click();
    await page.waitForFunction(() => document.querySelector('wistia-player').state === 'playing');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.locator('#trim').fill('10'); await page.locator('#trim').press('Tab');
    await page.locator('#end').fill('60'); await page.locator('#end').press('Tab');
    await page.locator('#speed').fill('2.25');
    await page.waitForFunction(() => document.querySelector('#save-feedback').textContent === 'Saved');
    await page.locator('wistia-player').evaluate(p => { p.currentTime = 20; });
    await page.waitForFunction(() => Math.abs(document.querySelector('wistia-player').currentTime - 20) < .2);
    const id = await page.locator('wistia-player').getAttribute('media-id');
    await page.close();
    await stop(); await start();
    page = await context.newPage(); await page.goto(base);
    await page.waitForFunction(() => !document.querySelector('#play').disabled);
    assert.equal(await page.locator('wistia-player').getAttribute('media-id'), id);
    await page.waitForFunction(() => Math.abs(document.querySelector('wistia-player').currentTime - 20) < .2);
    assert.notEqual(await page.locator('wistia-player').evaluate(p => p.state), 'playing');
    assert.equal(await page.locator('wistia-player').evaluate(p => p.muted), true);
    assert.equal(await page.locator('#trim').inputValue(), '0:10');
    assert.equal(await page.locator('#end').inputValue(), '1:00');
    assert.equal(await page.locator('#speed').inputValue(), '2.25');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('wistia-player').currentTime > 21);
    console.log('PASS server restart and new page restore lesson, position, cutoffs and speed; explicit Play resumes silently');
  } finally { if (browser) await browser.close(); await stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
