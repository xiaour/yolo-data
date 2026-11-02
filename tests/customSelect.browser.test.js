import assert from 'node:assert/strict';
import test from 'node:test';
import { TEST_PASSWORD, withSkillServer } from './fixtures/skillServer.js';

test('browser: theme chart options remain clickable after scrolling the editor', {
  skip: process.env.YOLO_PERMISSION_BROWSER_TEST !== '1', timeout: 60000,
}, async () => {
  const { chromium, expect } = await import('@playwright/test');
  await withSkillServer(async ({ baseUrl, application }) => {
    const source = application.database.saveDataSource({ code: 'select_fixture', name: 'Select fixture',
      dbType: 'MYSQL', host: 'localhost', port: 3306, databaseName: 'fixture', username: 'test', options: {} });
    const dataset = application.database.saveBusinessDataset({ code: 'select_fixture', name: 'Select fixture',
      datasourceId: source.id, schemaName: 'fixture', primaryTable: 'sales', config: {} });
    const browser = await chromium.launch({ headless: true,
      ...(process.env.YOLO_BROWSER_CHANNEL ? { channel: process.env.YOLO_BROWSER_CHANNEL } : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto(`${baseUrl}/themes/new`);
      await page.locator('#loginUsername').fill('admin');
      await page.locator('#loginPassword').fill(TEST_PASSWORD);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.locator('#themeName')).toBeVisible();
      await page.locator('#themePrompt').fill('Test prompt');
      await page.locator('#themeDimensions').fill('day, region');
      await page.locator(`[name="themeBusinessDataset"][value="${dataset.id}"]`).check();
      await page.locator('.ui-select:has(#themeDefaultChart) .ui-select-trigger').click();
      // A viewport scroll already applied before the click can be delivered
      // after opening. No geometry changed, so it must not dismiss the popup.
      await page.evaluate(() => document.dispatchEvent(new Event('scroll')));
      await page.locator('button.ui-select-option[data-value="line"]').click({ timeout: 5000 });
      assert.equal(await page.locator('#themeDefaultChart').inputValue(), 'line');
      // Dataset/model menus can be longer than the visible popup.
      await page.locator('#themeDefaultChart').evaluate(select => {
        for (let i = 0; i < 30; i++) select.add(new Option(`Option ${i}`, `option-${i}`));
      });
      await page.locator('.ui-select:has(#themeDefaultChart) .ui-select-trigger').click();
      await page.locator('button.ui-select-option[data-value="option-29"]').click({ timeout: 5000 });
      assert.equal(await page.locator('#themeDefaultChart').inputValue(), 'option-29');
      const trigger = page.locator('.ui-select:has(#themeDefaultChart) .ui-select-trigger');
      await trigger.click();
      await page.locator('#themeDescription').click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await trigger.click();
      await page.evaluate(() => {
        const scroller = document.createElement('div');
        scroller.style.cssText = 'height:50px;overflow:auto';
        const content = document.createElement('div');
        content.style.height = '1000px';
        scroller.append(content);
        document.body.append(scroller);
        scroller.scrollTop = 100;
      });
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    } finally {
      await browser.close();
    }
  });
});
