// 帮助中心页面模块：搜索 + 分类卡 + 文章视图（内容来自 public/docs/help/*.md）。
import * as core from '../core/runtime.js';
import { HELP_TABS, bindSectionTabs, sectionTabsMarkup } from '../components/sectionTabs.js';

const {
  ICONS,
  escapeHtml,
  toast,
  navigate,
  renderSafeMarkdown,
} = core;

const HELP_BASE = '/docs/help/';

// 本页专用图标，其余复用 runtime ICONS。
const EXTRA_ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15A2.5 2.5 0 0 0 6.5 22H20v-2.5"/>',
  'life-buoy': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="m5.6 5.6 3.5 3.5M14.9 14.9l3.5 3.5M18.4 5.6l-3.5 3.5M9.1 14.9l-3.5 3.5"/>',
};

function pageIcon(name) {
  const path = EXTRA_ICONS[name] ?? ICONS[name] ?? ICONS['circle-alert'];
  return `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">${path}</svg></span>`;
}

const HELP_CATS = [
  { id: 'quick', name: '快速上手', icon: 'compass', desc: '第一次使用，从这里开始' },
  { id: 'skill', name: '问数技巧', icon: 'sparkles', desc: '把问题问清楚，答案更稳定' },
  { id: 'admin', name: '管理员配置', icon: 'settings', desc: '模型、数据集、主题与权限' },
  { id: 'concept', name: '核心概念', icon: 'book', desc: '智能体 / 指标口径 / 查询契约' },
  { id: 'faq', name: '常见问题', icon: 'life-buoy', desc: '排错与口径差异排查' },
  { id: 'file', name: '本地文件', icon: 'file', desc: '上传表格，与问数结果一起算' },
];

const HELP_ARTICLES = [
  { id: 'quick-start', cat: 'quick', title: '快速上手（分析员）', file: '01-quick-start.md', kw: '登录 角色 工作台 主题 提问 追问 导出 第一次' },
  { id: 'query-skills', cat: 'skill', title: '问数技巧与提问模板', file: '02-query-skills.md', kw: '对象 指标 时间 同比 环比 TOP 排名 占比 模板 反问' },
  { id: 'admin-guide', cat: 'admin', title: '管理员配置指南', file: '03-admin-guide.md', kw: '模型 数据集 智能识别 Doris MySQL 字段 主题 权限 审计 上线检查' },
  { id: 'core-concepts', cat: 'concept', title: '核心概念速查', file: '04-core-concepts.md', kw: '智能体 指标口径 查询契约 T-1 工作区产物 会话记忆' },
  { id: 'faq', cat: 'faq', title: '常见问题与排错', file: '05-faq.md', kw: '数字对不上 含税 未税 未配置 导出 CSV XLSX 密码 会话失效' },
  { id: 'local-file', cat: 'file', title: '结合本地文件算数', file: '06-local-file.md', kw: '上传 本地文件 附件 CSV XLS XLSX Excel 对账 合并 预算 编码 截断 行数 配额' },
];

let docsPromise = null;
const docsById = new Map();

function docFor(articleId) {
  const article = HELP_ARTICLES.find((entry) => entry.id === articleId) ?? HELP_ARTICLES[0];
  return docsById.get(article.id) ?? { ...article, text: '' };
}

function ensureDocs() {
  if (!docsPromise) {
    docsPromise = Promise.all(HELP_ARTICLES.map(async (article) => {
      let text = '';
      try {
        const response = await fetch(HELP_BASE + article.file, { headers: { Accept: 'text/markdown' } });
        if (response.ok) {
          text = await response.text();
        }
      } catch {
        text = '';
      }
      const doc = { ...article, text };
      docsById.set(article.id, doc);
      return doc;
    }));
  }
  return docsPromise;
}

function catName(catId) {
  return HELP_CATS.find((cat) => cat.id === catId)?.name ?? '';
}

function plainText(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[#*`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function highlight(text, query) {
  const escaped = escapeHtml(text);
  if (!query) {
    return escaped;
  }
  const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp(`(${safe})`, 'gi'), '<mark>$1</mark>');
}

