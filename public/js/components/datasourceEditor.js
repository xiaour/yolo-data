const DATASOURCE_TYPES = [
  { type: 'MYSQL', label: 'MySQL', description: 'MySQL 或兼容协议', iconName: 'database', port: 3306 },
  { type: 'TIDB', label: 'TiDB', description: '分布式 HTAP 数据库', iconName: 'workflow', port: 4000 },
  { type: 'DORIS', label: 'Doris', description: '实时分析型数据库', iconName: 'library', port: 9030 },
];

export function openDatasourceEditor({
  api,
  toast,
  openModal,
  closeModal,
  setBusy,
  hydrateIcons,
  loadBootstrap,
  renderPage,
  state,
}) {
  const modal = openModal({
    title: '新增数据源',
    editor: true,
    body: `
      <div class="form-field span-2">
        <label>数据库类型</label>
        <div class="datasource-type-grid" role="radiogroup" aria-label="数据库类型">
          ${DATASOURCE_TYPES.map((item, index) => `
            <button class="datasource-type-tile${index === 0 ? ' is-active' : ''}" data-source-type="${item.type}" data-source-port="${item.port}" type="button" role="radio" aria-checked="${index === 0}">
              <span class="icon" data-icon="${item.iconName}" aria-hidden="true"></span>
              <span><strong>${item.label}</strong><small>${item.description}</small></span>
            </button>
          `).join('')}
        </div>
      </div>
      <div class="form-grid">
        <div class="form-field"><label for="sourceName">数据源名称</label><input class="field" id="sourceName" placeholder="开发测试数据库" /></div>
        <div class="form-field"><label for="sourceHost">Host</label><input class="field" id="sourceHost" /></div>
        <div class="form-field"><label for="sourcePort">Port</label><input class="field" id="sourcePort" type="number" value="3306" /></div>
        <div class="form-field"><label for="sourceDatabase">默认数据库</label><input class="field" id="sourceDatabase" /></div>
        <div class="form-field"><label for="sourceUsername">用户名</label><input class="field" id="sourceUsername" /></div>
        <div class="form-field"><label for="sourcePassword">密码</label><input class="field" id="sourcePassword" type="password" /></div>
      </div>
    `,
    footer: `
      <button class="btn" type="button" data-close-modal>取消</button>
      <button class="btn btn-primary" type="button" id="saveDatasourceBtn">保存数据源</button>
    `,
  });

  const picker = {
    type: 'MYSQL',
    port: '3306',
    previousPort: null,
  };
  hydrateIcons(modal);
  modal.querySelectorAll('.datasource-type-tile').forEach((button) => {
    button.addEventListener('click', () => {
      picker.type = button.dataset.sourceType;
      picker.port = button.dataset.sourcePort;
      modal.querySelectorAll('.datasource-type-tile').forEach((item) => {
        const active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-checked', String(active));
      });
      const portInput = modal.querySelector('#sourcePort');
      if (
        !portInput.value
        || portInput.value === String(picker.previousPort ?? 3306)
      ) {
        portInput.value = picker.port;
      }
      picker.previousPort = picker.port;
    });
  });
  modal.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', closeModal);
  });
  modal.querySelector('#saveDatasourceBtn').addEventListener('click', async (event) => {
    setBusy(event.currentTarget, true, '保存中');
    try {
      await api('/api/data-sources', {
        method: 'POST',
        body: JSON.stringify({
          name: modal.querySelector('#sourceName').value.trim(),
          dbType: picker.type,
          host: modal.querySelector('#sourceHost').value.trim(),
          port: Number(modal.querySelector('#sourcePort').value),
          databaseName: modal.querySelector('#sourceDatabase').value.trim(),
          username: modal.querySelector('#sourceUsername').value.trim(),
          password: modal.querySelector('#sourcePassword').value,
        }),
      });
      toast('数据源已保存，密码已加密');
      closeModal();
      await loadBootstrap(state.currentUser.id);
      renderPage();
    } catch (error) {
      toast(error.message, 'error');
      setBusy(event.currentTarget, false);
    }
  });
}

