'use strict';

/* global window, document */

const ctmApi = window.ctm;

const state = {
  env: null,
  overview: null,
  caps: null,
  settings: {},
  view: 'dashboard',
  selection: { editor: null, dns: null, service: null },
  editorDirty: false,
  followingLogs: false,
  runningTunnel: null,
  confirmResolver: null,
  refreshTimer: null,
};

const VIEW_TITLES = {
  dashboard: { title: 'Dashboard de Túneis', sub: 'Gerencie seus túneis e serviços nativos do SO' },
  create: { title: 'Novo Subdomínio', sub: 'Túnel + ingress + DNS + serviço no ar em um só passo' },
  editor: { title: 'Editor de Ingress', sub: 'Edite as regras em YAML com validação e backup automático' },
  dns: { title: 'Registros DNS', sub: 'Crie os CNAMEs que apontam os subdomínios para o túnel' },
  service: { title: 'Serviço & Logs', sub: 'Controle o serviço do SO, execute manualmente e veja os logs' },
  settings: { title: 'Configurações', sub: 'CLI, modo do serviço, backups e limpeza' },
};

// ------------------------------------------------------------------ helpers

function el(id) {
  return document.getElementById(id);
}

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(message, type = 'info', timeout = 6000) {
  const stack = el('toast-stack');
  const node = document.createElement('div');
  node.className = `toast toast-${type}`;
  node.innerHTML = `<div class="toast-body">${esc(message).replace(/\n/g, '<br>')}</div>`
    + '<button class="toast-close" aria-label="fechar">✕</button>';
  const remove = () => node.remove();
  node.querySelector('.toast-close').addEventListener('click', remove);
  stack.appendChild(node);
  if (timeout > 0) setTimeout(remove, timeout);
  return node;
}

function findTunnel(name) {
  if (!state.overview) return null;
  return state.overview.tunnels.find((tunnel) => tunnel.name === name) || null;
}

function selectedTunnel(key) {
  const select = el(`select-${key}`);
  if (select && select.value) return select.value;
  return state.selection[key];
}

function setConsole(node, text, { append = false } = {}) {
  if (!node) return;
  node.classList.remove('hidden');
  if (append) {
    node.textContent += text;
  } else {
    node.textContent = text;
  }
  node.scrollTop = node.scrollHeight;
}

function busy(button, isBusy, label) {
  if (!button) return;
  if (isBusy) {
    button.dataset.originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = label || 'Aguarde…';
  } else {
    button.disabled = false;
    if (button.dataset.originalLabel) button.textContent = button.dataset.originalLabel;
  }
}

/** Modal de confirmação (com palavra digitada para ações destrutivas). */
function confirmAction({ title, message, danger = true, word = null }) {
  return new Promise((resolve) => {
    state.confirmResolver = resolve;
    el('confirm-title').textContent = title || 'Confirmar';
    el('confirm-message').innerHTML = esc(message).replace(/\n/g, '<br>');
    const okButton = el('confirm-ok');
    okButton.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    okButton.textContent = danger ? 'Confirmar' : 'OK';
    const typedGroup = el('confirm-typed-group');
    const typedInput = el('confirm-typed');
    if (word) {
      typedGroup.classList.remove('hidden');
      el('confirm-typed-word').textContent = word;
      typedInput.value = '';
      okButton.disabled = true;
      setTimeout(() => typedInput.focus(), 50);
    } else {
      typedGroup.classList.add('hidden');
      okButton.disabled = false;
    }
    el('modal-confirm').classList.add('active');
  });
}

function closeConfirm(result) {
  el('modal-confirm').classList.remove('active');
  const resolver = state.confirmResolver;
  state.confirmResolver = null;
  if (resolver) resolver(result);
}

// --------------------------------------------------------------- navegação

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === view);
  });
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `view-${view}`);
  });
  const meta = VIEW_TITLES[view] || VIEW_TITLES.dashboard;
  el('view-title').textContent = meta.title;
  el('view-subtitle').textContent = meta.sub;

  if (view === 'create') loadZones();
  if (view === 'editor') loadEditor();
  if (view === 'service') loadServiceView();
  if (view === 'settings') renderSettings();
}

// ------------------------------------------------------------------ render

function renderSidebar() {
  const overview = state.overview;
  const cli = overview ? overview.cli : null;
  const dot = (node, status) => {
    node.className = `status-dot ${status}`;
  };

  if (!cli) {
    dot(el('dot-cli'), 'offline');
    el('label-cli').textContent = 'cloudflared: —';
    return;
  }

  dot(el('dot-cli'), cli.installed ? 'online' : 'offline');
  el('label-cli').textContent = cli.installed
    ? `cloudflared ${(cli.version || '').replace('cloudflared version ', 'v')}`
    : 'cloudflared ausente';

  dot(el('dot-auth'), cli.authenticated ? 'online' : 'warning');
  el('label-auth').textContent = cli.authenticated ? 'autenticado' : 'não autenticado';

  const loginButton = el('btn-login-sidebar');
  if (loginButton) {
    loginButton.textContent = cli.authenticated ? '🔑 Reautenticar' : '🔑 Autenticar Cloudflare';
    loginButton.classList.toggle('btn-primary', !cli.authenticated);
    loginButton.classList.toggle('btn-secondary', Boolean(cli.authenticated));
  }

  dot(el('dot-service'), 'online');
  el('label-service').textContent = `serviço: ${overview.serviceMode === 'system' ? 'sistema' : 'usuário'}`;
}

