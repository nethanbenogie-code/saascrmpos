// LysiPOS — SaaS · CRM · POS (single-file app)
// Vanilla JS ES module. IndexedDB storage, hash router, offline-first.

/* -------------------- utilities -------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = (p = '') => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const nowISO = () => new Date().toISOString();
const clone = (x) => JSON.parse(JSON.stringify(x));
const fmtDate = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };
const dayKey = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (strings, ...values) => strings.map((s, i) => s + (i < values.length ? String(values[i] ?? '') : '')).join('');

function money(n, s = state.settings) {
  const cur = (s && s.currency) || 'USD';
  const val = Number(n || 0);
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(val); }
  catch { return `${cur} ${val.toFixed(2)}`; }
}

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast-item ' + kind;
  t.textContent = msg;
  $('#toast').appendChild(t);
  setTimeout(() => { t.style.opacity = 0; t.style.transform = 'translateX(20px)'; }, 2400);
  setTimeout(() => t.remove(), 2800);
}

async function sha256(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* -------------------- modal -------------------- */
function openModal({ title, body, footer, size = 'md', onClose }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = html`
    <div class="modal" style="${size === 'lg' ? 'width:min(760px,100%)' : ''}">
      <div class="m-h"><h3 style="margin:0">${escapeHtml(title || '')}</h3><div style="flex:1"></div>
        <button class="btn small ghost" data-close>✕</button>
      </div>
      <div class="m-b" data-body></div>
      <div class="m-f" data-footer></div>
    </div>`;
  const modalRoot = $('#modal-root');
  modalRoot.appendChild(back);
  const bodyEl = $('[data-body]', back);
  const footEl = $('[data-footer]', back);
  if (body instanceof Node) bodyEl.appendChild(body); else bodyEl.innerHTML = body || '';
  if (footer instanceof Node) footEl.appendChild(footer); else footEl.innerHTML = footer || '';
  const close = () => { back.remove(); onClose && onClose(); };
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  $('[data-close]', back).addEventListener('click', close);
  return { close, back, bodyEl, footEl };
}

function confirmModal(message, { danger = false, okText = 'OK', cancelText = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const foot = document.createElement('div');
    foot.innerHTML = html`
      <button class="btn ghost" data-cancel>${escapeHtml(cancelText)}</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${escapeHtml(okText)}</button>`;
    const m = openModal({ title: 'Please confirm', body: `<div style="padding:6px 2px">${escapeHtml(message)}</div>`, footer: foot });
    $('[data-cancel]', foot).addEventListener('click', () => { m.close(); resolve(false); });
    $('[data-ok]', foot).addEventListener('click', () => { m.close(); resolve(true); });
  });
}

/* -------------------- IndexedDB layer -------------------- */
const DB_NAME = 'lysipos';
const DB_VER = 1;
const STORES = ['settings', 'users', 'products', 'categories', 'customers', 'sales', 'audit'];

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          const store = db.createObjectStore(s, { keyPath: s === 'settings' ? 'key' : 'id' });
          if (s === 'products') { store.createIndex('sku', 'sku', { unique: false }); store.createIndex('barcode', 'barcode', { unique: false }); }
          if (s === 'customers') { store.createIndex('email', 'email', { unique: false }); }
          if (s === 'sales') { store.createIndex('createdAt', 'createdAt', { unique: false }); }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let _db;
async function db() { if (!_db) _db = await openDB(); return _db; }

function tx(storeNames, mode = 'readonly') {
  return db().then((d) => d.transaction(storeNames, mode));
}

