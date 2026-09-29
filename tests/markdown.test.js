import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSafeMarkdown } from '../public/markdown.js';

test('markdown renderer formats headings, lists, emphasis and tables safely', () => {
  const html = renderSafeMarkdown(`
### 结论
销售额**环比增长** 12%，主要来自线上渠道。

- 华东贡献最高
- 华南增速最快

| 区域 | 销售额 |
| --- | ---: |
| 华东 | 1200 |
| 华南 | 860 |
`);

  assert.match(html, /<h3>结论<\/h3>/);
  assert.match(html, /<strong>环比增长<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>华东贡献最高<\/li>/);
  assert.match(html, /<table class="data-table markdown-table">/);
  assert.match(html, /<td>1200<\/td>/);
});

test('markdown renderer escapes raw HTML and supports fenced code blocks', () => {
  const html = renderSafeMarkdown(`
<script>alert('xss')</script>

\`\`\`sql
SELECT * FROM sales
\`\`\`
`);

  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<pre class="markdown-code" data-language="sql">/);
  assert.match(html, /SELECT \* FROM sales/);
});
