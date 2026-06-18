const TIERS = ['ordinaire', 'semi', 'rare', 'legendaire'];
const TIER_LABELS = {
  ordinaire: 'Ordinaire',
  semi: 'Semi-ordinaire',
  rare: 'Rare',
  legendaire: 'Légendaire',
};

const loginPanel = document.querySelector('#login-panel');
const adminPanel = document.querySelector('#admin-panel');
const passwordInput = document.querySelector('#admin-password');
const loginError = document.querySelector('#admin-login-error');
const rowsEl = document.querySelector('#admin-category-rows');
const statusEl = document.querySelector('#admin-status');
const statsEl = document.querySelector('#admin-stats');
const qrStatsEl = document.querySelector('#admin-qr-stats');
const gridsListEl = document.querySelector('#admin-grids-list');
const applyActiveInput = document.querySelector('#apply-active');
const btnLogin = document.querySelector('#btn-login');
const btnAddRow = document.querySelector('#btn-add-row');
const btnSave = document.querySelector('#btn-save-admin');
const btnReset = document.querySelector('#btn-reset-admin');

let adminPassword = localStorage.getItem('binglou_admin_password') || '';
let categories = {};

if (adminPassword) {
  passwordInput.value = adminPassword;
  loadCategories();
}

btnLogin.addEventListener('click', () => {
  adminPassword = passwordInput.value;
  localStorage.setItem('binglou_admin_password', adminPassword);
  loadCategories();
});

passwordInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') btnLogin.click();
});

btnAddRow.addEventListener('click', () => {
  categories.ordinaire.push({ id: `custom-${Date.now()}`, label: '' });
  renderRows();
  const lastInput = rowsEl.querySelector('tr:last-child input[type="text"]');
  if (lastInput) lastInput.focus();
});

btnSave.addEventListener('click', saveCategories);

btnReset.addEventListener('click', async () => {
  if (!confirm('Remettre toutes les catégories par défaut ?')) return;
  const data = await adminFetch('/api/admin/reset-categories', {
    method: 'POST',
    body: JSON.stringify({ resetRooms: applyActiveInput.checked }),
  });
  categories = data.categories;
  renderRows();
  setStatus(data.resetRooms ? 'Catégories réinitialisées et parties en cours relancées.' : 'Catégories réinitialisées.');
});

async function loadCategories() {
  loginError.textContent = '';
  try {
    categories = await adminFetch('/api/admin/categories');
    loginPanel.hidden = true;
    adminPanel.hidden = false;
    renderRows();
    setStatus('Connecté.');
    loadStats();
    loadAdminGrids();
  } catch (error) {
    loginError.textContent = error.message;
  }
}

function formatCount(value) {
  return Number(value || 0).toLocaleString('fr-FR');
}

function formatDuration(ms) {
  const totalSec = Math.round(Number(ms || 0) / 1000);
  if (totalSec <= 0) return '—';
  if (totalSec < 60) return `${totalSec} s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec ? `${min} min ${String(sec).padStart(2, '0')}` : `${min} min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `${h} h ${String(rem).padStart(2, '0')}` : `${h} h`;
}

function formatPercent(ratio) {
  return `${Math.round(Number(ratio || 0) * 100)} %`;
}

function metricGroup(parent, title, items) {
  const group = document.createElement('div');
  group.className = 'admin-metric-group';
  if (title) {
    const heading = document.createElement('h3');
    heading.textContent = title;
    group.appendChild(heading);
  }
  const grid = document.createElement('div');
  grid.className = 'admin-metric-grid';
  items.forEach(([value, label]) => appendMetric(grid, label, value));
  group.appendChild(grid);
  parent.appendChild(group);
}