function renderDashboard() {
  const overview = state.overview;
  const list = el('tunnels-list');
  const alerts = el('dashboard-alerts');

  if (!overview) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>Carregando…</p></div>';
    return;
  }

  const alertNodes = [];
  if (!overview.cli.installed) {
    alertNodes.push(`<div class="alert alert-error">
      <strong>cloudflared não está instalado.</strong> Sem o binário não é possível criar ou rodar túneis.
      <button class="btn btn-primary btn-sm" data-action="install-cli">Instalar agora</button>
      </div>`);
  } else if (!overview.cli.authenticated) {
    alertNodes.push(`<div class="alert alert-warning">
      <strong>Não autenticado.</strong> Falta o <code>~/.cloudflared/cert.pem</code> — rode o login para
      listar e criar túneis.
      <button class="btn btn-primary btn-sm" data-action="login">Autenticar</button>
      </div>`);
  }
  if (overview.listError) {
    alertNodes.push(`<div class="alert alert-error"><strong>Falha ao listar túneis:</strong><br>${esc(overview.listError)}</div>`);
  }
  alerts.innerHTML = alertNodes.join('');

  if (!overview.tunnels.length) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🔌</div>
      <h3>Nenhum túnel encontrado</h3>
      <p>Publique um subdomínio apontando para o serviço que está rodando na sua máquina.</p>
      <button class="btn btn-primary btn-sm" data-action="goto-create">🚀 Criar meu primeiro subdomínio</button>
    </div>`;
    renderOrphans();
    return;
  }

  list.innerHTML = overview.tunnels.map((tunnel) => {
    const service = tunnel.service || {};
    const badges = [];
    badges.push(service.running
      ? '<span class="badge badge-active">● Rodando</span>'
      : '<span class="badge badge-inactive">○ Parado</span>');
    if (service.enabled) badges.push('<span class="badge badge-on">boot</span>');
    if (service.installed && service.mode) {
      badges.push(`<span class="badge badge-muted">${service.mode === 'system' ? 'sistema' : 'usuário'}</span>`);
    }
    if (!tunnel.config.exists) badges.push('<span class="badge badge-warn">sem YAML</span>');
    else if (!tunnel.config.valid) badges.push('<span class="badge badge-error">YAML inválido</span>');
    if (!tunnel.credentials.exists) badges.push('<span class="badge badge-warn">sem credencial</span>');

    const routeCount = tunnel.config.routes ? tunnel.config.routes.length : 0;
    const warnings = tunnel.warnings || [];

    return `<div class="card" data-tunnel="${esc(tunnel.name)}">
      <div class="card-header">
        <div class="card-title-wrap">
          <div class="tunnel-name">${esc(tunnel.name)}</div>
          <div class="tunnel-id" title="${esc(tunnel.id)}">${esc(tunnel.id)}</div>
        </div>
        <div class="badge-wrap">${badges.join('')}</div>
      </div>
      <div class="card-body">
        <div class="info-row"><span>Rotas</span><span class="info-value">${routeCount}</span></div>
        <div class="info-row"><span>Conexões</span><span class="info-value">${tunnel.connectionsCount}</span></div>
        <div class="info-row"><span>Criado em</span><span class="info-value">${formatDate(tunnel.createdAt)}</span></div>
      </div>
      ${warnings.length ? `<ul class="warn-list">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <div class="card-actions">
        ${service.running
          ? `<button class="btn btn-secondary btn-sm" data-action="card-stop" data-tunnel="${esc(tunnel.name)}">⏹ Parar</button>
             <button class="btn btn-secondary btn-sm" data-action="card-restart" data-tunnel="${esc(tunnel.name)}">🔄 Reiniciar</button>`
          : `<button class="btn btn-primary btn-sm" data-action="card-start" data-tunnel="${esc(tunnel.name)}">▶ Iniciar</button>`}
        <button class="btn btn-secondary btn-sm" data-action="card-editor" data-tunnel="${esc(tunnel.name)}">📝 YAML</button>
        <button class="btn btn-secondary btn-sm" data-action="card-logs" data-tunnel="${esc(tunnel.name)}">📜 Logs</button>
        <button class="btn btn-danger btn-sm push-right" data-action="card-delete"
                data-tunnel="${esc(tunnel.name)}" data-id="${esc(tunnel.id)}">🗑 Excluir</button>
      </div>
    </div>`;
  }).join('');

  renderOrphans();
}

function formatDate(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.getFullYear() < 2000) return '—';
  return parsed.toLocaleDateString('pt-BR');
}

function renderOrphans() {
  const overview = state.overview;
  const section = el('orphans-section');
  if (!overview || !overview.orphans.length) {
    section.innerHTML = '';
    return;
  }

  section.innerHTML = `<div class="panel">
    <h2 class="panel-title">⚠️ Configurações órfãs</h2>
    <p class="panel-hint">Estes arquivos <code>.yml</code> existem em <code>~/.cloudflared</code> mas o túnel
      correspondente não existe mais na conta.</p>
    <div class="route-table">
      ${overview.orphans.map((orphan) => `<div class="route-row">
        <div class="route-main">
          <strong>${esc(orphan.name)}.yml</strong>
          <span class="hint-line">${esc(orphan.reason)}</span>
        </div>
        <div class="route-actions">
          <button class="btn btn-secondary btn-xs" data-action="orphan-open" data-path="${esc(orphan.path)}">Abrir</button>
          <button class="btn btn-danger btn-xs" data-action="orphan-remove"
                  data-path="${esc(orphan.path)}" data-name="${esc(orphan.name)}">Remover</button>
        </div>
      </div>`).join('')}
    </div>
  </div>`;
}

function fillSelect(selectId, tunnels, selected) {
  const select = el(selectId);
  if (!select) return;
  const previous = selected || select.value;
  if (!tunnels.length) {
    select.innerHTML = '<option value="">(nenhum túnel)</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = tunnels
    .map((tunnel) => `<option value="${esc(tunnel.name)}">${esc(tunnel.name)} · ${esc(tunnel.id.slice(0, 8))}</option>`)
    .join('');
  if (previous && tunnels.some((tunnel) => tunnel.name === previous)) {
    select.value = previous;
  }
}

function renderSelects() {
  const tunnels = state.overview ? state.overview.tunnels : [];
  fillSelect('select-editor', tunnels, state.selection.editor);
  fillSelect('select-dns', tunnels, state.selection.dns);
  fillSelect('select-service', tunnels, state.selection.service);

  state.selection.editor = el('select-editor').value || null;
  state.selection.dns = el('select-dns').value || null;
  state.selection.service = el('select-service').value || null;
}

function renderTunnelChoices() {
  const select = el('publish-existing-tunnel');
  if (!select) return;
  const tunnels = state.overview ? state.overview.tunnels : [];
  const previous = select.value;
  select.innerHTML = tunnels.length
    ? tunnels.map((tunnel) => `<option value="${esc(tunnel.name)}">${esc(tunnel.name)}${tunnel.config.exists ? '' : ' (sem YAML)'}</option>`).join('')
    : '<option value="">(nenhum túnel ainda)</option>';
  if (previous && tunnels.some((tunnel) => tunnel.name === previous)) select.value = previous;
}

// -------------------------------------------------------------------- dados

async function refresh({ silent = false } = {}) {
  const res = await ctmApi.overview();
  if (!res.ok) {
    toast(`Falha ao carregar o estado: ${res.error}`, 'error', 10000);
    return;
  }
  state.overview = res;
  state.env = res.platform;
  state.settings = res.platform.settings || {};

  renderSidebar();
  renderDashboard();
  renderSelects();
  renderPrerequisitos();
  renderTunnelChoices();
  if (state.view === 'settings') renderSettings();
  if (state.view === 'service') renderServiceState();
  if (state.view === 'editor' && !state.editorDirty) loadEditor({ silent: true });
  if (silent) return;
}

function startAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (state.view === 'dashboard' && state.settings.autoRefresh !== false) {
      refresh({ silent: true }).catch(() => {});
    }
  }, 20000);
}

// ------------------------------------------------------------------- editor