function snippetFor(doc, query) {
  const plain = plainText(doc.text);
  if (!plain) {
    return doc.kw ? `关键词：${doc.kw}` : '';
  }
  const index = query ? plain.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (index < 0) {
    return `${plain.slice(0, 88)}${plain.length > 88 ? '…' : ''}`;
  }
  const start = Math.max(0, index - 32);
  const end = Math.min(plain.length, index + query.length + 52);
  return `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`;
}

function searchArticles(query) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }
  return [...docsById.values()]
    .map((doc) => {
      const haystack = `${doc.title} ${catName(doc.cat)} ${doc.kw} ${plainText(doc.text)}`.toLowerCase();
      const index = haystack.indexOf(needle);
      if (index < 0) {
        return null;
      }
      return { doc, score: doc.title.toLowerCase().includes(needle) ? 0 : 1, index };
    })
    .filter(Boolean)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((hit) => hit.doc);
}

export async function renderHelpPage(root) {
  ensureDocs();
  root.innerHTML = `
    <div class="onboarding-page help-page">
      ${sectionTabsMarkup(HELP_TABS, 'help', '使用引导与帮助中心')}

      <div class="help-search-wrap">
        <span class="help-search-icon">${pageIcon('search')}</span>
        <input class="help-search" id="helpSearch" type="search" autocomplete="off"
          placeholder="搜索：权限、口径、导出、数据集…" aria-label="搜索帮助文档" />
      </div>
      <div class="help-results" id="helpResults" hidden></div>
      <div class="help-cats" id="helpCats">
        ${HELP_CATS.map((cat) => {
          const articles = HELP_ARTICLES.filter((article) => article.cat === cat.id);
          return `
            <section class="guide-panel help-cat">
              <div class="help-cat-head">
                ${pageIcon(cat.icon)}
                <h3>${escapeHtml(cat.name)}</h3>
                <span class="help-cat-count">${articles.length} 篇</span>
              </div>
              <p>${escapeHtml(cat.desc)}</p>
              <ul class="help-links">
                ${articles.map((article) => `
                  <li>
                    <button class="help-link" type="button" data-article="${article.id}">
                      ${pageIcon('file')}<span>${escapeHtml(article.title)}</span>
                    </button>
                  </li>
                `).join('')}
              </ul>
            </section>
          `;
        }).join('')}
      </div>
    </div>
  `;

  // 委托监听挂在本次渲染的容器上：#appMain 是常驻节点，挂它会在重复进入时累积监听器。
  const page = root.querySelector('.help-page');
  const searchInput = root.querySelector('#helpSearch');
  const results = root.querySelector('#helpResults');
  const cats = root.querySelector('#helpCats');
  let sequence = 0;

  const renderResults = async (value) => {
    const query = value.trim();
    if (!query) {
      results.hidden = true;
      results.innerHTML = '';
      cats.hidden = false;
      return;
    }
    const current = ++sequence;
    await ensureDocs();
    if (current !== sequence) {
      return;
    }
    const hits = searchArticles(query);
    cats.hidden = true;
    results.hidden = false;
    if (hits.length === 0) {
      results.innerHTML = `
        <div class="guide-panel guide-empty">
          ${pageIcon('search')}
          <p>没有找到与「${escapeHtml(query)}」相关的文章</p>
          <button class="btn btn-small" id="helpClearSearch" type="button">清空搜索，浏览全部分类</button>
        </div>
      `;
      results.querySelector('#helpClearSearch').addEventListener('click', () => {
        searchInput.value = '';
        renderResults('');
        searchInput.focus();
      });
      return;
    }
    results.innerHTML = hits.map((doc) => `
      <button class="guide-panel help-hit" type="button" data-article="${doc.id}">
        <h4>${highlight(doc.title, query)}<span class="tag">${escapeHtml(catName(doc.cat))}</span></h4>
        <p>${highlight(snippetFor(doc, query), query)}</p>
      </button>
    `).join('');
  };

  searchInput.addEventListener('input', () => {
    renderResults(searchInput.value);
  });

  bindSectionTabs(root, navigate);
  page.addEventListener('click', (event) => {
    const button = event.target.closest('[data-article]');
    if (button) {
      renderHelpArticle(root, button.dataset.article);
    }
  });
}