async function loadStats() {
  if (!statsEl) return;
  try {
    const s = await adminFetch('/api/admin/stats');
    const since = s.firstAt ? new Date(s.firstAt).toLocaleDateString('fr-FR') : '—';
    const v = s.visitors || {};
    const g = s.gameplay || {};

    statsEl.innerHTML = '';
    const title = document.createElement('h2');
    title.textContent = 'Tableau de bord';
    statsEl.appendChild(title);
    const caption = document.createElement('p');
    caption.className = 'admin-stat-caption';
    caption.textContent = `Depuis le ${since}`;
    statsEl.appendChild(caption);

    metricGroup(statsEl, '🎲 Parties', [
      [formatCount(g.started ?? s.gamesPlayed), 'lancées'],
      [formatCount(g.finished ?? s.gamesFinished), 'terminées'],
      [formatPercent(g.completionRate), 'taux de complétion'],
      [formatDuration(g.avgDurationMs), 'durée moyenne'],
      [formatDuration(g.fastestMs), 'partie éclair'],
      [g.avgPlayers ? g.avgPlayers.toFixed(1) : '—', 'joueurs / partie'],
    ]);

    metricGroup(statsEl, '🟢 En direct', [
      [formatCount(s.activeRooms), 'salons actifs'],
      [formatCount(s.activePlayers), 'joueurs en ligne'],
      [formatCount(s.customGrids), 'grilles custom'],
      [formatCount(s.customGridPlays), 'parties custom'],
    ]);

    metricGroup(statsEl, '👤 Visiteurs uniques', [
      [formatCount(v.total), 'total'],
      [formatCount(v.today), 'aujourd’hui'],
      [formatCount(v.newToday), 'nouveaux'],
      [formatCount(v.last7Days), '7 jours'],
      [formatCount(v.last30Days), '30 jours'],
      [formatCount(v.returning), 'revenus'],
      [formatCount(v.bots), 'bots écartés'],
    ]);

    statsEl.hidden = false;
    renderQrStats(s.qr);
  } catch {
    statsEl.hidden = true;
    if (qrStatsEl) qrStatsEl.hidden = true;
  }
}

function appendMetric(parent, label, value) {
  const item = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = value;
  const span = document.createElement('span');
  span.textContent = label;
  item.append(strong, span);
  parent.appendChild(item);
}

function appendRanking(parent, title, rows) {
  const block = document.createElement('div');
  block.className = 'admin-qr-ranking';
  const heading = document.createElement('h3');
  heading.textContent = title;
  block.appendChild(heading);

  if (!rows?.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Aucune donnée.';
    block.appendChild(empty);
    parent.appendChild(block);
    return;
  }

  rows.forEach(row => {
    const line = document.createElement('p');
    line.textContent = `${row.count} · ${row.value}`;
    block.appendChild(line);
  });
  parent.appendChild(block);
}

function renderQrStats(qr = {}) {
  if (!qrStatsEl) return;
  qrStatsEl.innerHTML = '';

  const title = document.createElement('h2');
  title.textContent = 'QR / Stickers';
  qrStatsEl.appendChild(title);

  const metrics = document.createElement('div');
  metrics.className = 'admin-qr-metrics';
  appendMetric(metrics, 'scans total', qr.total || 0);
  appendMetric(metrics, 'aujourd’hui', qr.today || 0);
  appendMetric(metrics, 'sur 7 jours', qr.last7Days || 0);
  appendMetric(metrics, 'humains probables', qr.likelyHuman || 0);
  appendMetric(metrics, 'bots probables', qr.likelyBot || 0);
  qrStatsEl.appendChild(metrics);

  appendRanking(qrStatsEl, 'Mobiles fréquents', qr.topMobileUserAgents || []);
  appendRanking(qrStatsEl, 'Referrers', qr.referrers || []);
  qrStatsEl.hidden = false;
}

async function loadAdminGrids() {
  if (!gridsListEl) return;
  gridsListEl.innerHTML = '<p class="muted">Chargement...</p>';
  try {
    const data = await adminFetch('/api/admin/custom-grids');
    const grids = data.grids || [];
    if (!grids.length) {
      gridsListEl.innerHTML = '<p class="muted">Aucune grille.</p>';
      return;
    }
    gridsListEl.innerHTML = '';
    grids.forEach(grid => {
      const hidden = grid.isPublic === false;
      const card = document.createElement('div');
      card.className = 'admin-grid-card';
      if (hidden) card.classList.add('is-hidden-grid');
      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = grid.name; // textContent: noms fournis par les joueurs
      const meta = document.createElement('span');
      meta.textContent = `${grid.plays || 0} parties${hidden ? ' · masquée' : ''}`;
      info.append(name, meta);

      const actions = document.createElement('div');
      actions.className = 'admin-grid-actions';
      const toggle = document.createElement('button');
      toggle.className = 'btn btn-secondary';
      toggle.textContent = hidden ? 'Afficher' : 'Masquer';
      toggle.addEventListener('click', () => toggleGridVisibility(grid));
      const del = document.createElement('button');
      del.className = 'btn btn-secondary';
      del.textContent = 'Supprimer';
      del.addEventListener('click', () => deleteGrid(grid));
      actions.append(toggle, del);

      card.append(info, actions);
      gridsListEl.appendChild(card);
    });
  } catch {
    gridsListEl.innerHTML = '<p class="muted">Impossible de charger les grilles.</p>';
  }
}

