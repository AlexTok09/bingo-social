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
  } catch (error) {
    loginError.textContent = error.message;
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

      const labelCell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
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
      row.appendChild(labelCell);
      row.appendChild(actionCell);
      rowsEl.appendChild(row);
    });
  });
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
    const label = row.querySelector('input[type="text"]').value.trim();
    if (!label) return;
    const existing = categories[originalTier]?.[originalIndex];
    next[tier].push({
      id: existing?.id || `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      label,
    });
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
