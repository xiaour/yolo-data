// 使用引导页（常驻清单 + 首登 spotlight 分步引导）。纯新增页面模块。
import * as core from '../core/runtime.js';
import { HELP_TABS, bindSectionTabs, sectionTabsMarkup } from '../components/sectionTabs.js';

const {
  state,
  ICONS,
  escapeHtml,
  escapeAttr,
  toast,
  navigate,
} = core;

const PROGRESS_KEY = 'yolo-onboarding-progress';
const TOUR_KEY = 'yolo-onboarding-tour-v1';
const RING_LENGTH = 2 * Math.PI * 36;

// 本页专用图标（Lucide 风格描边，24 单位 1.7 描边），其余复用 runtime ICONS。
const EXTRA_ICONS = {
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/>',
  play: '<path d="m7 4 13 8-13 8V4Z"/>',
  check: '<path d="m4 12.5 5 5L20 6.5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
};

function pageIcon(name) {
  const path = EXTRA_ICONS[name] ?? ICONS[name] ?? ICONS['circle-alert'];
  return `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">${path}</svg></span>`;
}

/* -------- 本地存储与剪贴板（隐私模式下静默降级） -------- */

function readLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储不可用时不阻断页面。
  }
}

function readFlag(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key) {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // 记录失败不影响本次引导。
  }
}

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 本地开发环境可能禁用 Clipboard API，走下面的兜底。
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

/* -------- 任务清单数据 -------- */

const GUIDE_TASKS = {
  analyst: [
    { t: '登录并认识工作台', d: '左侧导航分三区：分析（问数）、资产（指标/模型/主题/数据集）、治理（权限/审计）。' },
    { t: '选择一个智能体', d: '在「开始问数」顶部切换到已授权主题，例如「销售经营」。' },
    { t: '完成第一次提问', d: '在输入框用自然语言提问，例如：近7天各区域销售额趋势如何？' },
    { t: '看懂回答结构', d: '结论 → 查询范围 → 结果分析 → 图表 → 口径说明；先核对「查询范围」再采信数值。' },
    { t: '多轮追问', d: '直接在输入框继续问（如：那按渠道拆开呢），平台复用上一轮数据快照。' },
    { t: '用本地文件补充计算', d: '输入框上方上传 CSV / XLS / XLSX，随提问一起提交；提问时点名文件，例如：用「回款明细.xlsx」核对本月回款额。' },
    { t: '导出工作区产物', d: '右上角「工作区产物」可下载历史查询的 CSV / JSON / XLSX。' },
  ],
  admin: [
    { t: '配置模型连接', d: '「模型管理」新增 DeepSeek 或兼容模型：Base URL、密钥（AES-256-GCM 加密保存）、温度与工具轮次。' },
    { t: '接入业务数据集', d: '「数据集」新建 MySQL、TiDB 或 Doris 数据源并同步表结构；平台只生成只读查询，不向模型暴露原始 SQL。' },
    { t: '智能识别字段口径', d: '数据集列表「智能识别」自动推断时间 / 指标 / 维度字段与默认时间窗口，逐项确认后写回。' },
    { t: '创建智能体', d: '「智能体」绑定指标范围、数据范围、默认模型与主题提示词（参考 docs/theme-prompts）。' },
    { t: '配置数据权限', d: '「数据权限」按用户授权主题 / 指标 / 数据集；行级策略强制过滤，列级支持隐藏与脱敏。' },
    { t: '用运行审计验证闭环', d: '「运行审计」检查执行记录与权限变更；「质量运营」跟踪知识缺口。' },
  ],
};

const GUIDE_CONCEPTS = [
  { icon: 'bot', t: '智能体', d: '一个主题 = 一个独立的业务 DataAgent。它限定了可用的指标、数据范围和回答口径，问数前先在顶部切换到你的主题。' },
  { icon: 'compass', t: '指标口径', d: '每个指标都有确定义的时间规则、过滤条件和展示格式。平台按口径取数，而不是让模型自由生成 SQL，答案稳定可复现。' },
  { icon: 'workflow', t: '查询契约', d: '你的问题会被编译成一份「查询契约」：时间范围、维度、筛选先冻结再执行。回答中的「查询范围」就是这份契约的回显。' },
];

const GUIDE_TEMPLATES = [
  '近7天各区域销售额趋势如何？',
  '8月各渠道销售额环比变化如何？',
  '本月含税销售额TOP5的销售大区，按金额从高到低',
];

