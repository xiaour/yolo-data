import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApplication } from '../src/application.js';

function testConfig() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-feedback-'));
  return {
    projectRoot: process.cwd(),
    port: 0,
    dbPath: path.join(directory, 'test.db'),
    supersonic: { baseUrl: '', token: '', timeoutMs: 5_000 },
    allowDemoIndicatorSource: true,
    deepseek: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      timeoutMs: 5_000,
      maxToolRounds: 3,
    },
    chatMemoryMessageLimit: 20,
  };
}

test('negative feedback feeds prompt hints and knowledge gaps', async () => {
  const application = await createApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  const result = application.feedback.submit({
    userId: user.id,
    themeId: theme.id,
    question: '近7天销售额趋势',
    correct: false,
    comment: '应使用签约销售额口径',
    corrected: { indicatorId: 'signed_sales_amount' },
  });

  assert.equal(result.correct, false);
  assert.ok(application.feedback.promptHints(theme.id).some(
    (hint) => hint.includes('签约销售额'),
  ));
  assert.ok(application.growth.list().some(
    (gap) => gap.kind === 'FEEDBACK' && gap.term === '近7天销售额趋势',
  ));
});