async function loadEditor({ silent = false } = {}) {
  const name = el('select-editor').value;
  state.selection.editor = name || null;
  const statusNode = el('editor-status');
  const routesNode = el('editor-routes');
  const backupSelect = el('select-backup');
  el('editor-content').value = '';

  if (!name) {
    statusNode.textContent = 'Nenhum túnel selecionado.';
    routesNode.innerHTML = '';
    backupSelect.innerHTML = '<option value="">Restaurar backup…</option>';
    return;
  }

  const res = await ctmApi.readConfig(name);
  if (!res.ok) {
    statusNode.innerHTML = `<span class="text-error">${esc(res.error)}</span>`;
    routesNode.innerHTML = '';
    state.editorDirty = false;
    return;
  }

  el('editor-content').value = res.content;
  state.editorDirty = false;
  statusNode.innerHTML = `<code>${esc(res.path)}</code> · ${(res.content.split('\n').length)} linhas · `
    + `${res.routes.length} rota(s)`;

  routesNode.innerHTML = res.routes.length
    ? res.routes.map((route, index) => `<div class="route-row">
        <div class="route-main">
          <strong>${esc(route.hostname || '(catch-all)')}</strong>
          <code>${esc(route.service || '—')}</code>
          ${route.path ? `<span class="hint-line">path: ${esc(route.path)}</span>` : ''}
        </div>
        <div class="route-actions">
          <button class="btn btn-danger btn-xs" data-action="route-remove" data-index="${index}"
                  data-hostname="${esc(route.hostname || '')}">Remover</button>
        </div>
      </div>`).join('')
    : '<p class="hint-line">Nenhuma rota: apenas o catch-all 404.</p>';

  const backups = await ctmApi.listBackups(name);
  const options = ['<option value="">Restaurar backup…</option>'];
  if (backups.ok) {
    for (const backup of backups.backups) {
      const label = backup.name.replace(`${name}.yml.`, '').replace('.bak', '');
      options.push(`<option value="${esc(backup.file)}">${esc(label)}</option>`);
    }
  }
  backupSelect.innerHTML = options.join('');
  if (!silent) return;
}

async function saveEditor() {
  const name = el('select-editor').value;
  if (!name) return toast('Selecione um túnel.', 'warning');
  const content = el('editor-content').value;
  const res = await ctmApi.saveConfig(name, content);
  if (res.ok) {
    state.editorDirty = false;
    toast(`Configuração validada e salva.${res.backupPath ? ' Backup do anterior guardado.' : ''}`, 'success');
    await refresh({ silent: true });
    await loadEditor({ silent: true });
  } else {
    toast(res.notWritten
      ? `Nada foi gravado — a configuração é inválida:\n${res.error}`
      : `Falha ao salvar: ${res.error}`, 'error', 12000);
  }
}

async function validateEditor() {
  const name = el('select-editor').value;
  if (!name) return toast('Selecione um túnel.', 'warning');
  const content = el('editor-content').value;
  const res = await ctmApi.validateConfigText(content);
  if (res.ok) toast('Configuração de ingress válida ✔', 'success');
  else toast(`Configuração inválida:\n${res.error}`, 'error', 12000);
}

async function scaffoldConfig() {
  const name = el('select-editor').value;
  if (!name) return toast('Selecione um túnel.', 'warning');
  const tunnel = findTunnel(name);
  if (!tunnel) return toast('Túnel não encontrado no estado atual.', 'error');

  let res = await ctmApi.scaffoldConfig({ name, tunnelId: tunnel.id, routes: [] });
  if (!res.ok && res.exists) {
    const overwrite = await confirmAction({
      title: 'Sobrescrever configuração',
      message: `${res.error}\n\nContinuar vai substituir o YAML atual por um esqueleto com apenas a regra 404.\nUse "Salvar" no editor se a intenção era preservar as rotas.`,
    });
    if (!overwrite) return;
    res = await ctmApi.scaffoldConfig({ name, tunnelId: tunnel.id, routes: [], overwrite: true });
  }
  if (!res.ok) return toast(`Falha ao gerar configuração: ${res.error}`, 'error', 10000);
  toast(res.hasCredentials
    ? 'Configuração criada.'
    : 'Configuração criada, mas as credenciais (.json) não existem nesta máquina — o túnel não conecta sem elas.',
  res.hasCredentials ? 'success' : 'warning', 12000);
  await refresh({ silent: true });
  await loadEditor({ silent: true });
}

// ------------------------------------------------------- novo subdomínio

const publishState = {
  zones: [],
  steps: [],
  lastResult: null,
  checkingHostname: null,
  hostnameTimer: null,
};

function currentDomain() {
  const select = el('publish-domain');
  if (!select) return '';
  if (select.value === '__custom__') {
    return el('publish-domain-custom').value.trim().toLowerCase();
  }
  return select.value || '';
}

function currentHostname() {
  const subdomain = el('publish-subdomain').value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  const domain = currentDomain();
  if (!subdomain) return '';
  if (!domain) return subdomain;
  // Já é o hostname completo (ou já termina no domínio escolhido)?
  if (subdomain === domain || subdomain.endsWith(`.${domain}`)) return subdomain;
  // Aceita rótulos compostos: "api.dev" + "exemplo.com" → "api.dev.exemplo.com"
  return `${subdomain}.${domain}`;
}

function updateHostnamePreview() {
  const hostname = currentHostname();
  el('publish-preview-value').textContent = hostname || '—';

  // O nome padrão do túnel acompanha o subdomínio.
  const suggested = (el('publish-subdomain').value.trim().toLowerCase().split('.')[0] || '')
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+/, '');
  el('publish-tunnel-name').placeholder = suggested ? `padrão: ${suggested}` : 'padrão: o subdomínio';

  clearTimeout(publishState.hostnameTimer);
  if (!hostname || !hostname.includes('.')) {
    el('publish-hostname-status').innerHTML = '';
    return;
  }
  publishState.hostnameTimer = setTimeout(() => checkHostnameLive(hostname), 600);
}

