// Run against tests/serve.py. AP_IMPORT_FILE must contain a real imported course.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = process.env.VIEWER_TEST_URL || 'http://127.0.0.1:8766';
  const check = async (name, action) => { await action(); console.log(`PASS ${name}`); };
  try {
    await page.goto(base);
    await check('empty viewer explains how to add a course', async () => {
      await page.getByRole('button', { name: 'Add AP Classroom videos', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      assert.match(await page.getByRole('dialog').innerText(), /Add a course once/);
      const bookmark = await page.getByRole('link', { name: 'Add to AP viewer', exact: true }).getAttribute('href');
      new Function(decodeURIComponent(bookmark.slice('javascript:'.length)));
      await page.screenshot({ path: '.test-artifacts/add-videos.png' });
      await page.getByRole('button', { name: 'Close add videos' }).click();
    });
    const imported = JSON.parse(fs.readFileSync(process.env.AP_IMPORT_FILE || 'recovered-import.json', 'utf8'));
    await check('course import opens the correct unit without autoplay', async () => {
      await page.goto(`${base}/#ap-import=${encodeURIComponent(JSON.stringify(imported))}`);
      await page.waitForFunction(() => document.querySelector('#play').textContent === 'Play' && !document.querySelector('#play').disabled, { timeout: 45000 });
      assert.equal(await page.locator('#clip-count').innerText(), String(imported.clips.filter(c => String(c.unit) === (imported.unit || imported.clips[0].unit)).length));
      assert.notEqual(await page.locator('wistia-player').evaluate(p => p.state), 'playing');
      await page.screenshot({ path: '.test-artifacts/ready.png' });
    });
    await check('Play decodes and advances actual AP video, silently', async () => {
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('wistia-player').currentTime > 2);
      assert.equal(await page.locator('wistia-player').evaluate(p => p.muted), true);
      await page.screenshot({ path: '.test-artifacts/watching.png' });
    });
    await check('speed changes immediately during playback', async () => {
      await page.getByRole('spinbutton', { name: 'Playback speed' }).fill('');
      await page.getByRole('spinbutton', { name: 'Playback speed' }).pressSequentially('2.25');
      await page.waitForFunction(() => document.querySelector('wistia-player').playbackRate === 2.25);
      assert.equal(await page.locator('wistia-player').evaluate(p => p.state), 'playing');
    });
    await check('start cutoff moves playback forward without reloading', async () => {
      await page.locator('wistia-player').evaluate(p => p.dataset.testIdentity = 'same-player');
      await page.getByRole('textbox', { name: 'Start cutoff', exact: true }).fill('0:30');
      await page.getByRole('textbox', { name: 'Start cutoff', exact: true }).press('Tab');
      await page.waitForFunction(() => document.querySelector('wistia-player').currentTime >= 30);
      assert.equal(await page.locator('wistia-player').getAttribute('data-test-identity'), 'same-player');
      assert.equal(await page.locator('wistia-player').evaluate(p => p.state), 'playing');
    });
    await check('end cutoff advances to the next video automatically', async () => {
      await page.getByRole('textbox', { name: 'End cutoff', exact: true }).fill('0:36');
      await page.getByRole('textbox', { name: 'End cutoff', exact: true }).press('Tab');
      await page.waitForFunction(id => document.querySelector('wistia-player').getAttribute('media-id') === id, imported.clips[1].id);
      await page.waitForFunction(() => document.querySelector('wistia-player').currentTime > 1 && document.querySelector('wistia-player').state === 'playing');
      assert.equal(await page.locator('wistia-player').evaluate(p => p.playbackRate), 2.25);
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
    });
    await check('selected lesson survives a reload without autoplay', async () => {
      await page.reload();
      await page.waitForFunction(() => !document.querySelector('#play').disabled);
      assert.equal(await page.locator('wistia-player').getAttribute('media-id'), imported.clips[1].id);
      assert.notEqual(await page.locator('wistia-player').evaluate(p => p.state), 'playing');
    });
    await check('cutoffs and speed survive a reload', async () => {
      await page.locator('.clip-play').first().click();
      await page.waitForFunction(() => !document.querySelector('#play').disabled);
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: 'Start cutoff', exact: true }).inputValue(), '0:30');
      assert.equal(await page.getByRole('textbox', { name: 'End cutoff', exact: true }).inputValue(), '0:36');
      assert.equal(await page.getByRole('spinbutton', { name: 'Playback speed' }).inputValue(), '2.25');
    });
    await check('a saved starting cutoff plays on the first click after reopening', async () => {
      await page.reload();
      await page.waitForFunction(() => !document.querySelector('#play').disabled);
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('wistia-player').currentTime > 30.5 && document.querySelector('wistia-player').state === 'playing');
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
    });
    await check('invalid end time is rejected without losing saved cutoffs', async () => {
      await page.getByRole('textbox', { name: 'End cutoff', exact: true }).fill('0:10');
      await page.getByRole('textbox', { name: 'End cutoff', exact: true }).press('Tab');
      assert.match(await page.locator('#player-feedback').innerText(), /Start must come before end/);
      assert.equal(await page.getByRole('textbox', { name: 'End cutoff', exact: true }).inputValue(), '0:36');
    });
    await check('sliders update and save cutoffs', async () => {
      await page.getByRole('button', { name: 'Reset cutoffs' }).click();
      await page.getByRole('slider', { name: 'Start cutoff slider' }).focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.getByRole('textbox', { name: 'Start cutoff', exact: true }).inputValue(), '0:00.1');
      await page.getByRole('slider', { name: 'End cutoff slider' }).focus();
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(() => document.querySelector('#save-feedback').textContent === 'Saved');
      assert.notEqual(await page.getByRole('textbox', { name: 'End cutoff', exact: true }).inputValue(), '');
      await page.screenshot({ path: '.test-artifacts/cutoffs.png' });
    });
    await check('narrow layout keeps controls usable', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: '.test-artifacts/mobile.png', fullPage: true });
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const units = [...new Set(imported.clips.map(c => String(c.unit)))];
    if (units.length > 1) await check('unit picker loads the selected unit and retains each video cutoff', async () => {
      await page.getByRole('combobox', { name: 'Unit', exact: true }).selectOption({ label: `Unit ${units[1]}` });
      const secondClips = imported.clips.filter(c => String(c.unit) === units[1]);
      await page.waitForFunction(id => document.querySelector('wistia-player').getAttribute('media-id') === id && !document.querySelector('#play').disabled, secondClips[0].id);
      assert.equal(await page.locator('#clip-count').innerText(), String(secondClips.length));
      assert.equal(await page.locator('#current-title').innerText(), secondClips[0].name);
      assert.notEqual(await page.locator('wistia-player').evaluate(p => p.state), 'playing');
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('wistia-player').currentTime > 1);
      await page.screenshot({ path: '.test-artifacts/unit-2-watching.png' });
      await page.getByRole('combobox', { name: 'Unit', exact: true }).selectOption({ label: `Unit ${units[0]}` });
      await page.waitForFunction(id => document.querySelector('wistia-player').getAttribute('media-id') === id && !document.querySelector('#play').disabled, imported.clips[0].id);
      assert.equal(await page.getByRole('textbox', { name: 'Start cutoff', exact: true }).inputValue(), '0:00.1');
    });
    await check('Use current buttons set cutoffs at the playhead', async () => {
      await page.getByRole('button', { name: 'Reset cutoffs' }).click();
      await page.getByRole('slider', { name: 'Video position', exact: true }).focus();
      await page.keyboard.press('Home');
      for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
      await page.getByTitle('Start at the current video position').click();
      assert.equal(await page.getByRole('textbox', { name: 'Start cutoff', exact: true }).inputValue(), '0:02');
      await page.getByRole('slider', { name: 'Video position', exact: true }).focus();
      for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
      await page.getByTitle('End at the current video position').click();
      assert.equal(await page.getByRole('textbox', { name: 'End cutoff', exact: true }).inputValue(), '0:04');
    });
    await check('the final video stops at its end cutoff and replays from its start', async () => {
      await page.locator('.clip-play').last().click();
      await page.waitForFunction(() => document.querySelector('#play').textContent === 'Pause');
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.getByRole('textbox', { name: 'Start cutoff', exact: true }).fill('1');
      await page.getByRole('textbox', { name: 'Start cutoff', exact: true }).press('Tab');
      await page.getByRole('textbox', { name: 'End cutoff', exact: true }).fill('3');
      await page.getByRole('textbox', { name: 'End cutoff', exact: true }).press('Tab');
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.getByRole('button', { name: 'Replay', exact: true }).waitFor();
      const end = await page.locator('wistia-player').evaluate(p => p.currentTime);
      assert.ok(end >= 2.9 && end <= 3.3, `Stopped at ${end}`);
      await page.getByRole('button', { name: 'Replay', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('wistia-player').state === 'playing' && document.querySelector('wistia-player').currentTime < 3);
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
    });
    assert.deepEqual(errors, []);
    console.log('PASS no uncaught browser errors');
  } catch (error) {
    await page.screenshot({ path: '.test-artifacts/failure.png', fullPage: true });
    console.error(await page.locator('body').innerText());
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