async function dbGet(store, key) {
  const t = await tx(store);
  return new Promise((res, rej) => { const r = t.objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function dbGetAll(store) {
  const t = await tx(store);
  return new Promise((res, rej) => { const r = t.objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function dbPut(store, value) {
  const t = await tx(store, 'readwrite');
  return new Promise((res, rej) => { const r = t.objectStore(store).put(value); r.onsuccess = () => res(value); r.onerror = () => rej(r.error); });
}
async function dbDel(store, key) {
  const t = await tx(store, 'readwrite');
  return new Promise((res, rej) => { const r = t.objectStore(store).delete(key); r.onsuccess = () => res(true); r.onerror = () => rej(r.error); });
}
async function dbClear(store) {
  const t = await tx(store, 'readwrite');
  return new Promise((res, rej) => { const r = t.objectStore(store).clear(); r.onsuccess = () => res(true); r.onerror = () => rej(r.error); });
}

/* -------------------- app state -------------------- */
const state = {
  user: null,
  users: [],
  products: [],
  categories: [],
  customers: [],
  sales: [],
  settings: null,
  cart: { items: [], discount: 0, customerId: null, note: '' },
  ui: { sidebarOpen: false }
};

const DEFAULT_SETTINGS = {
  key: 'app',
  businessName: 'LysiPOS Demo Store',
  address: '123 Market St, Springfield',
  phone: '+1 (555) 010-0000',
  email: 'hello@lysipos.local',
  currency: 'USD',
  taxRate: 8.5, // %
  taxInclusive: false,
  receiptFooter: 'Thank you for your business!',
  theme: 'dark',
  loyaltyPerCurrency: 1, // 1 point per 1 currency spent
  loyaltyRedeemValue: 0.01, // 1 point = 0.01 currency
  onboarded: false
};

async function loadAll() {
  const [settings, users, products, categories, customers, sales] = await Promise.all([
    dbGet('settings', 'app'),
    dbGetAll('users'), dbGetAll('products'), dbGetAll('categories'),
    dbGetAll('customers'), dbGetAll('sales')
  ]);
  state.settings = settings || DEFAULT_SETTINGS;
  state.users = users;
  state.products = products;
  state.categories = categories;
  state.customers = customers;
  state.sales = sales;
  document.documentElement.dataset.theme = state.settings.theme || 'dark';
}

async function saveSettings() {
  await dbPut('settings', state.settings);
  document.documentElement.dataset.theme = state.settings.theme || 'dark';
}

/* -------------------- audit -------------------- */
async function audit(action, meta = {}) {
  const entry = { id: uid('a_'), at: nowISO(), by: state.user?.id || null, byName: state.user?.name || 'system', action, meta };
  await dbPut('audit', entry);
}

/* -------------------- seeding -------------------- */
async function seedIfEmpty() {
  if (!(await dbGet('settings', 'app'))) await dbPut('settings', DEFAULT_SETTINGS);
  const users = await dbGetAll('users');
  if (users.length === 0) {
    const admin = { id: uid('u_'), name: 'Owner', email: 'admin@lysipos.local', role: 'admin', active: true, pin: '1234', passHash: await sha256('admin123'), createdAt: nowISO() };
    await dbPut('users', admin);
  }
  const cats = await dbGetAll('categories');
  if (cats.length === 0) {
    for (const name of ['Beverages', 'Bakery', 'Snacks', 'Grocery', 'Household']) {
      await dbPut('categories', { id: uid('c_'), name });
    }
  }
  const prods = await dbGetAll('products');
  if (prods.length === 0) {
    const catList = await dbGetAll('categories');
    const pick = (n) => catList.find(c => c.name === n)?.id;
    const seed = [
      ['Espresso', 3.5, 0.9, pick('Beverages'), 100, '8901000001', 'ESP-001'],
      ['Latte', 4.5, 1.2, pick('Beverages'), 80, '8901000002', 'LAT-001'],
      ['Iced Tea', 3.0, 0.6, pick('Beverages'), 60, '8901000003', 'ITE-001'],
      ['Croissant', 3.25, 1.0, pick('Bakery'), 40, '8901000004', 'CRO-001'],
      ['Bagel', 2.75, 0.7, pick('Bakery'), 35, '8901000005', 'BAG-001'],
      ['Muffin', 2.95, 0.8, pick('Bakery'), 30, '8901000006', 'MUF-001'],
      ['Chips', 2.25, 0.6, pick('Snacks'), 120, '8901000007', 'CHI-001'],
      ['Chocolate Bar', 1.95, 0.5, pick('Snacks'), 200, '8901000008', 'CHO-001'],
      ['Bottled Water', 1.5, 0.3, pick('Beverages'), 300, '8901000009', 'WAT-001'],
      ['Sandwich', 6.5, 2.2, pick('Bakery'), 20, '8901000010', 'SAN-001'],
      ['Bread Loaf', 4.25, 1.5, pick('Grocery'), 25, '8901000011', 'BRE-001'],
      ['Milk 1L', 3.15, 1.8, pick('Grocery'), 40, '8901000012', 'MIL-001'],
      ['Eggs (dozen)', 5.5, 2.5, pick('Grocery'), 30, '8901000013', 'EGG-001'],
      ['Paper Towels', 4.75, 1.9, pick('Household'), 50, '8901000014', 'PAP-001'],
      ['Dish Soap', 3.95, 1.5, pick('Household'), 35, '8901000015', 'DSH-001']
    ];
    for (const [name, price, cost, category, stock, barcode, sku] of seed) {
      await dbPut('products', {
        id: uid('p_'), name, price, cost, category, stock, barcode, sku,
        taxable: true, active: true, createdAt: nowISO()
      });
    }
  }
  const custs = await dbGetAll('customers');
  if (custs.length === 0) {
    const demo = [
      ['Alice Johnson', 'alice@example.com', '+1 555-0101', ['VIP']],
      ['Bob Smith', 'bob@example.com', '+1 555-0102', ['Regular']],
      ['Carla Diaz', 'carla@example.com', '+1 555-0103', ['New']]
    ];
    for (const [name, email, phone, tags] of demo) {
      await dbPut('customers', { id: uid('cu_'), name, email, phone, tags, address: '', notes: '', points: 0, interactions: [], createdAt: nowISO() });
    }
  }
}

/* -------------------- router -------------------- */
const routes = {};
function route(path, render, opts = {}) { routes[path] = { render, ...opts }; }

function currentPath() {
  const h = location.hash.replace(/^#/, '');
  return h || '/dashboard';
}

async function navigate(path) {
  if (!path.startsWith('/')) path = '/' + path;
  if (location.hash !== '#' + path) { location.hash = path; return; }
  await renderCurrent();
}

async function renderCurrent() {
  const path = currentPath();
  const view = $('#view');
  const key = Object.keys(routes).find(k => path === k || path.startsWith(k + '/')) || '/dashboard';
  const r = routes[key];
  if (!view) return;
  view.innerHTML = '<div class="page"><div class="muted">Loading…</div></div>';
  try {
    const rest = path.slice(key.length).replace(/^\//, '');
    const content = await r.render(rest);
    view.innerHTML = '';
    if (content instanceof Node) view.appendChild(content); else view.innerHTML = content || '';
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="page"><h1>Something went wrong</h1><pre class="muted">${escapeHtml(e.message)}</pre></div>`;
  }
  // Highlight active nav
  $$('.nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + key));
}

window.addEventListener('hashchange', renderCurrent);

/* -------------------- auth -------------------- */
async function login(email, password) {
  const users = await dbGetAll('users');
  const u = users.find(x => x.email.toLowerCase() === email.toLowerCase() && x.active !== false);
  if (!u) return { ok: false, error: 'Unknown email' };
  const h = await sha256(password);
  if (h !== u.passHash) return { ok: false, error: 'Wrong password' };
  state.user = u;
  sessionStorage.setItem('lysipos:uid', u.id);
  await audit('login', { email });
  return { ok: true };
}
function logout() {
  audit('logout');
  state.user = null;
  sessionStorage.removeItem('lysipos:uid');
  render();
}
async function restoreSession() {
  const id = sessionStorage.getItem('lysipos:uid');
  if (!id) return;
  const users = await dbGetAll('users');
  const u = users.find(x => x.id === id);
  if (u) state.user = u;
}
function requireRole(...roles) {
  return !!state.user && roles.includes(state.user.role);
}

/* -------------------- shell -------------------- */
function shell() {
  const initials = (state.user?.name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return html`
    <div class="layout">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <div class="brand-mark"></div>
          <div>
            <div class="brand-name">LysiPOS</div>
            <div class="brand-tag">SaaS · CRM · POS</div>
            <div class="brand-tag" style="opacity:.7">by Gieo Software</div>
          </div>
        </div>
        <div class="nav">
          <a href="#/dashboard">📊 Dashboard</a>
          <a href="#/pos">🧾 Point of Sale</a>
          <div class="section">Sell</div>
          <a href="#/sales">🧮 Sales</a>
          <a href="#/products">📦 Products</a>
          <a href="#/inventory">🗃️ Inventory</a>
          <div class="section">CRM</div>
          <a href="#/customers">👥 Customers</a>
          <a href="#/reports">📈 Reports</a>
          <div class="section">Admin</div>
          <a href="#/users">🔐 Users</a>
          <a href="#/settings">⚙️ Settings</a>
          <a href="manual.html" target="_blank" rel="noopener">📖 User Manual</a>
        </div>
        <div style="flex:1"></div>
        <button class="btn small ghost" id="themeBtn">🌓 Toggle theme</button>
        <button class="btn small ghost" id="installBtn" style="display:none">⤓ Install App</button>
      </aside>
      <div class="scrim" id="scrim"></div>
      <div class="main">
        <div class="topbar">
          <button class="btn small menu-btn" id="menuBtn">☰</button>
          <div class="pill">${escapeHtml(state.settings?.businessName || 'Business')}</div>
          <div class="pill" id="netStatus">${navigator.onLine ? '● Online' : '● Offline'}</div>
          <div class="spacer"></div>
          <div class="user">
            <div class="avatar">${escapeHtml(initials)}</div>
            <div style="line-height:1.1">
              <div style="font-size:12px">${escapeHtml(state.user?.name || '')}</div>
              <div class="muted" style="font-size:10px">${escapeHtml(state.user?.role || '')}</div>
            </div>
            <button class="btn small ghost" id="logoutBtn" title="Logout">⎋</button>
          </div>
        </div>
        <div id="view"></div>
      </div>
    </div>
  `;
}

function wireShell() {
  $('#logoutBtn')?.addEventListener('click', logout);
  $('#themeBtn')?.addEventListener('click', async () => {
    state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    await saveSettings();
  });
  $('#menuBtn')?.addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
    $('#scrim').classList.toggle('on');
  });
  $('#scrim')?.addEventListener('click', () => {
    $('#sidebar').classList.remove('open');
    $('#scrim').classList.remove('on');
  });
  window.addEventListener('online', () => $('#netStatus').textContent = '● Online');
  window.addEventListener('offline', () => $('#netStatus').textContent = '● Offline');

  if (deferredPrompt) $('#installBtn').style.display = '';
  $('#installBtn')?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice?.outcome === 'accepted') toast('App installed', 'good');
    deferredPrompt = null;
    $('#installBtn').style.display = 'none';
  });
}

/* -------------------- login screen -------------------- */
function renderLogin() {
  const app = $('#app');
  app.innerHTML = html`
    <div class="auth">
      <div class="box card">
        <div class="brand">
          <div class="brand-mark"></div>
          <div>
            <div class="brand-name">LysiPOS</div>
            <div class="brand-tag">Sign in to continue</div>
          </div>
        </div>
        <div class="card-b">
          <div class="field">
            <label>Email</label>
            <input id="loginEmail" type="email" value="admin@lysipos.local" autocomplete="username" />
          </div>
          <div class="field">
            <label>Password</label>
            <input id="loginPass" type="password" value="admin123" autocomplete="current-password" />
          </div>
          <button class="btn primary block" id="loginBtn">Sign in</button>
          <div class="muted" style="margin-top:10px;font-size:12px">
            Default account seeded on first run — change it in <b>Users</b> after signing in.
          </div>
        </div>
      </div>
    </div>`;
  $('#loginBtn').addEventListener('click', async () => {
    const email = $('#loginEmail').value.trim();
    const pass = $('#loginPass').value;
    const r = await login(email, pass);
    if (r.ok) { toast('Welcome back, ' + state.user.name, 'good'); render(); }
    else toast(r.error, 'bad');
  });
  $('#loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginBtn').click(); });
}

/* -------------------- render dispatch -------------------- */
async function render() {
  if (!state.user) { renderLogin(); return; }
  $('#app').innerHTML = shell();
  wireShell();
  await renderCurrent();
}

/* -------------------- pages -------------------- */

/* Dashboard */
route('/dashboard', async () => {
  const today = dayKey();
  const week = daysAgo(6);
  const salesToday = state.sales.filter(s => dayKey(s.createdAt) === today);
  const salesWeek = state.sales.filter(s => new Date(s.createdAt) >= week);
  const revToday = salesToday.reduce((n, s) => n + s.total, 0);
  const revWeek = salesWeek.reduce((n, s) => n + s.total, 0);
  const items = salesToday.reduce((n, s) => n + s.items.reduce((a, i) => a + i.qty, 0), 0);
  const avg = salesToday.length ? revToday / salesToday.length : 0;
  const lowStock = state.products.filter(p => (p.stock ?? 0) <= 5 && p.active !== false);

  // simple 7-day spark
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = dayKey(daysAgo(i));
    days.push({ d, v: state.sales.filter(s => dayKey(s.createdAt) === d).reduce((n, s) => n + s.total, 0) });
  }
  const maxV = Math.max(1, ...days.map(x => x.v));
  const spark = days.map((x, i) => {
    const h = Math.max(2, (x.v / maxV) * 60);
    return `<div title="${x.d}: ${money(x.v)}" style="flex:1;display:flex;align-items:flex-end"><div style="width:100%;height:${h}px;background:linear-gradient(180deg,var(--accent),var(--accent-2));border-radius:6px 6px 0 0"></div></div>`;
  }).join('');

  // top products this week
  const prodMap = {};
  for (const s of salesWeek) for (const li of s.items) {
    prodMap[li.productId] = (prodMap[li.productId] || 0) + li.qty;
  }
  const topProducts = Object.entries(prodMap).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([pid, q]) => ({ product: state.products.find(p => p.id === pid), qty: q }));

  return html`
    <div class="page">
      <h1>Dashboard</h1>
      <div class="sub">Overview of today's activity and this week.</div>
      <div class="grid cols-4" style="margin-bottom:14px">
        <div class="kpi"><div class="label">Today's Revenue</div><div class="value">${money(revToday)}</div><div class="delta">${salesToday.length} orders</div></div>
        <div class="kpi"><div class="label">Items Sold Today</div><div class="value">${items}</div><div class="delta">Avg ticket ${money(avg)}</div></div>
        <div class="kpi"><div class="label">Week Revenue</div><div class="value">${money(revWeek)}</div><div class="delta">${salesWeek.length} orders</div></div>
        <div class="kpi"><div class="label">Customers</div><div class="value">${state.customers.length}</div><div class="delta">${state.products.length} products</div></div>
      </div>
      <div class="grid cols-2">
        <div class="card">
          <div class="card-h"><h3>Last 7 days</h3></div>
          <div class="card-b">
            <div style="display:flex;gap:6px;height:80px;align-items:flex-end">${spark}</div>
            <div style="display:flex;gap:6px;color:var(--muted);font-size:11px;margin-top:6px">
              ${days.map(d => `<div style="flex:1;text-align:center">${d.d.slice(5)}</div>`).join('')}
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-h"><h3>Top products (7d)</h3></div>
          <div class="card-b">
            ${topProducts.length ? html`<table class="data"><thead><tr><th>Product</th><th class="right">Qty</th></tr></thead>
              <tbody>${topProducts.map(t => `<tr><td>${escapeHtml(t.product?.name || '—')}</td><td class="right mono">${t.qty}</td></tr>`).join('')}</tbody></table>`
              : '<div class="empty"><div class="icn">📦</div>No sales yet — try ringing one up in <a href="#/pos">POS</a>.</div>'}
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-h"><h3>Low stock</h3><div class="spacer"></div><a class="btn small" href="#/inventory">Manage</a></div>
        <div class="card-b">
          ${lowStock.length ? html`<table class="data"><thead><tr><th>Product</th><th>SKU</th><th class="right">Stock</th></tr></thead>
              <tbody>${lowStock.map(p => `<tr><td>${escapeHtml(p.name)}</td><td class="mono">${escapeHtml(p.sku||'')}</td><td class="right"><span class="badge ${p.stock<=0?'bad':'warn'}">${p.stock ?? 0}</span></td></tr>`).join('')}</tbody></table>`
              : '<div class="muted">All products are well stocked.</div>'}
        </div>
      </div>
    </div>`;
});

/* Point of Sale */
const POS = {
  filterText: '',
  filterCategory: '',
  paymentMethod: 'cash'
};

function cartTotals() {
  const s = state.settings;
  const items = state.cart.items;
  const subtotal = items.reduce((n, i) => n + i.price * i.qty, 0);
  const discount = Math.min(subtotal, Number(state.cart.discount) || 0);
  const taxable = items.filter(i => i.taxable).reduce((n, i) => n + i.price * i.qty, 0);
  const taxableAfter = Math.max(0, taxable - discount * (taxable / (subtotal || 1)));
  const rate = Number(s.taxRate || 0) / 100;
  let tax = 0, total = 0;
  if (s.taxInclusive) {
    total = subtotal - discount;
    tax = taxableAfter - taxableAfter / (1 + rate);
  } else {
    tax = taxableAfter * rate;
    total = subtotal - discount + tax;
  }
  return { subtotal, discount, tax, total };
}

function addToCart(product, qty = 1) {
  if ((product.stock ?? 0) < qty) { toast('Not enough stock', 'warn'); return; }
  const existing = state.cart.items.find(i => i.productId === product.id);
  if (existing) {
    if (product.stock < existing.qty + qty) { toast('Not enough stock', 'warn'); return; }
    existing.qty += qty;
  } else {
    state.cart.items.push({ productId: product.id, name: product.name, price: product.price, qty, taxable: product.taxable !== false });
  }
  refreshCart();
}
function removeFromCart(pid) { state.cart.items = state.cart.items.filter(i => i.productId !== pid); refreshCart(); }
function setQty(pid, q) {
  const it = state.cart.items.find(i => i.productId === pid); if (!it) return;
  const p = state.products.find(x => x.id === pid);
  q = Math.max(0, Math.floor(Number(q) || 0));
  if (p && q > p.stock) { toast('Not enough stock', 'warn'); q = p.stock; }
  if (q === 0) return removeFromCart(pid);
  it.qty = q; refreshCart();
}

function renderCatalog() {
  const term = POS.filterText.trim().toLowerCase();
  let list = state.products.filter(p => p.active !== false);
  if (POS.filterCategory) list = list.filter(p => p.category === POS.filterCategory);
  if (term) list = list.filter(p =>
    p.name.toLowerCase().includes(term) ||
    (p.sku || '').toLowerCase().includes(term) ||
    (p.barcode || '').includes(term)
  );
  const grid = $('.product-grid');
  if (!grid) return;
  grid.innerHTML = list.map(p => {
    const oos = (p.stock ?? 0) <= 0;
    return html`
      <div class="product-card ${oos ? 'oos' : ''}" data-pid="${p.id}">
        <div class="p-name">${escapeHtml(p.name)}</div>
        <div class="p-price">${money(p.price)}</div>
        <div class="p-meta">Stock: ${p.stock ?? 0} · ${escapeHtml(p.sku || '')}</div>
      </div>`;
  }).join('') || '<div class="empty">No matching products</div>';
  grid.querySelectorAll('.product-card').forEach(el => {
    el.addEventListener('click', () => {
      if (el.classList.contains('oos')) return;
      const p = state.products.find(x => x.id === el.dataset.pid); if (p) addToCart(p);
    });
  });
}

function refreshCart() {
  const box = $('.cart .cart-items'); if (!box) return;
  if (state.cart.items.length === 0) {
    box.innerHTML = '<div class="empty"><div class="icn">🛒</div>Cart is empty</div>';
  } else {
    box.innerHTML = state.cart.items.map(i => html`
      <div class="cart-line" data-pid="${i.productId}">
        <div>
          <div class="l1"><div><b>${escapeHtml(i.name)}</b></div><div class="mono">${money(i.price * i.qty)}</div></div>
          <div class="l2">
            <div>
              <span class="qty">
                <button data-act="dec">−</button>
                <input type="number" min="0" value="${i.qty}" />
                <button data-act="inc">+</button>
              </span>
              @ ${money(i.price)}
            </div>
            <button class="btn small ghost" data-act="rm">Remove</button>
          </div>
        </div>
      </div>`).join('');
    box.querySelectorAll('.cart-line').forEach(row => {
      const pid = row.dataset.pid;
      row.querySelector('[data-act="inc"]').addEventListener('click', () => {
        const it = state.cart.items.find(x => x.productId === pid);
        setQty(pid, (it?.qty || 0) + 1);
      });
      row.querySelector('[data-act="dec"]').addEventListener('click', () => {
        const it = state.cart.items.find(x => x.productId === pid);
        setQty(pid, (it?.qty || 0) - 1);
      });
      row.querySelector('[data-act="rm"]').addEventListener('click', () => removeFromCart(pid));
      row.querySelector('input').addEventListener('change', (e) => setQty(pid, e.target.value));
    });
  }
  const t = cartTotals();
  const totalsBox = $('.cart .totals');
  if (totalsBox) {
    totalsBox.innerHTML = html`
      <div class="row-t"><div>Subtotal</div><div class="mono">${money(t.subtotal)}</div></div>
      <div class="row-t"><div>Discount</div><div class="mono">− ${money(t.discount)}</div></div>
      <div class="row-t"><div>Tax</div><div class="mono">${money(t.tax)}</div></div>
      <div class="row-t total"><div>Total</div><div class="mono">${money(t.total)}</div></div>`;
  }
}

async function completeSale(payment) {
  if (state.cart.items.length === 0) { toast('Cart is empty', 'warn'); return; }
  const t = cartTotals();
  const sale = {
    id: uid('s_'),
    number: 'S' + Date.now().toString().slice(-8),
    items: clone(state.cart.items),
    customerId: state.cart.customerId,
    discount: t.discount,
    tax: t.tax,
    subtotal: t.subtotal,
    total: t.total,
    payment: { method: payment.method, tendered: payment.tendered || t.total, change: payment.change || 0 },
    cashier: { id: state.user.id, name: state.user.name },
    note: state.cart.note,
    createdAt: nowISO()
  };
  // decrement stock
  for (const li of sale.items) {
    const p = state.products.find(x => x.id === li.productId);
    if (p) { p.stock = Math.max(0, (p.stock || 0) - li.qty); await dbPut('products', p); }
  }
  // loyalty
  if (sale.customerId) {
    const c = state.customers.find(x => x.id === sale.customerId);
    if (c) {
      c.points = (c.points || 0) + Math.floor(sale.total * (state.settings.loyaltyPerCurrency || 1));
      c.interactions = c.interactions || [];
      c.interactions.unshift({ at: nowISO(), type: 'purchase', amount: sale.total, saleId: sale.id });
      await dbPut('customers', c);
    }
  }
  await dbPut('sales', sale);
  state.sales.push(sale);
  await audit('sale.create', { id: sale.id, total: sale.total });
  // reset cart
  state.cart = { items: [], discount: 0, customerId: null, note: '' };
  return sale;
}

function receiptHTML(sale) {
  const s = state.settings;
  const customer = sale.customerId ? state.customers.find(c => c.id === sale.customerId) : null;
  return html`
    <div class="receipt">
      <h4>${escapeHtml(s.businessName)}</h4>
      <div class="small" style="text-align:center">${escapeHtml(s.address || '')}<br>${escapeHtml(s.phone || '')}</div>
      <hr>
      <div class="r-line"><div>Receipt #</div><div>${sale.number}</div></div>
      <div class="r-line"><div>Date</div><div>${fmtDate(sale.createdAt)}</div></div>
      <div class="r-line"><div>Cashier</div><div>${escapeHtml(sale.cashier?.name || '')}</div></div>
      ${customer ? `<div class="r-line"><div>Customer</div><div>${escapeHtml(customer.name)}</div></div>` : ''}
      <hr>
      ${sale.items.map(i => `
        <div class="r-line"><div>${escapeHtml(i.name)} × ${i.qty}</div><div>${money(i.price * i.qty, s)}</div></div>
      `).join('')}
      <hr>
      <div class="r-line"><div>Subtotal</div><div>${money(sale.subtotal, s)}</div></div>
      <div class="r-line"><div>Discount</div><div>− ${money(sale.discount, s)}</div></div>
      <div class="r-line"><div>Tax</div><div>${money(sale.tax, s)}</div></div>
      <div class="r-line" style="font-weight:700"><div>Total</div><div>${money(sale.total, s)}</div></div>
      <hr>
      <div class="r-line"><div>Paid (${escapeHtml(sale.payment.method)})</div><div>${money(sale.payment.tendered, s)}</div></div>
      ${sale.payment.change ? `<div class="r-line"><div>Change</div><div>${money(sale.payment.change, s)}</div></div>` : ''}
      <hr>
      <div class="small" style="text-align:center">${escapeHtml(s.receiptFooter || '')}</div>
    </div>`;
}

function openCheckout() {
  const t = cartTotals();
  const foot = document.createElement('div');
  foot.innerHTML = `<button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-pay>Charge ${money(t.total)}</button>`;
  const bodyDiv = document.createElement('div');
  bodyDiv.innerHTML = html`
    <div class="grid cols-2">
      <div class="field"><label>Payment method</label>
        <select id="pmMethod">
          <option value="cash">Cash</option>
          <option value="card">Card</option>
          <option value="wallet">Wallet / Other</option>
        </select>
      </div>
      <div class="field"><label>Amount tendered</label><input id="pmTendered" type="number" step="0.01" min="0" value="${t.total.toFixed(2)}" /></div>
      <div class="field"><label>Customer (optional)</label>
        <select id="pmCustomer"><option value="">— walk-in —</option>
          ${state.customers.map(c => `<option value="${c.id}" ${state.cart.customerId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Discount (${state.settings.currency})</label><input id="pmDiscount" type="number" step="0.01" min="0" value="${state.cart.discount || 0}" /></div>
      <div class="field" style="grid-column:1/-1"><label>Note</label><input id="pmNote" placeholder="Optional note printed on receipt" value="${escapeHtml(state.cart.note || '')}" /></div>
    </div>
    <div id="pmSummary" class="muted" style="margin-top:6px"></div>`;
  const m = openModal({ title: 'Checkout', body: bodyDiv, footer: foot });
  const updateSummary = () => {
    state.cart.discount = Number($('#pmDiscount', bodyDiv).value) || 0;
    state.cart.customerId = $('#pmCustomer', bodyDiv).value || null;
    state.cart.note = $('#pmNote', bodyDiv).value;
    const tt = cartTotals();
    const tendered = Number($('#pmTendered', bodyDiv).value) || 0;
    const change = Math.max(0, tendered - tt.total);
    $('#pmSummary', bodyDiv).innerHTML = `Total <b>${money(tt.total)}</b> · Change <b>${money(change)}</b>`;
    foot.querySelector('[data-pay]').textContent = 'Charge ' + money(tt.total);
  };
  bodyDiv.querySelectorAll('input,select').forEach(el => el.addEventListener('input', updateSummary));
  updateSummary();

  foot.querySelector('[data-cancel]').addEventListener('click', m.close);
  foot.querySelector('[data-pay]').addEventListener('click', async () => {
    const tt = cartTotals();
    const tendered = Number($('#pmTendered', bodyDiv).value) || 0;
    const method = $('#pmMethod', bodyDiv).value;
    if (method === 'cash' && tendered < tt.total) { toast('Not enough cash tendered', 'bad'); return; }
    const sale = await completeSale({ method, tendered, change: Math.max(0, tendered - tt.total) });
    m.close();
    // receipt modal
    const rBody = document.createElement('div');
    rBody.innerHTML = receiptHTML(sale);
    const rFoot = document.createElement('div');
    rFoot.innerHTML = `<button class="btn ghost" data-close-r>Close</button><button class="btn primary" data-print>Print receipt</button>`;
    const rm = openModal({ title: 'Sale complete · ' + sale.number, body: rBody, footer: rFoot, size: 'lg' });
    rFoot.querySelector('[data-close-r]').addEventListener('click', rm.close);
    rFoot.querySelector('[data-print]').addEventListener('click', () => window.print());
    toast('Sale ' + sale.number + ' saved', 'good');
    refreshCart(); renderCatalog();
  });
}

route('/pos', async () => {
  const el = document.createElement('div');
  el.className = 'pos';
  el.innerHTML = html`
    <div class="catalog">
      <div class="filters">
        <input id="posSearch" placeholder="Search name, SKU or scan barcode…" autofocus />
        <select id="posCat" style="max-width:180px">
          <option value="">All categories</option>
          ${state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="product-grid"></div>
    </div>
    <div class="cart">
      <div class="cart-h"><h3 style="margin:0">Current sale</h3><div class="spacer"></div>
        <button class="btn small ghost" id="cartClear">Clear</button>
      </div>
      <div class="cart-items"></div>
      <div class="totals"></div>
      <div class="actions">
        <button class="btn" id="cartHold">Hold</button>
        <button class="btn" id="cartCust">Customer</button>
        <button class="btn primary" id="cartPay">Charge</button>
      </div>
    </div>`;

  // Wire once appended
  queueMicrotask(() => {
    renderCatalog();
    refreshCart();
    $('#posSearch', el).addEventListener('input', (e) => { POS.filterText = e.target.value; renderCatalog(); });
    $('#posSearch', el).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const term = POS.filterText.trim();
        const exact = state.products.find(p => p.barcode === term || p.sku?.toLowerCase() === term.toLowerCase());
        if (exact) { addToCart(exact); e.target.value = ''; POS.filterText = ''; renderCatalog(); }
      }
    });
    $('#posCat', el).addEventListener('change', (e) => { POS.filterCategory = e.target.value; renderCatalog(); });
    $('#cartClear', el).addEventListener('click', async () => {
      if (state.cart.items.length && !(await confirmModal('Clear the current sale?'))) return;
      state.cart = { items: [], discount: 0, customerId: null, note: '' };
      refreshCart();
    });
    $('#cartCust', el).addEventListener('click', () => {
      const foot = document.createElement('div');
      foot.innerHTML = '<button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Attach</button>';
      const body = document.createElement('div');
      body.innerHTML = html`
        <div class="field"><label>Customer</label>
          <select id="attachCust">
            <option value="">— walk-in —</option>
            ${state.customers.map(c => `<option value="${c.id}" ${state.cart.customerId === c.id ? 'selected' : ''}>${escapeHtml(c.name)} (${c.points || 0} pts)</option>`).join('')}
          </select>
        </div>`;
      const m = openModal({ title: 'Attach customer', body, footer: foot });
      foot.querySelector('[data-cancel]').addEventListener('click', m.close);
      foot.querySelector('[data-ok]').addEventListener('click', () => {
        state.cart.customerId = $('#attachCust', body).value || null;
        m.close();
        toast(state.cart.customerId ? 'Customer attached' : 'Set to walk-in', 'good');
      });
    });
    $('#cartHold', el).addEventListener('click', () => {
      if (!state.cart.items.length) return toast('Nothing to hold', 'warn');
      sessionStorage.setItem('lysipos:heldCart', JSON.stringify(state.cart));
      state.cart = { items: [], discount: 0, customerId: null, note: '' };
      refreshCart();
      toast('Cart held. It will restore when you reopen POS.', 'good');
    });
    // restore held cart
    const held = sessionStorage.getItem('lysipos:heldCart');
    if (held && !state.cart.items.length) {
      try { state.cart = JSON.parse(held); sessionStorage.removeItem('lysipos:heldCart'); refreshCart(); toast('Restored held cart'); } catch {}
    }
    $('#cartPay', el).addEventListener('click', openCheckout);
  });

  return el;
});

/* Products */
function productForm(existing = {}) {
  const body = document.createElement('div');
  body.innerHTML = html`
    <div class="grid cols-2">
      <div class="field"><label>Name</label><input name="name" value="${escapeHtml(existing.name || '')}" /></div>
      <div class="field"><label>SKU</label><input name="sku" value="${escapeHtml(existing.sku || '')}" /></div>
      <div class="field"><label>Barcode</label><input name="barcode" value="${escapeHtml(existing.barcode || '')}" /></div>
      <div class="field"><label>Category</label>
        <select name="category"><option value="">—</option>${state.categories.map(c => `<option value="${c.id}" ${existing.category === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Price</label><input name="price" type="number" step="0.01" min="0" value="${existing.price ?? 0}" /></div>
      <div class="field"><label>Cost</label><input name="cost" type="number" step="0.01" min="0" value="${existing.cost ?? 0}" /></div>
      <div class="field"><label>Stock</label><input name="stock" type="number" step="1" min="0" value="${existing.stock ?? 0}" /></div>
      <div class="field"><label>Taxable</label>
        <select name="taxable"><option value="1" ${existing.taxable !== false ? 'selected' : ''}>Yes</option><option value="0" ${existing.taxable === false ? 'selected' : ''}>No</option></select>
      </div>
      <div class="field" style="grid-column:1/-1"><label>Active</label>
        <select name="active"><option value="1" ${existing.active !== false ? 'selected' : ''}>Yes</option><option value="0" ${existing.active === false ? 'selected' : ''}>No</option></select>
      </div>
    </div>`;
  return body;
}
function readForm(body) {
  const data = {};
  body.querySelectorAll('input,select,textarea').forEach(el => { data[el.name] = el.value; });
  return data;
}

route('/products', async () => {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = html`
    <h1>Products</h1><div class="sub">Manage your catalog, prices, and stock.</div>
    <div class="card">
      <div class="card-h">
        <input id="pFilter" placeholder="Search…" style="max-width:260px" />
        <select id="pCat" style="max-width:200px"><option value="">All categories</option>${state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select>
        <div class="spacer"></div>
        <button class="btn small" id="pManageCat">Categories</button>
        <button class="btn primary small" id="pNew">+ New product</button>
      </div>
      <div class="card-b" style="overflow:auto;max-height:calc(100vh - 220px)">
        <table class="data" id="pTable">
          <thead><tr><th>Name</th><th>SKU</th><th>Category</th><th class="right">Price</th><th class="right">Stock</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;

  const rerender = () => {
    const term = $('#pFilter', el).value.trim().toLowerCase();
    const cat = $('#pCat', el).value;
    let list = state.products.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (term) list = list.filter(p => p.name.toLowerCase().includes(term) || (p.sku || '').toLowerCase().includes(term) || (p.barcode || '').includes(term));
    if (cat) list = list.filter(p => p.category === cat);
    const catName = (id) => state.categories.find(c => c.id === id)?.name || '—';
    $('tbody', el).innerHTML = list.map(p => html`
      <tr data-id="${p.id}">
        <td>${escapeHtml(p.name)} ${p.active === false ? '<span class="badge">inactive</span>' : ''}</td>
        <td class="mono">${escapeHtml(p.sku || '')}</td>
        <td>${escapeHtml(catName(p.category))}</td>
        <td class="right mono">${money(p.price)}</td>
        <td class="right"><span class="badge ${p.stock <= 0 ? 'bad' : p.stock <= 5 ? 'warn' : 'good'}">${p.stock ?? 0}</span></td>
        <td class="right"><button class="btn small" data-edit>Edit</button> <button class="btn small danger" data-del>Delete</button></td>
      </tr>`).join('') || `<tr><td colspan="6"><div class="empty">No products</div></td></tr>`;

    el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
      const id = b.closest('tr').dataset.id; const p = state.products.find(x => x.id === id);
      openProduct(p);
    }));
    el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      const id = b.closest('tr').dataset.id; const p = state.products.find(x => x.id === id);
      if (!(await confirmModal(`Delete "${p.name}"? This can't be undone.`, { danger: true, okText: 'Delete' }))) return;
      await dbDel('products', id); state.products = state.products.filter(x => x.id !== id); rerender();
      audit('product.delete', { id, name: p.name });
    }));
  };

  const openProduct = (existing) => {
    const body = productForm(existing || {});
    const foot = document.createElement('div');
    foot.innerHTML = '<button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-save>Save</button>';
    const m = openModal({ title: existing ? 'Edit product' : 'New product', body, footer: foot, size: 'lg' });
    foot.querySelector('[data-cancel]').addEventListener('click', m.close);
    foot.querySelector('[data-save]').addEventListener('click', async () => {
      const d = readForm(body);
      if (!d.name?.trim()) return toast('Name required', 'bad');
      const rec = existing ? { ...existing } : { id: uid('p_'), createdAt: nowISO() };
      Object.assign(rec, {
        name: d.name.trim(), sku: d.sku.trim(), barcode: d.barcode.trim(), category: d.category || '',
        price: Number(d.price) || 0, cost: Number(d.cost) || 0, stock: Number(d.stock) || 0,
        taxable: d.taxable === '1', active: d.active === '1'
      });
      await dbPut('products', rec);
      const idx = state.products.findIndex(p => p.id === rec.id);
      if (idx >= 0) state.products[idx] = rec; else state.products.push(rec);
      audit(existing ? 'product.update' : 'product.create', { id: rec.id, name: rec.name });
      m.close(); toast('Saved', 'good'); rerender();
    });
  };

  const openCats = () => {
    const body = document.createElement('div');
    body.innerHTML = `<div class="field"><label>New category</label><div class="row"><input id="ncName" /><button class="btn primary" id="ncAdd">Add</button></div></div><div id="cList"></div>`;
    const listRender = () => {
      $('#cList', body).innerHTML = html`<table class="data"><tbody>
        ${state.categories.map(c => `<tr data-id="${c.id}"><td>${escapeHtml(c.name)}</td><td class="right"><button class="btn small danger" data-cdel>Delete</button></td></tr>`).join('') || '<tr><td class="muted">No categories</td></tr>'}
      </tbody></table>`;
      body.querySelectorAll('[data-cdel]').forEach(b => b.addEventListener('click', async () => {
        const id = b.closest('tr').dataset.id;
        if (!(await confirmModal('Delete this category?', { danger: true }))) return;
        await dbDel('categories', id);
        state.categories = state.categories.filter(x => x.id !== id);
        listRender();
      }));
    };
    const m = openModal({ title: 'Categories', body, footer: '<button class="btn primary" data-done>Done</button>' });
    m.footEl.querySelector('[data-done]').addEventListener('click', () => { m.close(); rerender(); });
    $('#ncAdd', body).addEventListener('click', async () => {
      const name = $('#ncName', body).value.trim(); if (!name) return;
      const rec = { id: uid('c_'), name };
      await dbPut('categories', rec); state.categories.push(rec);
      $('#ncName', body).value = ''; listRender();
    });
    listRender();
  };

  queueMicrotask(() => {
    $('#pFilter', el).addEventListener('input', rerender);
    $('#pCat', el).addEventListener('change', rerender);
    $('#pNew', el).addEventListener('click', () => openProduct(null));
    $('#pManageCat', el).addEventListener('click', openCats);
    rerender();
  });
  return el;
});

/* Inventory (adjust stock) */
route('/inventory', async () => {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = html`
    <h1>Inventory</h1><div class="sub">Adjust stock levels and see what's low.</div>
    <div class="card">
      <div class="card-h">
        <input id="iFilter" placeholder="Search…" style="max-width:260px" />
        <div class="spacer"></div>
        <button class="btn small" id="iRecount">Bulk restock (+10 all)</button>
      </div>
      <div class="card-b" style="overflow:auto;max-height:calc(100vh - 220px)">
        <table class="data"><thead><tr><th>Product</th><th>SKU</th><th class="right">Stock</th><th class="right">Adjust</th></tr></thead><tbody></tbody></table>
      </div>
    </div>`;
  const rerender = () => {
    const term = $('#iFilter', el).value.trim().toLowerCase();
    const list = state.products.filter(p => !term || p.name.toLowerCase().includes(term) || (p.sku || '').toLowerCase().includes(term))
      .sort((a, b) => (a.stock ?? 0) - (b.stock ?? 0));
    $('tbody', el).innerHTML = list.map(p => html`
      <tr data-id="${p.id}">
        <td>${escapeHtml(p.name)}</td>
        <td class="mono">${escapeHtml(p.sku || '')}</td>
        <td class="right"><span class="badge ${p.stock <= 0 ? 'bad' : p.stock <= 5 ? 'warn' : 'good'}">${p.stock ?? 0}</span></td>
        <td class="right">
          <div style="display:inline-flex;gap:6px">
            <input type="number" style="width:100px" value="0" data-adj />
            <button class="btn small" data-apply>Apply</button>
          </div>
        </td>
      </tr>`).join('');
    el.querySelectorAll('[data-apply]').forEach(b => b.addEventListener('click', async () => {
      const tr = b.closest('tr'); const id = tr.dataset.id;
      const delta = Math.floor(Number(tr.querySelector('[data-adj]').value) || 0);
      const p = state.products.find(x => x.id === id); if (!p) return;
      p.stock = Math.max(0, (p.stock || 0) + delta);
      await dbPut('products', p); audit('inventory.adjust', { id, delta });
      toast(`${p.name}: ${delta >= 0 ? '+' : ''}${delta}`, 'good');
      rerender();
    }));
  };
  queueMicrotask(() => {
    $('#iFilter', el).addEventListener('input', rerender);
    $('#iRecount', el).addEventListener('click', async () => {
      if (!(await confirmModal('Add +10 to every product\'s stock?'))) return;
      for (const p of state.products) { p.stock = (p.stock || 0) + 10; await dbPut('products', p); }
      audit('inventory.bulkRestock', { each: 10 });
      toast('Restocked all products', 'good'); rerender();
    });
    rerender();
  });
  return el;
});

/* Customers */
function customerForm(existing = {}) {
  const body = document.createElement('div');
  body.innerHTML = html`
    <div class="grid cols-2">
      <div class="field"><label>Name</label><input name="name" value="${escapeHtml(existing.name || '')}" /></div>
      <div class="field"><label>Email</label><input name="email" type="email" value="${escapeHtml(existing.email || '')}" /></div>
      <div class="field"><label>Phone</label><input name="phone" value="${escapeHtml(existing.phone || '')}" /></div>
      <div class="field"><label>Tags (comma separated)</label><input name="tags" value="${escapeHtml((existing.tags || []).join(', '))}" /></div>
      <div class="field" style="grid-column:1/-1"><label>Address</label><input name="address" value="${escapeHtml(existing.address || '')}" /></div>
      <div class="field" style="grid-column:1/-1"><label>Notes</label><textarea name="notes" rows="3">${escapeHtml(existing.notes || '')}</textarea></div>
    </div>`;
  return body;
}

route('/customers', async () => {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = html`
    <h1>Customers</h1><div class="sub">CRM — segment, note, and reward your customers.</div>
    <div class="card">
      <div class="card-h">
        <input id="cFilter" placeholder="Search name, email or tag…" style="max-width:280px" />
        <div class="spacer"></div>
        <button class="btn primary small" id="cNew">+ New customer</button>
      </div>
      <div class="card-b" style="overflow:auto;max-height:calc(100vh - 220px)">
        <table class="data"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Tags</th><th class="right">Points</th><th></th></tr></thead><tbody></tbody></table>
      </div>
    </div>`;

  const openCustomer = (existing) => {
    const body = customerForm(existing || {});
    const details = document.createElement('div');
    if (existing) {
      const spent = state.sales.filter(s => s.customerId === existing.id).reduce((n, s) => n + s.total, 0);
      const count = state.sales.filter(s => s.customerId === existing.id).length;
      details.innerHTML = html`
        <div class="grid cols-3" style="margin-top:10px">
          <div class="kpi"><div class="label">Lifetime spend</div><div class="value">${money(spent)}</div></div>
          <div class="kpi"><div class="label">Orders</div><div class="value">${count}</div></div>
          <div class="kpi"><div class="label">Points</div><div class="value">${existing.points || 0}</div></div>
        </div>
        <div class="card" style="margin-top:10px"><div class="card-h"><h3>Interactions</h3></div>
          <div class="card-b" style="max-height:180px;overflow:auto">
            ${(existing.interactions || []).length ? (existing.interactions || []).map(i => `<div class="row-t" style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dashed var(--border)"><div>${escapeHtml(i.type)} ${i.amount ? '· ' + money(i.amount) : ''}</div><div class="muted">${fmtDate(i.at)}</div></div>`).join('') : '<div class="muted">No interactions yet.</div>'}
          </div>
        </div>`;
      body.appendChild(details);
      const noteBox = document.createElement('div');
      noteBox.style.marginTop = '10px';
      noteBox.innerHTML = `<div class="field"><label>Add interaction note</label><div class="row"><input id="niText" placeholder="e.g. Called about wholesale discount" /><button class="btn primary" id="niAdd">Log</button></div></div>`;
      body.appendChild(noteBox);
      queueMicrotask(() => {
        $('#niAdd', body).addEventListener('click', async () => {
          const t = $('#niText', body).value.trim(); if (!t) return;
          existing.interactions = existing.interactions || [];
          existing.interactions.unshift({ at: nowISO(), type: 'note', text: t });
          await dbPut('customers', existing); $('#niText', body).value = '';
          toast('Logged', 'good');
        });
      });
    }
    const foot = document.createElement('div');
    foot.innerHTML = '<button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-save>Save</button>';
    const m = openModal({ title: existing ? existing.name : 'New customer', body, footer: foot, size: 'lg' });
    foot.querySelector('[data-cancel]').addEventListener('click', m.close);
    foot.querySelector('[data-save]').addEventListener('click', async () => {
      const d = readForm(body);
      if (!d.name?.trim()) return toast('Name required', 'bad');
      const rec = existing ? { ...existing } : { id: uid('cu_'), createdAt: nowISO(), interactions: [], points: 0 };
      Object.assign(rec, {
        name: d.name.trim(), email: d.email.trim(), phone: d.phone.trim(),
        address: d.address, notes: d.notes,
        tags: d.tags.split(',').map(s => s.trim()).filter(Boolean)
      });
      await dbPut('customers', rec);
      const idx = state.customers.findIndex(c => c.id === rec.id);
      if (idx >= 0) state.customers[idx] = rec; else state.customers.push(rec);
      audit(existing ? 'customer.update' : 'customer.create', { id: rec.id });
      m.close(); toast('Saved', 'good'); rerender();
    });
  };

  const rerender = () => {
    const term = ($('#cFilter', el).value || '').trim().toLowerCase();
    let list = state.customers.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (term) list = list.filter(c =>
      c.name.toLowerCase().includes(term) ||
      (c.email || '').toLowerCase().includes(term) ||
      (c.tags || []).some(t => t.toLowerCase().includes(term))
    );
    $('tbody', el).innerHTML = list.map(c => html`
      <tr data-id="${c.id}">
        <td>${escapeHtml(c.name)}</td>
        <td>${escapeHtml(c.email || '')}</td>
        <td>${escapeHtml(c.phone || '')}</td>
        <td>${(c.tags || []).map(t => `<span class="badge">${escapeHtml(t)}</span>`).join(' ')}</td>
        <td class="right mono">${c.points || 0}</td>
        <td class="right"><button class="btn small" data-edit>Open</button> <button class="btn small danger" data-del>Delete</button></td>
      </tr>`).join('') || `<tr><td colspan="6"><div class="empty">No customers</div></td></tr>`;
    el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
      const id = b.closest('tr').dataset.id; openCustomer(state.customers.find(x => x.id === id));
    }));
    el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      const id = b.closest('tr').dataset.id; const c = state.customers.find(x => x.id === id);
      if (!(await confirmModal(`Delete customer "${c.name}"?`, { danger: true, okText: 'Delete' }))) return;
      await dbDel('customers', id); state.customers = state.customers.filter(x => x.id !== id);
      audit('customer.delete', { id }); rerender();
    }));
  };
  queueMicrotask(() => {
    $('#cFilter', el).addEventListener('input', rerender);
    $('#cNew', el).addEventListener('click', () => openCustomer(null));
    rerender();
  });
  return el;
});

/* Sales history */
route('/sales', async () => {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = html`
    <h1>Sales</h1><div class="sub">All completed sales. Click a row to view or refund.</div>
    <div class="card">
      <div class="card-h">
        <input id="sFrom" type="date" style="max-width:180px" />
        <input id="sTo" type="date" style="max-width:180px" />
        <input id="sQ" placeholder="Search receipt #…" style="max-width:220px" />
        <div class="spacer"></div>
        <div id="sSummary" class="muted"></div>
      </div>
      <div class="card-b" style="overflow:auto;max-height:calc(100vh - 220px)">
        <table class="data"><thead><tr><th>#</th><th>When</th><th>Cashier</th><th>Customer</th><th class="right">Items</th><th class="right">Total</th><th></th></tr></thead><tbody></tbody></table>
      </div>
    </div>`;
  const custName = (id) => state.customers.find(c => c.id === id)?.name || '—';

  const rerender = () => {
    const q = ($('#sQ', el).value || '').trim().toLowerCase();
    const from = $('#sFrom', el).value ? new Date($('#sFrom', el).value) : null;
    const to = $('#sTo', el).value ? new Date($('#sTo', el).value + 'T23:59:59') : null;
    let list = state.sales.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (from) list = list.filter(s => new Date(s.createdAt) >= from);
    if (to) list = list.filter(s => new Date(s.createdAt) <= to);
    if (q) list = list.filter(s => s.number.toLowerCase().includes(q));
    const sum = list.reduce((n, s) => n + s.total, 0);
    $('#sSummary', el).textContent = `${list.length} sales · ${money(sum)}`;
    $('tbody', el).innerHTML = list.map(s => html`
      <tr data-id="${s.id}">
        <td class="mono">${s.number} ${s.refunded ? '<span class="badge bad">refunded</span>' : ''}</td>
        <td>${fmtDate(s.createdAt)}</td>
        <td>${escapeHtml(s.cashier?.name || '')}</td>
        <td>${escapeHtml(custName(s.customerId))}</td>
        <td class="right">${s.items.reduce((n, i) => n + i.qty, 0)}</td>
        <td class="right mono">${money(s.total)}</td>
        <td class="right"><button class="btn small" data-view>View</button></td>
      </tr>`).join('') || `<tr><td colspan="7"><div class="empty">No sales in range</div></td></tr>`;
    el.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
      const id = b.closest('tr').dataset.id; const s = state.sales.find(x => x.id === id);
      const body = document.createElement('div');
      body.innerHTML = receiptHTML(s);
      const foot = document.createElement('div');
      foot.innerHTML = `<button class="btn ghost" data-close2>Close</button>
                       ${s.refunded ? '' : '<button class="btn danger" data-refund>Refund</button>'}
                       <button class="btn primary" data-print>Print</button>`;
      const m = openModal({ title: 'Sale ' + s.number, body, footer: foot, size: 'lg' });
      foot.querySelector('[data-close2]').addEventListener('click', m.close);
      foot.querySelector('[data-print]').addEventListener('click', () => window.print());
      foot.querySelector('[data-refund]')?.addEventListener('click', async () => {
        if (!(await confirmModal('Refund this sale and restore stock?', { danger: true, okText: 'Refund' }))) return;
        s.refunded = true; s.refundedAt = nowISO();
        for (const li of s.items) {
          const p = state.products.find(x => x.id === li.productId);
          if (p) { p.stock = (p.stock || 0) + li.qty; await dbPut('products', p); }
        }
        await dbPut('sales', s); audit('sale.refund', { id: s.id });
        m.close(); toast('Refunded', 'good'); rerender();
      });
    }));
  };
  queueMicrotask(() => {
    ['sFrom', 'sTo', 'sQ'].forEach(id => $('#' + id, el).addEventListener('input', rerender));
    rerender();
  });
  return el;
});

/* Reports */
route('/reports', async () => {
  const el = document.createElement('div');
  el.className = 'page';
  const days = 30;
  const sales = state.sales.filter(s => new Date(s.createdAt) >= daysAgo(days - 1));
  const byDay = {};
  for (let i = days - 1; i >= 0; i--) byDay[dayKey(daysAgo(i))] = 0;
  for (const s of sales) byDay[dayKey(s.createdAt)] = (byDay[dayKey(s.createdAt)] || 0) + s.total;

  const byCategory = {};
  for (const s of sales) for (const li of s.items) {
    const p = state.products.find(x => x.id === li.productId);
    const cat = state.categories.find(c => c.id === p?.category)?.name || 'Uncategorized';
    byCategory[cat] = (byCategory[cat] || 0) + li.price * li.qty;
  }
  const byCashier = {};
  for (const s of sales) byCashier[s.cashier?.name || '—'] = (byCashier[s.cashier?.name || '—'] || 0) + s.total;

  const barSeries = (obj) => {
    const entries = Object.entries(obj); const max = Math.max(1, ...entries.map(x => x[1]));
    return entries.map(([k, v]) => `
      <div style="margin:6px 0">
        <div style="display:flex;justify-content:space-between;font-size:12px"><div>${escapeHtml(k)}</div><div class="mono">${money(v)}</div></div>
        <div style="height:8px;background:var(--panel-2);border-radius:6px;overflow:hidden"><div style="height:100%;width:${(v / max * 100).toFixed(1)}%;background:linear-gradient(90deg,var(--accent),var(--accent-2))"></div></div>
      </div>`).join('');
  };

  const dailyMax = Math.max(1, ...Object.values(byDay));
  const bars = Object.entries(byDay).map(([d, v]) => `
    <div title="${d}: ${money(v)}" style="flex:1;display:flex;align-items:flex-end">
      <div style="width:100%;height:${Math.max(2, v / dailyMax * 120)}px;background:linear-gradient(180deg,var(--accent),var(--accent-2));border-radius:6px 6px 0 0"></div>
    </div>`).join('');

  el.innerHTML = html`
    <h1>Reports</h1><div class="sub">Rolling 30-day view.</div>
    <div class="grid cols-3" style="margin-bottom:14px">
      <div class="kpi"><div class="label">30d Revenue</div><div class="value">${money(sales.reduce((n, s) => n + s.total, 0))}</div><div class="delta">${sales.length} orders</div></div>
      <div class="kpi"><div class="label">30d Items</div><div class="value">${sales.reduce((n, s) => n + s.items.reduce((a, i) => a + i.qty, 0), 0)}</div></div>
      <div class="kpi"><div class="label">Avg Ticket</div><div class="value">${money(sales.length ? sales.reduce((n, s) => n + s.total, 0) / sales.length : 0)}</div></div>
    </div>
    <div class="card"><div class="card-h"><h3>Daily revenue</h3></div>
      <div class="card-b"><div style="display:flex;gap:4px;height:140px;align-items:flex-end">${bars}</div></div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><div class="card-h"><h3>By category</h3></div><div class="card-b">${barSeries(byCategory) || '<div class="muted">No data</div>'}</div></div>
      <div class="card"><div class="card-h"><h3>By cashier</h3></div><div class="card-b">${barSeries(byCashier) || '<div class="muted">No data</div>'}</div></div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="card-h"><h3>Export</h3><div class="spacer"></div>
        <button class="btn small" id="expSalesCsv">Sales CSV</button>
        <button class="btn small" id="expProdCsv">Products CSV</button>
      </div>
      <div class="card-b muted">CSV files open in Excel/Sheets.</div>
    </div>`;

  const csv = (rows) => rows.map(r => r.map(v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
  const download = (name, text) => {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  queueMicrotask(() => {
    $('#expSalesCsv', el).addEventListener('click', () => {
      const rows = [['Number', 'When', 'Cashier', 'Customer', 'Items', 'Subtotal', 'Discount', 'Tax', 'Total', 'Method', 'Refunded']];
      for (const s of state.sales) {
        rows.push([s.number, s.createdAt, s.cashier?.name || '', state.customers.find(c => c.id === s.customerId)?.name || '',
          s.items.reduce((n, i) => n + i.qty, 0), s.subtotal, s.discount, s.tax, s.total, s.payment?.method || '', s.refunded ? 'yes' : 'no']);
      }
      download('sales.csv', csv(rows));
    });
    $('#expProdCsv', el).addEventListener('click', () => {
      const rows = [['Name', 'SKU', 'Barcode', 'Category', 'Price', 'Cost', 'Stock', 'Active']];
      for (const p of state.products) rows.push([p.name, p.sku, p.barcode, state.categories.find(c => c.id === p.category)?.name || '', p.price, p.cost, p.stock, p.active !== false ? 'yes' : 'no']);
      download('products.csv', csv(rows));
    });
  });
  return el;
});

/* Users */
route('/users', async () => {
  if (!requireRole('admin')) return '<div class="page"><h1>Users</h1><div class="muted">Admin only.</div></div>';
  const el = document.createElement('div'); el.className = 'page';
  el.innerHTML = html`
    <h1>Users & Roles</h1><div class="sub">Add teammates. Roles: admin (full), manager (no user mgmt), cashier (POS only).</div>
    <div class="card">
      <div class="card-h"><div class="spacer"></div><button class="btn primary small" id="uNew">+ New user</button></div>
      <div class="card-b" style="overflow:auto">
        <table class="data"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody></tbody></table>
      </div>
    </div>`;

  const openUser = (existing) => {
    const body = document.createElement('div');
    body.innerHTML = html`
      <div class="grid cols-2">
        <div class="field"><label>Name</label><input name="name" value="${escapeHtml(existing?.name || '')}" /></div>
        <div class="field"><label>Email</label><input name="email" type="email" value="${escapeHtml(existing?.email || '')}" /></div>
        <div class="field"><label>Role</label>
          <select name="role">
            <option value="admin" ${existing?.role === 'admin' ? 'selected' : ''}>Admin</option>
            <option value="manager" ${existing?.role === 'manager' ? 'selected' : ''}>Manager</option>
            <option value="cashier" ${existing?.role === 'cashier' ? 'selected' : ''}>Cashier</option>
          </select>
        </div>
        <div class="field"><label>Active</label>
          <select name="active"><option value="1" ${existing?.active !== false ? 'selected' : ''}>Yes</option><option value="0" ${existing?.active === false ? 'selected' : ''}>No</option></select>
        </div>
        <div class="field" style="grid-column:1/-1"><label>${existing ? 'New password (leave blank to keep)' : 'Password'}</label><input name="password" type="password" /></div>
      </div>`;
    const foot = document.createElement('div');
    foot.innerHTML = '<button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-save>Save</button>';
    const m = openModal({ title: existing ? 'Edit user' : 'New user', body, footer: foot });
    foot.querySelector('[data-cancel]').addEventListener('click', m.close);
    foot.querySelector('[data-save]').addEventListener('click', async () => {
      const d = readForm(body);
      if (!d.name?.trim() || !d.email?.trim()) return toast('Name and email required', 'bad');
      const rec = existing ? { ...existing } : { id: uid('u_'), createdAt: nowISO() };
      rec.name = d.name.trim(); rec.email = d.email.trim(); rec.role = d.role; rec.active = d.active === '1';
      if (d.password) rec.passHash = await sha256(d.password);
      if (!rec.passHash) return toast('Password required', 'bad');
      await dbPut('users', rec);
      const idx = state.users.findIndex(u => u.id === rec.id);
      if (idx >= 0) state.users[idx] = rec; else state.users.push(rec);
      audit(existing ? 'user.update' : 'user.create', { id: rec.id, role: rec.role });
      m.close(); toast('Saved', 'good'); rerender();
    });
  };

  const rerender = () => {
    $('tbody', el).innerHTML = state.users.map(u => html`
      <tr data-id="${u.id}">
        <td>${escapeHtml(u.name)}</td>
        <td>${escapeHtml(u.email)}</td>
        <td><span class="badge">${escapeHtml(u.role)}</span></td>
        <td>${u.active !== false ? '<span class="badge good">active</span>' : '<span class="badge bad">disabled</span>'}</td>
        <td class="right"><button class="btn small" data-edit>Edit</button> ${u.id === state.user.id ? '' : '<button class="btn small danger" data-del>Delete</button>'}</td>
      </tr>`).join('');
    el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openUser(state.users.find(u => u.id === b.closest('tr').dataset.id))));
    el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      const id = b.closest('tr').dataset.id;
      if (!(await confirmModal('Delete this user?', { danger: true }))) return;
      await dbDel('users', id); state.users = state.users.filter(u => u.id !== id); audit('user.delete', { id });
      rerender();
    }));
  };
  queueMicrotask(() => { $('#uNew', el).addEventListener('click', () => openUser(null)); rerender(); });
  return el;
});

/* Settings */
route('/settings', async () => {
  const el = document.createElement('div'); el.className = 'page';
  const s = state.settings;
  el.innerHTML = html`
    <h1>Settings</h1><div class="sub">Business profile, tax, currency, and data management.</div>
    <div class="grid cols-2">
      <div class="card"><div class="card-h"><h3>Business</h3></div>
        <div class="card-b">
          <div class="field"><label>Business name</label><input name="businessName" value="${escapeHtml(s.businessName)}"></div>
          <div class="field"><label>Address</label><input name="address" value="${escapeHtml(s.address)}"></div>
          <div class="row">
            <div class="field"><label>Phone</label><input name="phone" value="${escapeHtml(s.phone)}"></div>
            <div class="field"><label>Email</label><input name="email" value="${escapeHtml(s.email)}"></div>
          </div>
          <div class="field"><label>Receipt footer</label><input name="receiptFooter" value="${escapeHtml(s.receiptFooter)}"></div>
        </div>
      </div>
      <div class="card"><div class="card-h"><h3>Money</h3></div>
        <div class="card-b">
          <div class="row">
            <div class="field"><label>Currency (ISO 4217)</label><input name="currency" value="${escapeHtml(s.currency)}"></div>
            <div class="field"><label>Tax rate (%)</label><input name="taxRate" type="number" step="0.01" value="${s.taxRate}"></div>
          </div>
          <div class="field"><label>Tax included in price?</label>
            <select name="taxInclusive"><option value="0" ${!s.taxInclusive ? 'selected' : ''}>No — add tax on top</option><option value="1" ${s.taxInclusive ? 'selected' : ''}>Yes — extract from price</option></select>
          </div>
          <div class="row">
            <div class="field"><label>Loyalty pts per ${s.currency}</label><input name="loyaltyPerCurrency" type="number" step="0.01" value="${s.loyaltyPerCurrency}"></div>
            <div class="field"><label>1 pt worth</label><input name="loyaltyRedeemValue" type="number" step="0.001" value="${s.loyaltyRedeemValue}"></div>
          </div>
          <div class="field"><label>Theme</label>
            <select name="theme"><option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Dark</option><option value="light" ${s.theme === 'light' ? 'selected' : ''}>Light</option></select>
          </div>
          <button class="btn primary" id="saveSettings">Save settings</button>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:14px"><div class="card-h"><h3>Data</h3></div>
      <div class="card-b">
        <div class="row">
          <button class="btn" id="doExport">⤓ Export backup (JSON)</button>
          <label class="btn" style="cursor:pointer">⤒ Import backup<input id="doImport" type="file" accept="application/json" style="display:none"></label>
          <button class="btn danger" id="doReset">Reset all data</button>
        </div>
        <div class="muted" style="margin-top:8px">Backups include products, customers, sales, users and settings. Everything lives in your browser (IndexedDB).</div>
      </div>
    </div>`;

  queueMicrotask(() => {
    $('#saveSettings', el).addEventListener('click', async () => {
      const inputs = el.querySelectorAll('[name]');
      for (const i of inputs) {
        const key = i.name; let v = i.value;
        if (['taxRate', 'loyaltyPerCurrency', 'loyaltyRedeemValue'].includes(key)) v = Number(v) || 0;
        if (key === 'taxInclusive') v = v === '1';
        state.settings[key] = v;
      }
      await saveSettings(); toast('Settings saved', 'good');
      // re-render shell to refresh business name
      render();
    });
    $('#doExport', el).addEventListener('click', async () => {
      const dump = {
        exportedAt: nowISO(),
        settings: state.settings,
        users: state.users, products: state.products, categories: state.categories,
        customers: state.customers, sales: state.sales
      };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `lysipos-backup-${dayKey()}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('#doImport', el).addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      if (!(await confirmModal('Importing will REPLACE current data. Continue?', { danger: true, okText: 'Import' }))) { e.target.value = ''; return; }
      const text = await file.text(); let data;
      try { data = JSON.parse(text); } catch { return toast('Invalid file', 'bad'); }
      for (const store of ['products', 'categories', 'customers', 'sales', 'users']) {
        await dbClear(store);
        for (const row of (data[store] || [])) await dbPut(store, row);
      }
      if (data.settings) await dbPut('settings', data.settings);
      await loadAll(); audit('data.import'); toast('Imported', 'good'); render();
    });
    $('#doReset', el).addEventListener('click', async () => {
      if (!(await confirmModal('Erase ALL data and reseed? You will be logged out.', { danger: true, okText: 'Erase' }))) return;
      for (const s of STORES) await dbClear(s);
      _db = null; await seedIfEmpty(); await loadAll(); sessionStorage.clear();
      state.user = null; toast('Reset complete', 'good'); render();
    });
  });
  return el;
});

/* -------------------- PWA install prompt -------------------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e;
  const b = $('#installBtn'); if (b) b.style.display = '';
});

/* -------------------- bootstrap -------------------- */
(async function boot() {
  await seedIfEmpty();
  await loadAll();
  await restoreSession();
  render();
})();