async function checkHostnameLive(hostname) {
  const node = el('publish-hostname-status');
  if (publishState.checkingHostname === hostname) return;
  publishState.checkingHostname = hostname;
  node.innerHTML = '<span class="hint-line">verificando este endereço…</span>';

  const res = await ctmApi.checkHostname(hostname);
  if (publishState.checkingHostname !== hostname) return;
  publishState.checkingHostname = null;
  if (!res.ok) {
    node.innerHTML = `<span class="hint-line">${esc(res.error || 'não foi possível verificar')}</span>`;
    return;
  }

  const parts = [];
  const authority = res.authority || {};
  if (authority.known && authority.authorized) {
    parts.push(`<span class="pill pill-ok">domínio autorizado: ${esc(authority.zone ? authority.zone.name : hostname)}</span>`);
  } else if (authority.known && !authority.authorized) {
    const allowed = (authority.zones || []).map((z) => z.name).join(', ') || 'nenhum';
    parts.push(`<span class="pill pill-error">domínio não autorizado</span>
      <span class="hint-line">este login só gerencia <strong>${esc(allowed)}</strong> — clique em “Reautenticar” e escolha o outro domínio no navegador.</span>`);
  }

  const dns = res.dns || {};
  const records = res.records || [];
  const cnameToTunnel = records.find((record) => record.type === 'CNAME'
    && /cfargotunnel\.com$/i.test(record.content || ''));

  if (cnameToTunnel) {
    parts.push('<span class="pill pill-warn">DNS já existe → este túnel</span>');
  } else if (records.length) {
    const first = records[0];
    parts.push(`<span class="pill pill-warn">DNS já existe (${esc(first.type)} → ${esc(first.content)})</span>`);
  } else if (dns.resolves) {
    // Pode ser um registro proxied de outro túnel/serviço.
    parts.push('<span class="pill pill-warn">endereço já resolve — confira antes de sobrescrever</span>');
  } else {
    parts.push('<span class="pill pill-ok">endereço livre</span>');
  }

  node.innerHTML = parts.join(' ');
}

async function loadZones() {
  const select = el('publish-domain');
  const res = await ctmApi.listZones();
  publishState.zones = res.ok ? res.zones : [];

  if (!publishState.zones.length) {
    // Sem API (ou sem login): deixa o usuário digitar o domínio.
    select.innerHTML = '<option value="__custom__">digitar domínio…</option>';
    select.value = '__custom__';
    el('publish-domain-custom').classList.remove('hidden');
    if (!res.ok && res.error) {
      el('publish-hostname-status').innerHTML = `<span class="hint-line">${esc(res.error)}</span>`;
    }
    return;
  }

  select.innerHTML = publishState.zones
    .map((zone) => `<option value="${esc(zone.name)}">${esc(zone.name)}</option>`)
    .join('') + '<option value="__custom__">outro domínio…</option>';

  el('publish-domain-custom').classList.add('hidden');
  updateHostnamePreview();
}

function renderPrerequisitos() {
  const overview = state.overview;
  const box = el('create-prereqs');
  if (!overview) {
    box.innerHTML = '';
    return;
  }

  const steps = [
    {
      done: overview.cli.installed,
      label: 'cloudflared instalado',
      detail: overview.cli.version || 'binário não encontrado',
      action: 'install-cli',
      button: 'Instalar agora',
    },
    {
      done: overview.cli.authenticated,
      label: 'Conta Cloudflare autenticada',
      detail: overview.cli.authenticated ? 'cert.pem presente' : 'necessário para criar o DNS',
      action: 'login',
      button: 'Autenticar',
    },
  ];

  if (steps.every((step) => step.done)) {
    box.innerHTML = '';
    return;
  }

  box.innerHTML = `<div class="panel">
    <h2 class="panel-title">Antes de começar</h2>
    <ul class="checklist">
      ${steps.map((step) => `<li class="${step.done ? 'done' : 'todo'}">
        <span class="check">${step.done ? '✓' : '○'}</span>
        <div><strong>${esc(step.label)}</strong><div class="hint-line">${esc(step.detail)}</div></div>
        ${step.done ? '' : `<button class="btn btn-primary btn-sm" data-action="${step.action}">${esc(step.button)}</button>`}
      </li>`).join('')}
    </ul>
  </div>`;
}

async function testLocalService() {
  const port = el('publish-port').value.trim();
  const scheme = el('publish-scheme').value;
  const node = el('publish-local-result');
  if (!port) {
    node.innerHTML = '<span class="text-error">Informe a porta.</span>';
    return;
  }
  node.textContent = 'testando…';
  const res = await ctmApi.checkLocal(port, scheme);
  if (res.listening && !res.warning) {
    node.innerHTML = `<span class="pill pill-ok">respondendo</span> HTTP ${res.httpStatus ?? ''} em ${res.elapsedMs ?? '?'}ms`;
  } else if (res.listening) {
    node.innerHTML = `<span class="pill pill-warn">porta aberta</span> ${esc(res.warning || '')}`;
  } else {
    node.innerHTML = `<span class="pill pill-error">sem resposta</span> ${esc(res.error || '')}`;
  }
}

function renderTimeline() {
  const panel = el('publish-timeline-panel');
  const list = el('publish-timeline');
  if (!publishState.steps.length) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  const icons = {
    pending: '○', running: '◌', ok: '✓', warn: '!', error: '✕', skipped: '–',
  };

  list.innerHTML = publishState.steps.map((step) => `<li class="timeline-item ${step.state}">
    <span class="timeline-icon">${icons[step.state] || '○'}</span>
    <div class="timeline-body">
      <strong>${esc(step.label)}</strong>
      ${step.detail ? `<div class="hint-line">${esc(step.detail)}</div>` : ''}
    </div>
  </li>`).join('');
}

