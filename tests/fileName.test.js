import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildArtifactFileName,
  buildArtifactTitle,
  buildSessionFileName,
} from '../src/fileName.js';

test('session filename is summarized from the first core question', () => {
  assert.equal(
    buildSessionFileName('请查询本月重点客户组业务的销售额，按照每周分组'),
    '本月重点客户组业务的销售额_按照每周分组',
  );
  assert.equal(
    buildSessionFileName('查询/统计: 本月销售额?'),
    '本月销售额',
  );
});

test('artifact title is a concise question summary', () => {
  assert.equal(
    buildArtifactTitle('本月重点客户组的业绩是多少'),
    '本月重点客户组的业绩',
  );
  assert.equal(
    buildArtifactTitle(
      '提供给我2026年8月分行业Standard销售额及同比，并整理成EXCEL表给到我',
    ),
    '2026年8月分行业Standard销售额及同比',
  );
  assert.equal(
    buildArtifactTitle('分析2026年8月标准配送销售趋势并输出Excel'),
    '2026年8月标准配送销售趋势',
  );
});

test('artifact filename uses the concise result title', () => {
  assert.equal(
    buildArtifactFileName({
      workspaceName: '本月重点客户组业务销售额',
      artifactTitle: '本月重点客户组的业绩',
      extension: 'csv',
    }),
    '本月重点客户组的业绩.csv',
  );
});