export async function renderHelpArticle(root, articleId) {
  await ensureDocs();
  const doc = docFor(articleId);
  const index = HELP_ARTICLES.findIndex((article) => article.id === doc.id);
  const previous = index > 0 ? HELP_ARTICLES[index - 1] : null;
  const next = index >= 0 && index < HELP_ARTICLES.length - 1 ? HELP_ARTICLES[index + 1] : null;

  root.innerHTML = `
    <div class="onboarding-page help-article-page">
      ${sectionTabsMarkup(HELP_TABS, 'help', '使用引导与帮助中心')}

      <div class="article-layout">
        <aside class="article-toc">
          <div class="toc-label">本页目录</div>
          <ul id="articleToc"></ul>
        </aside>
        <article class="article-body">
          <div class="article-crumb">
            <button type="button" data-help-home>帮助中心</button>
            <span>/</span><span>${escapeHtml(catName(doc.cat))}</span>
            <span>/</span><span>${escapeHtml(doc.title)}</span>
          </div>
          <div class="article-content" id="articleContent">
            ${doc.text ? renderSafeMarkdown(doc.text) : '<p>文档内容暂时不可用，请稍后重试。</p>'}
          </div>
          <div class="article-foot">
            <span class="article-nav">
              ${previous
                ? `<button class="btn btn-small" type="button" data-article-nav="${previous.id}">上一篇：${escapeHtml(previous.title)}</button>`
                : '<span class="article-nav-empty">上一篇：无</span>'}
              ${next
                ? `<button class="btn btn-small" type="button" data-article-nav="${next.id}">下一篇：${escapeHtml(next.title)}</button>`
                : '<span class="article-nav-empty">下一篇：无</span>'}
            </span>
            <span class="article-feedback">
              <span>本页是否有帮助？</span>
              <button class="btn btn-small" type="button" data-feedback="up" aria-label="有帮助">${pageIcon('thumbs-up')}</button>
              <button class="btn btn-small" type="button" data-feedback="down" aria-label="没帮助">${pageIcon('thumbs-down')}</button>
              <span class="feedback-state" id="articleFeedbackState" hidden>感谢反馈</span>
            </span>
          </div>
        </article>
      </div>
    </div>
  `;

  const toc = root.querySelector('#articleToc');
  const headings = [...root.querySelectorAll('#articleContent h2')];
  headings.forEach((heading, headingIndex) => {
    heading.id = `a-${headingIndex + 1}`;
  });
  toc.innerHTML = headings.map((heading) => (
    `<li><a href="#${heading.id}">${escapeHtml(heading.textContent)}</a></li>`
  )).join('');
  toc.addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!link) {
      return;
    }
    event.preventDefault();
    root.querySelector(link.getAttribute('href'))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    toc.querySelectorAll('a').forEach((candidate) => candidate.classList.toggle('is-current', candidate === link));
  });

  const feedbackState = root.querySelector('#articleFeedbackState');
  root.querySelectorAll('[data-feedback]').forEach((button) => {
    button.addEventListener('click', () => {
      feedbackState.hidden = false;
      if (button.dataset.feedback === 'down') {
        toast('感谢反馈，我们会在下一篇改进');
      }
    });
  });

  bindSectionTabs(root, navigate, {
    onActiveTab: (tabId) => {
      if (tabId === 'help') {
        renderHelpPage(root);
      }
    },
  });
  root.querySelector('[data-help-home]').addEventListener('click', () => renderHelpPage(root));
  root.querySelectorAll('[data-article-nav]').forEach((button) => {
    button.addEventListener('click', () => renderHelpArticle(root, button.dataset.articleNav));
  });
}