async function toggleGridVisibility(grid) {
  const makePublic = grid.isPublic === false;
  try {
    await adminFetch(`/api/admin/custom-grids/${encodeURIComponent(grid.code)}`, {
      method: 'PATCH',
      body: JSON.stringify({ isPublic: makePublic }),
    });
    setStatus(makePublic ? `Grille « ${grid.name} » affichée.` : `Grille « ${grid.name} » masquée.`);
    loadAdminGrids();
  } catch (error) {
    setStatus(error.message);
  }
}

async function deleteGrid(grid) {
  if (!confirm(`Supprimer la grille « ${grid.name} » ?`)) return;
  try {
    await adminFetch(`/api/admin/custom-grids/${encodeURIComponent(grid.code)}`, { method: 'DELETE' });
    setStatus(`Grille « ${grid.name} » supprimée.`);
    loadAdminGrids();
  } catch (error) {
    setStatus(error.message);
  }
}

async function saveCategories() {
  collectRows();
  const data = await adminFetch('/api/admin/categories', {
    method: 'PUT',
    body: JSON.stringify({
      categories,
      resetRooms: applyActiveInput.checked,
    }),
  });
  categories = data.categories;
  renderRows();
  setStatus(data.resetRooms ? 'Sauvegardé. Parties en cours relancées.' : 'Sauvegardé.');
}

function renderRows() {
  rowsEl.innerHTML = '';
  TIERS.forEach(tier => {
    (categories[tier] || []).forEach((item, index) => {
      const row = document.createElement('tr');
      row.dataset.tier = tier;
      row.dataset.index = index;

      const tierCell = document.createElement('td');
      const select = document.createElement('select');
      TIERS.forEach(optionTier => {
        const option = document.createElement('option');
        option.value = optionTier;
        option.textContent = TIER_LABELS[optionTier];
        option.selected = optionTier === tier;
        select.appendChild(option);
      });
      tierCell.appendChild(select);

      const emojiCell = document.createElement('td');
      const emojiInput = document.createElement('input');
      emojiInput.type = 'text';
      emojiInput.className = 'admin-emoji-input';
      emojiInput.maxLength = 24;
      emojiInput.placeholder = 'Emoji';
      emojiInput.value = Array.isArray(item.emojis) ? item.emojis.join('') : '';
      emojiCell.appendChild(emojiInput);

      const labelCell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'admin-label-input';
      input.value = item.label;
      input.placeholder = 'Nom de catégorie';
      labelCell.appendChild(input);

      const actionCell = document.createElement('td');
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'admin-row-delete';
      del.textContent = 'Suppr.';
      del.addEventListener('click', () => {
        categories[tier].splice(index, 1);
        renderRows();
      });
      actionCell.appendChild(del);

      row.appendChild(tierCell);
      row.appendChild(emojiCell);
      row.appendChild(labelCell);
      row.appendChild(actionCell);
      rowsEl.appendChild(row);
    });
  });
}

function collectEmojiInput(value, existingEmojis = []) {
  const text = String(value || '').trim();
  if (Array.isArray(existingEmojis) && existingEmojis.join('') === text) return existingEmojis;
  return text ? [text] : [];
}

function collectRows() {
  const next = TIERS.reduce((acc, tier) => {
    acc[tier] = [];
    return acc;
  }, {});

  rowsEl.querySelectorAll('tr').forEach(row => {
    const originalTier = row.dataset.tier;
    const originalIndex = Number(row.dataset.index);
    const tier = row.querySelector('select').value;
    const label = row.querySelector('.admin-label-input').value.trim();
    if (!label) return;
    const existing = categories[originalTier]?.[originalIndex];
    const emojis = collectEmojiInput(row.querySelector('.admin-emoji-input')?.value, existing?.emojis);
    const item = {
      id: existing?.id || `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      label,
    };
    if (emojis.length) item.emojis = emojis;
    next[tier].push(item);
  });

  categories = next;
}

async function adminFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-password': adminPassword,
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Erreur admin.');
  return data;
}

function setStatus(message) {
  statusEl.textContent = message;
  window.clearTimeout(setStatus.timeout);
  setStatus.timeout = window.setTimeout(() => {
    if (statusEl.textContent === message) statusEl.textContent = '';
  }, 3500);
}