function roleKey(role) {
  return String(role ?? '').toUpperCase() === 'ADMIN' ? 'admin' : 'analyst';
}

export async function renderGuidePage(root) {
  const initialRole = roleKey(state.currentUser?.role);
  const saved = readLocal(PROGRESS_KEY, {});
  const store = {
    role: initialRole,
    done: {
      analyst: Array.isArray(saved?.analyst) ? [...saved.analyst] : [],
      admin: Array.isArray(saved?.admin) ? [...saved.admin] : [],
    },
  };

  root.innerHTML = `
    <div class="onboarding-page guide-page">
      ${sectionTabsMarkup(HELP_TABS, 'guide', '使用引导与帮助中心')}

      <div class="guide-hero">
        <div class="role-seg" role="tablist" aria-label="选择角色">
          <button data-role="analyst" role="tab" aria-selected="${initialRole === 'analyst'}" type="button">我是分析员</button>
          <button data-role="admin" role="tab" aria-selected="${initialRole === 'admin'}" type="button">我是平台管理员</button>
        </div>
        <button class="btn btn-small" id="guideReplayTour" type="button">${pageIcon('play')}重播首登引导</button>
      </div>

      <div class="guide-grid">
        <aside class="guide-panel guide-progress" aria-live="polite">
          <h2 class="guide-panel-title">上手进度</h2>
          <p class="guide-panel-sub" id="guideProgressRole"></p>
          <div class="guide-progress-row">
            <div class="guide-ring" aria-hidden="true">
              <svg width="84" height="84" viewBox="0 0 84 84">
                <circle cx="42" cy="42" r="36" fill="none" stroke="var(--surface-3)" stroke-width="8"/>
                <circle id="guideRingFg" cx="42" cy="42" r="36" fill="none" stroke="var(--ok)" stroke-width="8"
                  stroke-linecap="round" stroke-dasharray="${RING_LENGTH.toFixed(1)}" stroke-dashoffset="${RING_LENGTH.toFixed(1)}"/>
              </svg>
              <span class="guide-ring-num"><span id="guideRingText">0/6</span><small>已完成</small></span>
            </div>
            <div class="guide-progress-copy">
              <strong id="guideProgressMsg">从第一个动作开始</strong>
              <p>勾选会自动保存，下次登录继续。</p>
            </div>
          </div>
          <button class="btn btn-quiet btn-small" id="guideResetProgress" type="button">重置进度</button>
        </aside>

        <section class="guide-panel guide-tasks">
          <div class="sec-head">
            <h2 id="guideTaskTitle"></h2>
            <span>按顺序完成，预计 10 分钟</span>
          </div>
          <ul class="guide-task-list" id="guideTaskList"></ul>
        </section>
      </div>

      <div class="guide-section">
        <div class="sec-head"><h2>先搞懂 3 个概念</h2><span>问数前 30 秒</span></div>
        <div class="guide-concepts">
          ${GUIDE_CONCEPTS.map((concept) => `
            <div class="guide-panel guide-concept">
              <h3>${pageIcon(concept.icon)}${escapeHtml(concept.t)}</h3>
              <p>${escapeHtml(concept.d)}</p>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="guide-section">
        <div class="sec-head"><h2>可以直接抄的 3 种问法</h2><span>对象 + 指标 + 时间</span></div>
        <div class="guide-panel guide-panel-pad">
          <ul class="guide-templates">
            ${GUIDE_TEMPLATES.map((template) => `
              <li class="guide-template-row">
                <code>${escapeHtml(template)}</code>
                <button class="guide-copy-btn" type="button" data-copy="${escapeAttr(template)}">${pageIcon('copy')}复制</button>
              </li>
            `).join('')}
          </ul>
          <div class="guide-callout guide-callout-warn">
            ${pageIcon('alert')}
            <span>时间没有说清时，平台会先反问你要哪个时间范围，不会默认取「本月」或「近30天」。未完结周期（本月/本周/今年）一律统计到昨天（T-1）。</span>
          </div>
        </div>
      </div>
    </div>
  `;

  const taskList = root.querySelector('#guideTaskList');
  const taskTitle = root.querySelector('#guideTaskTitle');
  const progressRole = root.querySelector('#guideProgressRole');
  const ringText = root.querySelector('#guideRingText');
  const ringFg = root.querySelector('#guideRingFg');
  const progressMsg = root.querySelector('#guideProgressMsg');

  const renderTasks = () => {
    const list = GUIDE_TASKS[store.role];
    taskTitle.textContent = store.role === 'analyst' ? '分析员上手清单' : '管理员上手清单';
    progressRole.textContent = `${store.role === 'analyst' ? '分析员' : '管理员'}路径 · ${list.length} 个关键动作`;
    taskList.innerHTML = list.map((task, index) => {
      const done = store.done[store.role].includes(index);
      return `
        <li class="guide-task-item${done ? ' is-done' : ''}">
          <button class="guide-task-row" type="button" aria-pressed="${done}">
            <span class="guide-task-check">${pageIcon('check')}</span>
            <span class="guide-task-body">
              <span class="guide-task-title">${escapeHtml(task.t)}</span>
              <span class="guide-task-desc">${escapeHtml(task.d)}</span>
            </span>
            <span class="guide-task-meta"><span class="tag${done ? ' tag-teal' : ''}">${done ? '已完成' : '待完成'}</span></span>
          </button>
        </li>
      `;
    }).join('');
    const total = list.length;
    const count = store.done[store.role].length;
    ringText.textContent = `${count}/${total}`;
    ringFg.setAttribute('stroke-dashoffset', String(RING_LENGTH * (1 - count / total)));
    progressMsg.textContent = count === 0
      ? '从第一个动作开始'
      : count < total ? `还差 ${total - count} 步完成上手` : '上手完成，开始自主问数吧';
  };

  taskList.addEventListener('click', (event) => {
    const row = event.target.closest('.guide-task-row');
    if (!row) {
      return;
    }
    const index = [...taskList.querySelectorAll('.guide-task-row')].indexOf(row);
    if (index < 0) {
      return;
    }
    const done = store.done[store.role];
    const position = done.indexOf(index);
    if (position >= 0) {
      done.splice(position, 1);
    } else {
      done.push(index);
    }
    writeLocal(PROGRESS_KEY, store.done);
    renderTasks();
  });

  root.querySelectorAll('.role-seg button').forEach((button) => {
    button.addEventListener('click', () => {
      store.role = button.dataset.role;
      root.querySelectorAll('.role-seg button').forEach((candidate) => {
        candidate.setAttribute('aria-selected', String(candidate === button));
      });
      renderTasks();
    });
  });

  root.querySelector('#guideResetProgress').addEventListener('click', () => {
    store.done[store.role] = [];
    writeLocal(PROGRESS_KEY, store.done);
    renderTasks();
    toast('进度已重置');
  });

  root.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const copied = await copyToClipboard(button.dataset.copy);
      toast(copied ? '已复制到剪贴板' : '复制失败，请手动选择文本', copied ? 'success' : 'error');
    });
  });

  root.querySelector('#guideReplayTour').addEventListener('click', () => {
    startOnboardingTour({ force: true });
  });

  bindSectionTabs(root, navigate);
  renderTasks();
}

/* -------- 首登分步引导（spotlight） -------- */

const TOUR_STEPS = [
  {
    target: '#themeBreadcrumb',
    title: '第一步：选对主题',
    body: '每个智能体是独立的业务 DataAgent，限定了指标范围与回答口径。问数前先在顶部切换到你的主题。',
  },
  {
    target: '#questionInput',
    title: '第二步：直接提问',
    body: '用自然语言描述「对象 + 指标 + 时间」。时间没说清时平台会先反问，不会默认取「本月」。',
  },
  {
    target: '#workspaceToggle',
    title: '第三步：取回产物',
    body: '每次查询的表格与文件都保留在工作区，点这里随时下载 CSV / JSON / XLSX。',
  },
  {
    target: '#mainNav [data-page="help"]',
    title: '第四步：继续上手',
    body: '侧边栏「帮助中心」里第一项就是可勾选的上手清单，完成全部动作即可独立问数。',
  },
];

let openTourState = null;

function isVisible(element) {
  if (!element) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function waitForVisible(selector, timeout = 2500) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve) => {
    const check = () => {
      const element = document.querySelector(selector);
      if (isVisible(element)) {
        resolve(element);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  });
}

export async function startOnboardingTour({ force = false } = {}) {
  if (openTourState) {
    return true;
  }
  if (state.page !== 'query') {
    if (!force) {
      return false;
    }
    navigate('/');
  }
  await waitForVisible('#questionInput', 2500);
  const steps = TOUR_STEPS
    .map((step) => ({ ...step, element: document.querySelector(step.target) }))
    .filter((step) => isVisible(step.element));
  if (steps.length === 0) {
    return false;
  }
  writeFlag(TOUR_KEY);
  mountTour(steps);
  return true;
}

export async function autoStartOnboardingTour() {
  if (readFlag(TOUR_KEY) || state.page !== 'query') {
    return false;
  }
  return startOnboardingTour({});
}

function mountTour(steps) {
  const layer = document.createElement('div');
  layer.className = 'onb-layer is-open';
  layer.innerHTML = `
    <div class="onb-spot" data-onb-spot></div>
    <div class="onb-pop" data-onb-pop role="dialog" aria-modal="true" aria-label="新手引导" tabindex="-1">
      <span class="onb-step-no" data-onb-step></span>
      <h3 data-onb-title></h3>
      <p data-onb-body></p>
      <div class="onb-pop-foot">
        <div class="onb-dots" data-onb-dots></div>
        <button class="onb-skip" type="button" data-onb-skip>跳过引导</button>
        <button class="btn btn-quiet btn-small" type="button" data-onb-prev>上一步</button>
        <button class="btn btn-primary btn-small" type="button" data-onb-next>下一步</button>
      </div>
    </div>
    <div class="onb-toast" data-onb-toast>${pageIcon('check')}<span>引导完成，随时可在「帮助中心 → 使用引导」继续上手清单</span></div>
  `;
  document.body.appendChild(layer);

  const spot = layer.querySelector('[data-onb-spot]');
  const pop = layer.querySelector('[data-onb-pop]');
  const stepLabel = layer.querySelector('[data-onb-step]');
  const title = layer.querySelector('[data-onb-title]');
  const body = layer.querySelector('[data-onb-body]');
  const dots = layer.querySelector('[data-onb-dots]');
  const prevButton = layer.querySelector('[data-onb-prev]');
  const nextButton = layer.querySelector('[data-onb-next]');
  let index = 0;

  const place = () => {
    const step = steps[index];
    // 重新按选择器取一次：页面重渲染后旧节点会脱离文档，坐标会失效。
    const target = document.querySelector(step.target) ?? step.element;
    if (!isVisible(target)) {
      return;
    }
    const rect = target.getBoundingClientRect();
    const pad = 8;
    spot.style.left = `${rect.left - pad}px`;
    spot.style.top = `${rect.top - pad}px`;
    spot.style.width = `${rect.width + pad * 2}px`;
    spot.style.height = `${rect.height + pad * 2}px`;
    const popWidth = 320;
    const popHeight = pop.offsetHeight || 180;
    const left = Math.max(12, Math.min(rect.left + rect.width / 2 - popWidth / 2, window.innerWidth - popWidth - 12));
    let top = rect.bottom + 14;
    if (top + popHeight > window.innerHeight - 12) {
      top = rect.top - popHeight - 14;
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(12, top)}px`;
  };

  const renderStep = () => {
    const step = steps[index];
    stepLabel.textContent = `第 ${index + 1} 步 · 共 ${steps.length} 步`;
    title.textContent = step.title;
    body.textContent = step.body;
    prevButton.disabled = index === 0;
    nextButton.textContent = index === steps.length - 1 ? '完成' : '下一步';
    dots.innerHTML = steps.map((_, dotIndex) => `<i class="${dotIndex === index ? 'is-on' : ''}"></i>`).join('');
    requestAnimationFrame(place);
  };

  function onKeydown(event) {
    if (event.key === 'Escape') {
      close();
    } else if (event.key === 'ArrowRight' && index < steps.length - 1) {
      index += 1;
      renderStep();
    } else if (event.key === 'ArrowLeft' && index > 0) {
      index -= 1;
      renderStep();
    }
  }

  function close({ announce = false } = {}) {
    layer.remove();
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    document.removeEventListener('keydown', onKeydown);
    openTourState = null;
    if (announce) {
      toast('已退出引导，可随时在「帮助中心 → 使用引导」继续');
    }
  }

  layer.addEventListener('click', (event) => {
    if (!pop.contains(event.target)) {
      close();
    }
  });
  layer.querySelector('[data-onb-skip]').addEventListener('click', () => close({ announce: true }));
  prevButton.addEventListener('click', () => {
    if (index > 0) {
      index -= 1;
      renderStep();
    }
  });
  nextButton.addEventListener('click', () => {
    if (index < steps.length - 1) {
      index += 1;
      renderStep();
      return;
    }
    layer.querySelector('[data-onb-toast]').classList.add('is-open');
    window.setTimeout(() => close(), 1600);
  });
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  document.addEventListener('keydown', onKeydown);

  openTourState = { close };
  renderStep();
  pop.focus();
}