function renderPublishResult(result) {
  const node = el('publish-result');
  if (!result) {
    node.innerHTML = '';
    return;
  }

  const warnings = (result.warnings || []).length
    ? `<ul class="warn-list">${result.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
    : '';

  if (result.ok) {
    node.innerHTML = `<div class="result-card ok">
      <div class="result-title">✅ ${esc(result.hostname)} está publicado</div>
      <a href="#" class="result-url" data-action="open-url" data-url="${esc(result.url)}">${esc(result.url)}</a>
      <div class="hint-line">túnel: ${esc(result.tunnel || '—')}</div>
      <div class="button-row">
        <button class="btn btn-primary btn-sm" data-action="open-url" data-url="${esc(result.url)}">🌐 Abrir no navegador</button>
        <button class="btn btn-secondary btn-sm" data-action="retest-hostname" data-hostname="${esc(result.hostname)}">🔁 Testar de novo</button>
      </div>
    </div>${warnings}`;
    return;
  }

  const firstError = publishState.steps.find((step) => step.state === 'error');
  node.innerHTML = `<div class="result-card error">
    <div class="result-title">Não foi possível concluir</div>
    <div>${esc(firstError ? `${firstError.label}: ${firstError.detail}` : 'Veja o passo com ✕ acima.')}</div>
    <div class="button-row">
      <button class="btn btn-secondary btn-sm" data-action="publish-subdomain">🔁 Tentar novamente</button>
    </div>
  </div>${warnings}`;
}

async function publishSubdomain(button) {
  const hostname = currentHostname();
  const errorNode = el('publish-error');
  errorNode.textContent = '';

  if (!hostname || !hostname.includes('.')) {
    errorNode.textContent = 'Digite o subdomínio e escolha o domínio.';
    el('publish-subdomain').focus();
    return;
  }

  const port = el('publish-port').value.trim();
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    errorNode.textContent = 'Informe uma porta local válida (1–65535).';
    el('publish-port').focus();
    return;
  }

  const tunnelMode = document.querySelector('input[name="tunnel-mode"]:checked').value;
  const payload = {
    subdomain: hostname,
    domain: '',
    port,
    scheme: el('publish-scheme').value,
    path: el('publish-path').value.trim(),
    tunnelMode,
    tunnelName: el('publish-tunnel-name').value.trim(),
    existingTunnel: el('publish-existing-tunnel').value,
    createDns: el('publish-create-dns').checked,
    startService: el('publish-start-service').checked,
    enableAutostart: el('publish-autostart').checked,
  };

  if (tunnelMode === 'existing' && !payload.existingTunnel) {
    errorNode.textContent = 'Escolha o túnel que vai receber o subdomínio.';
    return;
  }

  publishState.steps = [];
  publishState.lastResult = null;
  el('publish-result').innerHTML = '';
  renderTimeline();

  busy(button, true, 'Publicando…');
  const res = await ctmApi.publishSubdomain(payload);
  busy(button, false);

  publishState.lastResult = res;
  if (Array.isArray(res.steps) && res.steps.length) publishState.steps = res.steps;
  renderTimeline();
  renderPublishResult(res);

  if (res.ok) {
    toast(`${res.hostname} publicado.`, 'success', 8000);
    await refresh({ silent: true });
    await loadZones();
  } else {
    const firstError = publishState.steps.find((step) => step.state === 'error');
    toast(firstError ? `${firstError.label}: ${firstError.detail}` : 'Não foi possível publicar.', 'error', 14000);
  }
}

async function retestHostname(hostname) {
  if (!hostname) return;
  const res = await ctmApi.checkHostname(hostname);
  if (!res.ok) return toast(`Falha ao testar: ${res.error}`, 'error');
  const dns = res.dns || {};
  if (dns.resolves) toast(`${hostname} resolve para ${dns.target || 'um endereço'}.`, 'success', 8000);
  else toast(`${hostname} ainda não resolve no DNS.`, 'warning', 8000);
}

// ------------------------------------------------------------------- serviço

function renderServiceState() {
  const name = el('select-service').value;
  const box = el('service-state');
  const hint = el('service-mode-hint');
  if (!name) {
    box.innerHTML = '<p class="hint-line">Selecione um túnel.</p>';
    return;
  }

  const tunnel = findTunnel(name);
  if (!tunnel) {
    box.innerHTML = '<p class="hint-line">Túnel não encontrado.</p>';
    return;
  }

  const service = tunnel.service || {};
  const rows = [
    ['Unidade', service.unit || '—'],
    ['Estado', service.detail || service.state || '—'],
    ['Modo', service.mode === 'system' ? 'systemd (sistema)' : service.mode === 'user' ? 'systemd (usuário)' : (service.mode || '—')],
    ['Config', tunnel.config.exists ? tunnel.config.path : 'ausente'],
    ['Credenciais', tunnel.credentials.exists ? tunnel.credentials.path : 'ausentes'],
    ['Rotas', String(tunnel.config.routes ? tunnel.config.routes.length : 0)],
  ];

  box.innerHTML = `<div class="kv-list">${rows.map(([key, value]) => (
    `<div class="kv-row"><span>${esc(key)}</span><code>${esc(value)}</code></div>`
  )).join('')}</div>${tunnel.warnings.length
    ? `<ul class="warn-list">${tunnel.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
    : ''}`;

  const mode = state.overview ? state.overview.serviceMode : 'user';
  hint.textContent = mode === 'system'
    ? 'Modo sistema: cada ação usa /etc/systemd/system e pede autenticação administrativa (pkexec/sudo).'
    : 'Modo usuário: unidades em ~/.config/systemd/user, sem senha; o linger é ativado para subir no boot.';
}

async function loadServiceView() {
  renderServiceState();
  if (el('select-service').value) {
    await refreshServiceLogs({ follow: false });
  }
}

async function refreshServiceLogs({ follow = false } = {}) {
  const name = el('select-service').value;
  if (!name) return;
  const consoleNode = el('service-console');
  const lines = Number(el('logs-lines').value) || 200;

  if (follow) {
    setConsole(consoleNode, `Acompanhando logs de ${name}…\n`);
    const res = await ctmApi.followLogs(name, Math.min(lines, 200));
    if (!res.ok) {
      toast(`Não foi possível acompanhar: ${res.error}`, 'error');
      return;
    }
    state.followingLogs = true;
    return;
  }

  const res = await ctmApi.serviceLogs(name, lines);
  setConsole(consoleNode, res.logs || 'Sem entradas de log.');
  if (res.needsPrivilege) {
    toast('Os logs do sistema podem exigir privilégio. Se vier vazio, rode o app como o usuário dono do serviço.', 'warning', 9000);
  }
}

async function serviceAction(action, button) {
  const name = el('select-service').value;
  if (!name) return toast('Selecione um túnel.', 'warning');

  const label = button ? button.textContent : 'a ação';
  busy(button, true, 'Executando…');
  let res;
  switch (action) {
    case 'start': res = await ctmApi.startService(name); break;
    case 'stop': res = await ctmApi.stopService(name); break;
    case 'restart': res = await ctmApi.restartService(name); break;
    case 'enable': res = await ctmApi.enableService(name); break;
    case 'disable': res = await ctmApi.disableService(name); break;
    case 'remove': res = await ctmApi.removeServiceUnit(name); break;
    default: res = { ok: false, error: 'Ação desconhecida.' };
  }
  busy(button, false);

  if (res.ok) {
    const lingerNote = res.linger && res.linger.ok === false ? `\nAviso: ${res.linger.error}` : '';
    toast(`${label.trim()} concluído.${lingerNote}`, lingerNote ? 'warning' : 'success', lingerNote ? 12000 : 4000);
  } else {
    toast(`Falha: ${res.error}`, 'error', 12000);
  }
  await refresh({ silent: true });
  renderServiceState();
}

async function runTunnel(action, button) {
  const name = el('select-service').value;
  if (!name) return toast('Selecione um túnel.', 'warning');
  const consoleNode = el('run-console');

  if (action === 'start') {
    busy(button, true, 'Iniciando…');
    const res = await ctmApi.startRun(name);
    busy(button, false);
    if (!res.ok) return toast(`Falha ao executar: ${res.error}`, 'error', 12000);
    state.runningTunnel = name;
    setConsole(consoleNode, `Executando ${name} em modo manual…\n`);
    return;
  }

  if (action === 'stop') {
    const res = await ctmApi.stopRun(name);
    if (!res.ok) toast(`Falha ao encerrar: ${res.error}`, 'error');
    state.runningTunnel = null;
    return;
  }

  setConsole(consoleNode, 'Console limpo.');
}

// -------------------------------------------------------------- configurações

function renderSettings() {
  const env = state.env || {};
  const cli = state.overview ? state.overview.cli : {};
  el('settings-cli').innerHTML = [
    ['Instalado', cli.installed ? 'sim' : 'não'],
    ['Versão', cli.version || '—'],
    ['Binário', cli.binary || '—'],
    ['Autenticado', cli.authenticated ? 'sim (cert.pem encontrado)' : 'não'],
    ['Diretório', cli.configDir || env.configDir || '—'],
  ].map(([key, value]) => `<div class="kv-row"><span>${esc(key)}</span><code>${esc(value)}</code></div>`).join('');

  const modes = (state.caps && state.caps.modes) || [];
  el('service-modes').innerHTML = modes.map((mode) => {
    const checked = (state.caps.current === mode.mode) ? 'checked' : '';
    const disabled = mode.available ? '' : 'disabled';
    return `<label class="mode-option ${mode.available ? '' : 'disabled'}">
      <input type="radio" name="service-mode" value="${esc(mode.mode)}" ${checked} ${disabled}>
      <div>
        <strong>${esc(mode.label)}</strong>
        <div class="hint-line">${mode.available
          ? (mode.mode === 'system'
            ? 'Unidades em /etc/systemd/system (como no script bash). Exige autenticação administrativa.'
            : 'Unidades em ~/.config/systemd/user + linger. Sem senha, sobe no boot.')
          : esc(mode.reason || 'Indisponível neste sistema.')}</div>
      </div>
    </label>`;
  }).join('');

  const privilege = env.privilege;
  el('settings-about').innerHTML = [
    ['Plataforma', `${env.platformLabel || env.platform} (${env.arch})`],
    ['Modo do serviço', state.caps ? state.caps.current : '—'],
    ['Elevação', privilege ? `${privilege.method}${privilege.hasPkexec ? ' · pkexec' : ''}` : '—'],
    ['Home', env.homedir || '—'],
  ].map(([key, value]) => `<div class="kv-row"><span>${esc(key)}</span><code>${esc(value)}</code></div>`).join('');
}

async function loadCapabilities() {
  const res = await ctmApi.serviceCapabilities();
  if (res.ok) {
    state.caps = res;
    if (state.view === 'settings') renderSettings();
  }
}

// ------------------------------------------------------------------- eventos

function setupEventBridge() {
  ctmApi.onEvent(({ channel, payload }) => {
    if (channel === 'task:output') {
      const { id, text } = payload;
      if (id && id.startsWith('run:') && id === `run:${el('select-service').value}`) {
        setConsole(el('run-console'), text, { append: true });
      }
      if (id && id.startsWith('logs:')) {
        setConsole(el('service-console'), text, { append: true });
      }
      if (id === 'install') {
        setConsole(el('install-console'), text, { append: true });
      }
      return;
    }

    if (channel === 'task:state') {
      const { id, state: taskState, code, error } = payload;
      if (id && id.startsWith('run:') && taskState !== 'running') {
        setConsole(el('run-console'),
          `\n[processo encerrado${code !== undefined && code !== null ? ` com código ${code}` : ''}${error ? `: ${error}` : ''}]\n`,
          { append: true });
        state.runningTunnel = null;
      }
      if (id && id.startsWith('logs:') && taskState !== 'running') {
        state.followingLogs = false;
      }
      return;
    }

    if (channel === 'cli:login:output') {
      setConsole(el('login-console'), payload.text, { append: true });
      return;
    }
    if (channel === 'cli:login:url') {
      const link = el('login-url');
      link.textContent = payload.url;
      link.dataset.url = payload.url;
      return;
    }
    if (channel === 'publish:step') {
      const { id } = payload;
      const index = publishState.steps.findIndex((step) => step.id === id);
      if (index === -1) publishState.steps.push(payload);
      else publishState.steps[index] = payload;
      renderTimeline();
      return;
    }
    if (channel === 'publish:done') {
      publishState.lastResult = payload;
      if (Array.isArray(payload.steps)) publishState.steps = payload.steps;
      renderTimeline();
      renderPublishResult(payload);
      return;
    }

    if (channel === 'cli:install:progress') {
      const node = el('install-console');
      if (payload.message) setConsole(node, `${payload.message}\n`, { append: true });
      if (payload.percent !== undefined && payload.percent !== null) {
        node.dataset.percent = payload.percent;
      }
    }
  });
}

// -------------------------------------------------------------------- ações

async function handleAction(action, button) {
  const dataset = button ? button.dataset : {};

  switch (action) {
    // navegação / ambiente
    case 'refresh':
      busy(button, true, 'Atualizando…');
      await refresh();
      await loadCapabilities();
      busy(button, false);
      toast('Estado atualizado.', 'info', 2000);
      return;
    case 'goto-create':
      state.editorDirty = false;
      switchView('create');
      el('publish-subdomain').focus();
      return;
    case 'open-config-dir':
      await ctmApi.openConfigDir();
      return;
    case 'open-backup-dir': {
      const info = await ctmApi.pathInfo();
      if (info.ok) await ctmApi.openPath(info.backpackDir);
      return;
    }
    case 'orphan-open':
      await ctmApi.openPath(dataset.path);
      return;
    case 'orphan-remove': {
      const ok = await confirmAction({
        title: 'Remover configuração órfã',
        message: `O arquivo ${dataset.name}.yml será apagado de ~/.cloudflared.\nO túnel remoto não é afetado (ele já não existe).`,
      });
      if (!ok) return;
      const res = await ctmApi.removeOrphanConfig(dataset.path);
      if (!res.ok) return toast(`Falha ao remover: ${res.error}`, 'error', 10000);
      toast(`Arquivo ${dataset.name}.yml removido.`, 'success');
      await refresh({ silent: true });
      return;
    }

    // novo subdomínio
    case 'publish-subdomain':
      await publishSubdomain(button);
      return;
    case 'publish-test-local':
      await testLocalService();
      return;
    case 'open-url':
      if (dataset.url) await ctmApi.openExternal(dataset.url);
      return;
    case 'retest-hostname':
      await retestHostname(dataset.hostname);
      return;

    // editor
    case 'refresh-editor':
      await loadEditor();
      return;
    case 'scaffold-config':
      await scaffoldConfig();
      return;
    case 'validate-editor':
      await validateEditor();
      return;
    case 'save-editor':
      busy(button, true, 'Salvando…');
      await saveEditor();
      busy(button, false);
      return;
    case 'quick-add-route': {
      const name = el('select-editor').value;
      if (!name) return toast('Selecione um túnel.', 'warning');
      const hostname = el('quick-hostname').value.trim();
      const port = el('quick-port').value.trim();
      const scheme = el('quick-scheme').value;
      if (!hostname || !port) return toast('Informe hostname e porta.', 'warning');
      const res = await ctmApi.addRoute(name, { hostname, port, scheme });
      if (!res.ok) return toast(`Falha: ${res.error}`, 'error', 10000);
      el('quick-hostname').value = '';
      el('quick-port').value = '';
      toast('Rota inserida no YAML e validada.', 'success');
      await refresh({ silent: true });
      await loadEditor({ silent: true });
      return;
    }
    case 'route-remove': {
      const name = el('select-editor').value;
      if (!name) return;
      const ok = await confirmAction({
        title: 'Remover rota',
        message: `Remover a rota ${dataset.hostname || `#${Number(dataset.index) + 1}`} do YAML?`,
      });
      if (!ok) return;
      const res = await ctmApi.removeRoute(name, {
        hostname: dataset.hostname || null,
        index: dataset.hostname ? null : Number(dataset.index),
      });
      if (!res.ok) return toast(`Falha: ${res.error}`, 'error', 10000);
      toast('Rota removida.', 'success');
      await refresh({ silent: true });
      await loadEditor({ silent: true });
      return;
    }
    case 'restore-backup': {
      const name = el('select-editor').value;
      const file = el('select-backup').value;
      if (!name || !file) return toast('Escolha um backup.', 'warning');
      const ok = await confirmAction({
        title: 'Restaurar backup',
        message: 'O conteúdo atual do YAML será substituído pelo backup escolhido.',
        danger: false,
      });
      if (!ok) return;
      const res = await ctmApi.restoreBackup(name, file);
      if (!res.ok) return toast(`Falha ao restaurar: ${res.error}`, 'error', 10000);
      toast('Backup restaurado.', 'success');
      await loadEditor({ silent: true });
      return;
    }

    // dns
    case 'create-dns': {
      const tunnel = el('select-dns').value;
      const raw = el('dns-hostnames').value;
      const hostnames = raw.split(/[\n,]/).map((line) => line.trim()).filter(Boolean);
      if (!tunnel) return toast('Selecione um túnel.', 'warning');
      if (!hostnames.length) return toast('Informe ao menos um hostname.', 'warning');

      busy(button, true, 'Criando…');
      const res = await ctmApi.routeDns({ tunnel, hostnames });
      busy(button, false);

      const results = res.results || [];
      el('dns-results').innerHTML = results.length
        ? `<div class="route-table">${results.map((entry) => `<div class="route-row">
            <div class="route-main"><strong>${esc(entry.hostname)}</strong>
              <span class="hint-line">${entry.ok ? 'CNAME criado' : esc(entry.error)}</span></div>
            <span class="badge ${entry.ok ? 'badge-active' : 'badge-error'}">${entry.ok ? 'ok' : 'erro'}</span>
          </div>`).join('')}</div>`
        : '';
      toast(res.ok ? 'Registros DNS criados.' : `Alguns registros falharam:\n${res.error}`,
        res.ok ? 'success' : 'error', res.ok ? 4000 : 12000);
      if (res.ok) el('dns-hostnames').value = '';
      return;
    }

    // serviço
    case 'refresh-service':
      await refresh({ silent: true });
      renderServiceState();
      toast('Estado atualizado.', 'info', 2000);
      return;
    case 'service-start': await serviceAction('start', button); return;
    case 'service-stop': await serviceAction('stop', button); return;
    case 'service-restart': await serviceAction('restart', button); return;
    case 'service-enable': await serviceAction('enable', button); return;
    case 'service-disable': await serviceAction('disable', button); return;
    case 'service-remove': {
      const name = el('select-service').value;
      if (!name) return toast('Selecione um túnel.', 'warning');
      const ok = await confirmAction({
        title: 'Remover unidade do serviço',
        message: `A unidade do systemd/launchd de "${name}" será removida.\nO túnel e o YAML continuam intactos; você pode recriar a unidade depois.`,
      });
      if (!ok) return;
      await serviceAction('remove', null);
      return;
    }
    case 'run-start': await runTunnel('start', button); return;
    case 'run-stop': await runTunnel('stop', button); return;
    case 'run-clear': setConsole(el('run-console'), 'Console limpo.'); return;
    case 'logs-snapshot': await refreshServiceLogs({ follow: false }); return;
    case 'logs-follow': await refreshServiceLogs({ follow: true }); return;
    case 'logs-unfollow': {
      const name = el('select-service').value;
      if (name) await ctmApi.unfollowLogs(name);
      state.followingLogs = false;
      toast('Acompanhamento encerrado.', 'info', 2500);
      return;
    }

    // cards do dashboard
    case 'card-start':
    case 'card-stop':
    case 'card-restart': {
      const name = dataset.tunnel;
      busy(button, true, '…');
      const res = action === 'card-start'
        ? await ctmApi.startService(name)
        : action === 'card-stop'
          ? await ctmApi.stopService(name)
          : await ctmApi.restartService(name);
      busy(button, false);
      if (!res.ok) toast(`Falha: ${res.error}`, 'error', 12000);
      else toast(`${name}: ação concluída.`, 'success', 3000);
      await refresh({ silent: true });
      return;
    }
    case 'card-editor':
      state.selection.editor = dataset.tunnel;
      switchView('editor');
      await loadEditor();
      return;
    case 'card-logs':
      state.selection.service = dataset.tunnel;
      switchView('service');
      el('select-service').value = dataset.tunnel;
      await loadServiceView();
      return;
    case 'card-delete': {
      const name = dataset.tunnel;
      const ok = await confirmAction({
        title: `Excluir túnel ${name}`,
        message: `Isto apaga o túnel "${name}" da conta Cloudflare, encerra as conexões e remove o YAML e as credenciais locais.\nOs registros DNS antigos NÃO são removidos automaticamente.\n\nDigite EXCLUIR para confirmar.`,
        word: 'EXCLUIR',
      });
      if (!ok) return;
      busy(button, true, 'Excluindo…');
      const res = await ctmApi.deleteTunnel({ id: dataset.id, name, removeFiles: true });
      busy(button, false);
      if (!res.ok) toast(`Falha ao excluir: ${res.error}`, 'error', 12000);
      else toast(`Túnel "${name}" excluído.`, 'success');
      await refresh({ silent: true });
      return;
    }

    // configurações
    case 'install-cli': {
      busy(button, true, 'Instalando…');
      const node = el('install-console');
      setConsole(node, 'Baixando e instalando cloudflared…\n');
      const res = await ctmApi.install();
      busy(button, false);
      if (!res.ok) {
        setConsole(node, `\nFalhou: ${res.error}\n`, { append: true });
        toast(`Falha na instalação: ${res.error}`, 'error', 14000);
      } else {
        setConsole(node, `\nInstalado: ${res.version || 'ok'}\n`, { append: true });
        toast('cloudflared instalado/atualizado.', 'success');
      }
      await refresh({ silent: true });
      return;
    }
    case 'uninstall-cli': {
      const ok = await confirmAction({
        title: 'Desinstalar cloudflared',
        message: 'O pacote cloudflared será removido do sistema.\nTúneis remotos, YAMLs e credenciais em ~/.cloudflared são preservados.\n\nDigite REMOVER para confirmar.',
        word: 'REMOVER',
      });
      if (!ok) return;
      busy(button, true, 'Removendo…');
      await ctmApi.removeAllUnits();
      const res = await ctmApi.uninstall();
      busy(button, false);
      if (!res.ok) toast(`Falha: ${res.error}`, 'error', 12000);
      else toast(`cloudflared removido.${res.note ? ` ${res.note}` : ''}`, 'success', 9000);
      await refresh({ silent: true });
      return;
    }
    case 'login':
      await startLogin();
      return;
    case 'backup-default': {
      busy(button, true, 'Gerando…');
      const res = await ctmApi.backup();
      busy(button, false);
      if (!res.ok) return toast(`Falha no backup: ${res.error}`, 'error', 10000);
      toast(`Backup criado em ${res.path}\n${res.warning || ''}`, 'success', 12000);
      return;
    }
    case 'backup-choose': {
      const info = await ctmApi.defaultBackupPath();
      const chosen = await ctmApi.saveDialog({
        title: 'Salvar backup',
        defaultPath: info.ok ? info.file : undefined,
        filters: [{ name: 'Arquivo tar.gz', extensions: ['gz'] }],
      });
      if (!chosen.ok) return;
      const res = await ctmApi.backup(chosen.filePath);
      if (!res.ok) return toast(`Falha no backup: ${res.error}`, 'error', 10000);
      toast(`Backup criado em ${res.path}`, 'success', 10000);
      return;
    }
    case 'remove-all-units': {
      const ok = await confirmAction({
        title: 'Remover todas as unidades',
        message: 'Todas as unidades de serviço criadas por este app serão paradas e removidas.\nTúneis e arquivos em ~/.cloudflared são preservados.\n\nDigite REMOVER para confirmar.',
        word: 'REMOVER',
      });
      if (!ok) return;
      busy(button, true, 'Removendo…');
      const res = await ctmApi.removeAllUnits();
      busy(button, false);
      toast(res.ok ? `Unidades removidas: ${res.removed.length}` : `Falha: ${res.error}`,
        res.ok ? 'success' : 'error');
      await refresh({ silent: true });
      return;
    }

    // modais
    case 'confirm-ok':
      closeConfirm(true);
      return;
    case 'confirm-cancel':
      closeConfirm(false);
      return;
    case 'login-cancel':
      await ctmApi.cancelLogin();
      el('modal-login').classList.remove('active');
      toast('Login cancelado.', 'info', 3000);
      return;

    default:
      console.warn('Ação não tratada:', action);
  }
}

// --------------------------------------------------------------------- login

async function startLogin() {
  el('modal-login').classList.add('active');
  setConsole(el('login-console'), 'Iniciando cloudflared tunnel login…\n');
  const link = el('login-url');
  link.textContent = 'aguardando…';
  delete link.dataset.url;

  const res = await ctmApi.login();
  el('modal-login').classList.remove('active');
  if (res.ok) {
    toast('Autenticado com sucesso (cert.pem atualizado).', 'success');
    await refresh({ silent: true });
  } else {
    toast(`Login não concluído: ${res.error}`, 'error', 12000);
  }
}

// --------------------------------------------------------------------- boot

function setupDelegation() {
  document.addEventListener('click', (event) => {
    const navItem = event.target.closest('.nav-item');
    if (navItem && navItem.dataset.view) {
      switchView(navItem.dataset.view);
      return;
    }

    const loginLink = event.target.closest('#login-url');
    if (loginLink) {
      event.preventDefault();
      if (loginLink.dataset.url) ctmApi.openExternal(loginLink.dataset.url);
      return;
    }

    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    event.preventDefault();
    handleAction(actionEl.dataset.action, actionEl).catch((error) => {
      console.error('Falha na ação', actionEl.dataset.action, error);
      toast(`Erro inesperado: ${error.message}`, 'error', 10000);
    });
  });

  el('editor-content').addEventListener('input', () => {
    state.editorDirty = true;
  });

  el('select-editor').addEventListener('change', () => loadEditor());
  el('select-service').addEventListener('change', () => {
    state.selection.service = el('select-service').value;
    renderServiceState();
    if (state.followingLogs) refreshServiceLogs({ follow: true });
  });
  el('select-dns').addEventListener('change', () => {
    state.selection.dns = el('select-dns').value;
  });

  el('confirm-typed').addEventListener('input', () => {
    const word = el('confirm-typed-word').textContent;
    el('confirm-ok').disabled = el('confirm-typed').value.trim() !== word;
  });

  el('publish-subdomain').addEventListener('input', updateHostnamePreview);
  el('publish-subdomain').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleAction('publish-subdomain', el('btn-publish'));
  });
  el('publish-domain').addEventListener('change', () => {
    const isCustom = el('publish-domain').value === '__custom__';
    el('publish-domain-custom').classList.toggle('hidden', !isCustom);
    if (isCustom) el('publish-domain-custom').focus();
    updateHostnamePreview();
  });
  el('publish-domain-custom').addEventListener('input', updateHostnamePreview);
  el('publish-port').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleAction('publish-subdomain', el('btn-publish'));
  });

  document.querySelectorAll('input[name="tunnel-mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const isExisting = document.querySelector('input[name="tunnel-mode"]:checked').value === 'existing';
      el('publish-existing-tunnel').disabled = !isExisting;
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (el('modal-confirm').classList.contains('active')) closeConfirm(false);
      if (el('modal-login').classList.contains('active')) handleAction('login-cancel');
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.name === 'service-mode') {
      const mode = event.target.value;
      ctmApi.setServiceMode(mode).then(async (res) => {
        if (!res.ok) return toast(`Falha ao trocar o modo: ${res.error}`, 'error');
        state.caps = res;
        toast(`Modo do serviço: ${res.mode === 'system' ? 'sistema' : 'usuário'}`, 'success', 4000);
        await refresh({ silent: true });
        renderSettings();
      });
    }
  });
}

async function boot() {
  const appInfo = await ctmApi.appInfo();
  if (appInfo.ok) el('brand-version').textContent = `v${appInfo.version}`;

  setupDelegation();
  setupEventBridge();

  el('publish-existing-tunnel').disabled = true;

  await refresh();
  await loadZones();
  await loadCapabilities();
  startAutoRefresh();
}

boot().catch((error) => {
  console.error('Falha no boot do renderer:', error);
  toast(`Falha ao iniciar a interface: ${error.message}`, 'error', 0);
});
