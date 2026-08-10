// LysiPOS — SaaS · CRM · POS (single-file app)
// Vanilla JS ES module. IndexedDB storage, hash router, offline-first.

import { code128BSvg, qrSvg } from './codes.js';
import { openScanner, isScannerSupported } from './scanner.js';
import { chatStream, testConnection as aiTest, defaultConfig as aiDefaultConfig, AI_DEFAULTS } from './ai.js';
import { requestToken as googleRequestToken, revokeToken as googleRevokeToken, userInfo as googleUserInfo, driveUpload, ensureFolder, DRIVE_SCOPE, USERINFO_SCOPE } from './google.js';

const DEFAULT_GOOGLE_CLIENT_ID = '420770991733-j7gi9omi0as65le877snc8825dm3tch5.apps.googleusercontent.com';

/* -------------------- console capture (for Dev Console page) -------------------- */
const LOG_RING = [];
const LOG_MAX = 400;
(function patchConsole() {
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const push = (level, args) => {
    try {
      const msg = Array.from(args).map(a => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
        return String(a);
      }).join(' ');
      LOG_RING.push({ at: new Date().toISOString(), level, msg });
      if (LOG_RING.length > LOG_MAX) LOG_RING.splice(0, LOG_RING.length - LOG_MAX);
    } catch {}
  };
  console.log = (...a) => { push('log', a); orig.log.apply(console, a); };
  console.info = (...a) => { push('info', a); orig.info.apply(console, a); };
  console.warn = (...a) => { push('warn', a); orig.warn.apply(console, a); };
  console.error = (...a) => { push('error', a); orig.error.apply(console, a); };
  window.addEventListener('error', (e) => push('error', [e.message + ' @ ' + (e.filename || '?') + ':' + (e.lineno || '?')]));
  window.addEventListener('unhandledrejection', (e) => push('error', ['Unhandled: ' + (e.reason?.stack || e.reason || 'unknown')]));
})();

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
  // Wire sorting on any tables inside the modal
  setTimeout(() => { try { applySortableToAll(back); } catch {} }, 0);
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
const DB_VER = 4;
const STORES = ['settings', 'users', 'products', 'categories', 'customers', 'sales', 'audit', 'suppliers', 'expenses', 'backups', 'wallets'];

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
  suppliers: [],
  wallets: [],
  expenses: [],
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
  autoBackup: 'daily', // off | daily | weekly
  autoBackupKeep: 10,
  lastAutoBackupAt: null,
  onboarded: false
};

async function loadAll() {
  const [settings, aiCfg, googleCfg, users, products, categories, customers, suppliers, wallets, expenses, sales] = await Promise.all([
    dbGet('settings', 'app'),
    dbGet('settings', 'ai'),
    dbGet('settings', 'google'),
    dbGetAll('users'), dbGetAll('products'), dbGetAll('categories'),
    dbGetAll('customers'), dbGetAll('suppliers'), dbGetAll('wallets'),
    dbGetAll('expenses'), dbGetAll('sales')
  ]);
  state.settings = settings || DEFAULT_SETTINGS;
  state.ai = aiCfg || { key: 'ai', enabled: false, provider: 'anthropic', configs: {
    anthropic: aiDefaultConfig('anthropic'),
    ollama: aiDefaultConfig('ollama'),
    lms: aiDefaultConfig('lms')
  }};
  state.google = googleCfg || {
    key: 'google',
    clientId: DEFAULT_GOOGLE_CLIENT_ID,
    folderName: 'LysiPOS Backups',
    folderId: null
  };
  state.users = users;
  state.products = products;
  state.categories = categories;
  state.customers = customers;
  state.suppliers = suppliers;
  state.wallets = wallets;
  state.expenses = expenses;
  state.sales = sales;
  document.documentElement.dataset.theme = state.settings.theme || 'dark';
}

async function saveAI() {
  state.ai.key = 'ai';
  await dbPut('settings', state.ai);
}

async function saveGoogle() {
  state.google.key = 'google';
  await dbPut('settings', state.google);
}

// Session-scoped token cache. Access tokens expire ~1h; we re-request silently.
const GOOG_TOK_KEY = 'lysipos:googleToken';
function readGoogleToken() {
  try {
    const j = JSON.parse(sessionStorage.getItem(GOOG_TOK_KEY) || 'null');
    if (!j) return null;
    if (Date.now() > (j.expiresAt || 0) - 30_000) return null;
    return j;
  } catch { return null; }
}
function writeGoogleToken(tok, extra = {}) {
  const rec = { access_token: tok.access_token, scope: tok.scope, expiresAt: Date.now() + (tok.expires_in || 3600) * 1000, ...extra };
  sessionStorage.setItem(GOOG_TOK_KEY, JSON.stringify(rec));
  return rec;
}
async function googleGetToken(scopes = [DRIVE_SCOPE, USERINFO_SCOPE], { forceConsent = false } = {}) {
  const cached = readGoogleToken();
  if (cached && !forceConsent && scopes.every(s => (cached.scope || '').includes(s))) return cached;
  const tok = await googleRequestToken(state.google.clientId, scopes, forceConsent ? { prompt: 'consent' } : {});
  let email = cached?.email || null;
  try { const info = await googleUserInfo(tok.access_token); email = info.email; } catch {}
  return writeGoogleToken(tok, { email });
}
async function googleSignOut() {
  const cached = readGoogleToken();
  if (cached?.access_token) { try { await googleRevokeToken(cached.access_token); } catch {} }
  sessionStorage.removeItem(GOOG_TOK_KEY);
}

function canUseAI() {
  if (!state.ai?.enabled) return false;
  if (!state.user) return false;
  if (state.user.role === 'admin') return true;
  if (state.user.role === 'manager' && state.user.aiAccess === true) return true;
  return false;
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

// Ensure at least one working admin exists. Idempotent — safe to call any time.
async function ensureAdmin() {
  const users = await dbGetAll('users');
  const hasWorkingAdmin = users.some(u => u.role === 'admin' && u.active !== false && u.passHash);
  if (hasWorkingAdmin) return null;
  const admin = {
    id: uid('u_'), name: 'Owner',
    email: 'admin@lysipos.local', role: 'admin', active: true,
    pin: '1234', passHash: await sha256('admin123'), createdAt: nowISO()
  };
  await dbPut('users', admin);
  state.users = await dbGetAll('users');
  return admin;
}

/* -------------------- backup / import helpers -------------------- */
function snapshotData() {
  return {
    exportedAt: nowISO(),
    settings: state.settings,
    users: state.users,
    products: state.products,
    categories: state.categories,
    customers: state.customers,
    suppliers: state.suppliers,
    wallets: state.wallets,
    expenses: state.expenses,
    sales: state.sales
  };
}

// Convert a Convex-style dump (with _id/_creationTime, saleItems separate) to LysiPOS shape.
function convertConvexBackup(raw) {
  const now = nowISO();
  const cashierIds = new Set();
  for (const s of raw.sales || []) if (s.userId) cashierIds.add(s.userId);
  for (const e of raw.expenses || []) if (e.userId) cashierIds.add(e.userId);
  const userIdMap = {}; const users = []; let i = 0;
  for (const cid of cashierIds) {
    const id = 'u_' + String(cid).slice(0, 8);
    userIdMap[cid] = { id, name: 'Imported cashier ' + (++i) };
    users.push({ id, name: userIdMap[cid].name, email: `cashier${i}@lysipos.local`, role: 'cashier', active: true, passHash: '', createdAt: now });
  }
  const categories = (raw.categories || []).map(c => ({ id: c._id, name: c.name }));
  const suppliers = (raw.suppliers || []).map(s => ({
    id: s._id, name: s.name || '(unnamed)', contact: s.contactName || '',
    email: s.email || '', phone: s.phone || '', address: s.address || '',
    terms: '', tags: [], notes: '', active: s.isActive !== false,
    createdAt: new Date(s._creationTime || Date.now()).toISOString()
  }));
  const products = (raw.products || []).map(p => ({
    id: p._id, name: p.name, sku: p.sku || '', barcode: p.sku || '',
    category: p.categoryId || '', supplierId: '',
    price: Number(p.price) || 0, cost: Number(p.cost) || 0, stock: Number(p.stock) || 0,
    taxable: true, active: p.isActive !== false,
    unit: p.unit || 'pcs', lowStockThreshold: Number(p.lowStockThreshold) || 5,
    createdAt: new Date(p._creationTime || Date.now()).toISOString()
  }));
  const itemsBySale = new Map();
  for (const it of raw.saleItems || []) {
    if (!itemsBySale.has(it.saleId)) itemsBySale.set(it.saleId, []);
    itemsBySale.get(it.saleId).push({
      productId: it.productId, name: it.productName,
      price: Number(it.unitPrice) || 0, qty: Number(it.quantity) || 0,
      taxable: (Number(it.taxRate) || 0) > 0
    });
  }
  const sales = (raw.sales || []).map(s => ({
    id: s._id, number: s.receiptNumber || 'S' + String(s._id).slice(-8).toUpperCase(),
    items: itemsBySale.get(s._id) || [],
    customerId: null,
    discount: Number(s.discount) || 0,
    tax: Number(s.taxTotal) || 0,
    subtotal: Number(s.subtotal) || 0,
    total: Number(s.total) || 0,
    payment: {
      method: s.paymentMethod || 'cash',
      tendered: Number(s.amountPaid) || Number(s.total) || 0,
      change: Number(s.change) || 0
    },
    cashier: userIdMap[s.userId] || { id: '', name: 'Imported' },
    note: '',
    createdAt: s.date || new Date(s._creationTime || Date.now()).toISOString(),
    refunded: s.status === 'refunded' || s.status === 'voided'
  }));
  const expenseCatMap = {};
  for (const c of raw.expenseCategories || []) expenseCatMap[c._id] = c.name;
  const expenses = (raw.expenses || []).map(e => ({
    id: e._id, amount: Number(e.amount) || 0,
    description: e.description || '',
    category: expenseCatMap[e.categoryId] || 'General',
    date: e.date || new Date(e._creationTime || Date.now()).toISOString(),
    userId: userIdMap[e.userId]?.id || '',
    createdAt: new Date(e._creationTime || Date.now()).toISOString()
  }));
  return {
    exportedAt: now, importedFrom: 'convex-style',
    settings: { ...DEFAULT_SETTINGS, businessName: 'Imported Store' },
    users, categories, suppliers, products, customers: [], sales, expenses
  };
}

// Detect format and normalize to LysiPOS shape.
function normalizeImport(data) {
  if (!data || typeof data !== 'object') throw new Error('Not a JSON object');
  const looksNative = Array.isArray(data.products) && data.products.some(p => 'id' in p && !('_id' in p));
  const looksConvex = Array.isArray(data.products) && data.products.some(p => '_id' in p);
  if (looksConvex && !looksNative) return convertConvexBackup(data);
  // Native LysiPOS backup
  return data;
}

async function applyImport(data) {
  const norm = normalizeImport(data);
  for (const store of ['products', 'categories', 'customers', 'suppliers', 'wallets', 'sales', 'users', 'expenses']) {
    await dbClear(store);
    for (const row of (norm[store] || [])) await dbPut(store, row);
  }
  if (norm.settings) await dbPut('settings', { ...DEFAULT_SETTINGS, ...norm.settings, key: 'app' });
  await loadAll();
  // Guarantee a working admin so the operator can log in after import
  const added = await ensureAdmin();
  await audit('data.import', {
    products: (norm.products || []).length,
    sales: (norm.sales || []).length,
    suppliers: (norm.suppliers || []).length,
    categories: (norm.categories || []).length,
    expenses: (norm.expenses || []).length,
    addedDefaultAdmin: !!added
  });
  return { ...norm, addedDefaultAdmin: !!added };
}

/* Rolling in-app backups */
async function saveRollingBackup(reason = 'manual') {
  const data = snapshotData();
  const rec = { id: uid('b_'), at: nowISO(), reason, size: JSON.stringify(data).length, data };
  await dbPut('backups', rec);
  // rotate: keep only autoBackupKeep newest
  const keep = Number(state.settings.autoBackupKeep) || 10;
  const all = (await dbGetAll('backups')).sort((a, b) => (a.at < b.at ? 1 : -1));
  for (const old of all.slice(keep)) await dbDel('backups', old.id);
  return rec;
}

/* File System Access API — optional per-folder auto-save (Chrome/Edge) */
const FS_KEY = 'lysipos:backupDir';
async function pickBackupFolder() {
  if (!('showDirectoryPicker' in window)) { toast('Your browser does not support folder picking. Backups will download instead.', 'warn'); return null; }
  try {
    const handle = await window.showDirectoryPicker({ id: 'lysipos-backups', mode: 'readwrite' });
    // Store via IndexedDB directly (settings store keeps only serializable stuff)
    const t = await tx('settings', 'readwrite');
    await new Promise((res, rej) => { const r = t.objectStore('settings').put({ key: FS_KEY, handle }); r.onsuccess = res; r.onerror = () => rej(r.error); });
    toast('Backup folder linked', 'good');
    return handle;
  } catch (e) { if (e?.name !== 'AbortError') toast('Folder pick failed: ' + e.message, 'bad'); return null; }
}
async function getBackupFolder() {
  const rec = await dbGet('settings', FS_KEY);
  const handle = rec?.handle;
  if (!handle) return null;
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') return handle;
    const req = await handle.requestPermission({ mode: 'readwrite' });
    return req === 'granted' ? handle : null;
  } catch { return null; }
}
async function writeBackupToFolder(handle, jsonText) {
  const fname = `lysipos-backup-${dayKey()}.json`;
  const fh = await handle.getFileHandle(fname, { create: true });
  const w = await fh.createWritable();
  await w.write(jsonText); await w.close();
  return fname;
}

async function maybeAutoBackup() {
  const s = state.settings;
  if (!s || s.autoBackup === 'off' || !s.autoBackup) return;
  const last = s.lastAutoBackupAt ? new Date(s.lastAutoBackupAt).getTime() : 0;
  const now = Date.now();
  const intervalMs = s.autoBackup === 'weekly' ? 7 * 864e5 : 864e5;
  if (now - last < intervalMs) return;
  try {
    const rec = await saveRollingBackup('auto');
    state.settings.lastAutoBackupAt = nowISO();
    await saveSettings();
    // Try folder write
    const handle = await getBackupFolder();
    if (handle) {
      try { const name = await writeBackupToFolder(handle, JSON.stringify(rec.data, null, 2)); toast('Auto-backup saved to folder: ' + name, 'good'); }
      catch (e) { console.warn('Folder write failed', e); toast('Auto-backup saved in-app (folder write failed)', 'warn'); }
    } else {
      toast('Auto-backup saved (in-app)', 'good');
    }
  } catch (e) { console.error(e); }
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
  const wals = await dbGetAll('wallets');
  if (wals.length === 0) {
    for (const name of ['GCash', 'PayMaya', 'GoTyme']) {
      await dbPut('wallets', { id: uid('w_'), name, balance: 0, active: true, createdAt: nowISO() });
    }
  }
  const sups = await dbGetAll('suppliers');
  if (sups.length === 0) {
    const demo = [
      ['Global Beans Co.', 'Maria Chen', 'orders@globalbeans.example', '+1 555-0201', 'Net 30', ['coffee','wholesale']],
      ['Sunrise Bakery Supply', 'Ade Okoro', 'sales@sunrisebakery.example', '+1 555-0202', 'Net 15', ['bakery']],
      ['ValuMart Distributors', 'Priya Rao', 'info@valumart.example', '+1 555-0203', 'COD', ['grocery','household']]
    ];
    for (const [name, contact, email, phone, terms, tags] of demo) {
      await dbPut('suppliers', {
        id: uid('sp_'), name, contact, email, phone, address: '',
        terms, tags, notes: '', active: true, createdAt: nowISO()
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
  // Wire sorting on any table.data on the current page
  setTimeout(() => applySortableToAll(view), 0);
}

window.addEventListener('hashchange', renderCurrent);

// Global delegate: any element with data-nav="#/route" behaves like a hash link.
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-nav]');
  if (!el) return;
  // Ignore clicks on nested inputs, buttons, or real links inside the row
  if (e.target.closest('button, a, input, select, textarea')) return;
  const href = el.getAttribute('data-nav');
  if (href) { e.preventDefault(); location.hash = href; }
});

/* -------------------- generic table sorting -------------------- */
function sortRows(tbody, colIdx, dir) {
  const rows = Array.from(tbody.children).filter(r => r.tagName === 'TR' && r.children[colIdx]);
  if (!rows.length) return;

  const getKey = (row) => {
    const cell = row.children[colIdx]; if (!cell) return '';
    // Prefer data-sort override on the cell if provided
    if (cell.hasAttribute('data-sort')) {
      const v = cell.getAttribute('data-sort');
      const n = parseFloat(v);
      return isNaN(n) ? v.toLowerCase() : n;
    }
    // If cell contains a form field, read its current value
    const input = cell.querySelector('input, select, textarea');
    let txt = input ? String(input.value ?? '') : cell.textContent;
    txt = txt.trim();
    if (txt === '' || txt === '—') return { empty: true };
    // Numeric? Strip currency symbols, commas, spaces, keep -.
    const numeric = txt.replace(/[^\d.\-]/g, '');
    if (numeric && !isNaN(parseFloat(numeric)) && /^\s*[-+]?[\d,.\s]*(?:\.\d+)?\s*[A-Za-z₱$€£¥%]*$/.test(txt.replace(/[₱$€£¥%,]/g, ''))) {
      const asNum = parseFloat(numeric);
      if (!isNaN(asNum)) return asNum;
    }
    // Date? Only if it looks date-ish
    if (/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(txt)) {
      const t = Date.parse(txt);
      if (!isNaN(t)) return t;
    }
    return txt.toLowerCase();
  };

  const mul = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const ka = getKey(a), kb = getKey(b);
    // Empties always go to the bottom regardless of direction
    if (ka?.empty && !kb?.empty) return 1;
    if (kb?.empty && !ka?.empty) return -1;
    if (ka?.empty && kb?.empty) return 0;
    if (typeof ka === 'number' && typeof kb === 'number') return (ka - kb) * mul;
    return String(ka).localeCompare(String(kb), undefined, { numeric: true }) * mul;
  });

  const frag = document.createDocumentFragment();
  for (const r of rows) frag.appendChild(r);
  tbody.appendChild(frag);
}

function makeSortable(table) {
  if (!table || table.dataset.sortable === '1') return;
  const thead = table.tHead; if (!thead) return;
  const ths = thead.querySelectorAll('th');
  if (!ths.length) return;
  table.dataset.sortable = '1';

  ths.forEach((th, colIdx) => {
    if (th.hasAttribute('data-nosort')) return;
    // Skip header cells with no meaningful text (like checkbox columns or action columns)
    if (!th.textContent.trim() && !th.hasAttribute('data-sortable')) return;
    th.classList.add('sortable-th');
    if (!th.querySelector('.sort-arrow')) {
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.textContent = '⇅';
      th.appendChild(arrow);
    }
    th.addEventListener('click', (e) => {
      // Don't sort if the click was on an input/button that sits in the header
      if (e.target.closest('input, button, select, textarea, a')) return;
      const curCol = table.dataset.sortCol;
      const curDir = table.dataset.sortDir;
      const dir = (String(colIdx) === curCol && curDir === 'asc') ? 'desc' : 'asc';
      table.dataset.sortCol = String(colIdx);
      table.dataset.sortDir = dir;
      // Reset arrows
      thead.querySelectorAll('.sort-arrow').forEach(a => { a.textContent = '⇅'; a.parentElement.classList.remove('sorted-asc', 'sorted-desc'); });
      const arrow = th.querySelector('.sort-arrow');
      arrow.textContent = dir === 'asc' ? '↑' : '↓';
      th.classList.add(dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      const tbody = table.tBodies[0]; if (tbody) sortRows(tbody, colIdx, dir);
    });
  });

  // Keep sort applied through internal tbody re-renders (e.g. filter changes)
  const tbody = table.tBodies[0];
  if (tbody && 'MutationObserver' in window) {
    const obs = new MutationObserver((mutations) => {
      if (table._sortRestoring) return;
      if (table.dataset.sortCol == null) return;
      if (!mutations.some(m => m.addedNodes.length > 0)) return;
      table._sortRestoring = true;
      try {
        sortRows(tbody, Number(table.dataset.sortCol), table.dataset.sortDir || 'asc');
        obs.takeRecords();
      } finally { table._sortRestoring = false; }
    });
    obs.observe(tbody, { childList: true });
  }
}

function applySortableToAll(root = document) {
  root.querySelectorAll('table.data').forEach(makeSortable);
}

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
          <a href="#/labels">🏷️ Labels</a>
          <a href="#/wallets">💳 Wallets</a>
          <a href="#/suppliers">🚚 Suppliers</a>
          <div class="section">CRM</div>
          <a href="#/customers">👥 Customers</a>
          <a href="#/reports">📈 Reports</a>
          <div class="section">Admin</div>
          <a href="#/users">🔐 Users</a>
          <a href="#/settings">⚙️ Settings</a>
          <a href="#/dev">🛠️ Dev Console</a>
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
          ${canUseAI() ? '<button class="btn small" id="aiBtn" title="Open AI Assistant">✨ Ask AI</button>' : ''}
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
  $('#aiBtn')?.addEventListener('click', openAIChat);
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
      <div class="sub">Overview of today's activity and this week. <span class="muted">— cards below are clickable.</span></div>
      <div class="grid cols-4" style="margin-bottom:14px">
        <a class="kpi kpi-link" href="#/sales" title="Open Sales history">
          <div class="label">Today's Revenue</div>
          <div class="value">${money(revToday)}</div>
          <div class="delta">${salesToday.length} orders →</div>
        </a>
        <a class="kpi kpi-link" href="#/sales" title="Open Sales history">
          <div class="label">Items Sold Today</div>
          <div class="value">${items}</div>
          <div class="delta">Avg ticket ${money(avg)} →</div>
        </a>
        <a class="kpi kpi-link" href="#/reports" title="Open Reports">
          <div class="label">Week Revenue</div>
          <div class="value">${money(revWeek)}</div>
          <div class="delta">${salesWeek.length} orders →</div>
        </a>
        <a class="kpi kpi-link" href="#/customers" title="Open Customers">
          <div class="label">Customers</div>
          <div class="value">${state.customers.length}</div>
          <div class="delta"><a href="#/products" onclick="event.stopPropagation()" style="color:var(--accent)">${state.products.length} products →</a></div>
        </a>
      </div>
      <div class="grid cols-2">
        <a class="card card-link" href="#/reports" title="Open Reports">
          <div class="card-h"><h3>Last 7 days</h3><div class="spacer"></div><span class="pill">View reports →</span></div>
          <div class="card-b">
            <div style="display:flex;gap:6px;height:80px;align-items:flex-end">${spark}</div>
            <div style="display:flex;gap:6px;color:var(--muted);font-size:11px;margin-top:6px">
              ${days.map(d => `<div style="flex:1;text-align:center">${d.d.slice(5)}</div>`).join('')}
            </div>
          </div>
        </a>
        <div class="card">
          <div class="card-h"><h3>Top products (7d)</h3><div class="spacer"></div><a class="btn small" href="#/products">All products</a></div>
          <div class="card-b">
            ${topProducts.length ? html`<table class="data clickable-rows"><thead><tr><th>Product</th><th class="right">Qty</th></tr></thead>
              <tbody>${topProducts.map(t => `<tr data-nav="#/products"><td>${escapeHtml(t.product?.name || '—')}</td><td class="right mono">${t.qty}</td></tr>`).join('')}</tbody></table>`
              : '<div class="empty"><div class="icn">📦</div>No sales yet — try ringing one up in <a href="#/pos">POS</a>.</div>'}
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-h"><h3>Low stock</h3><div class="spacer"></div><a class="btn small" href="#/inventory">Manage</a></div>
        <div class="card-b">
          ${lowStock.length ? html`<table class="data clickable-rows"><thead><tr><th>Product</th><th>SKU</th><th class="right">Stock</th></tr></thead>
              <tbody>${lowStock.map(p => `<tr data-nav="#/inventory"><td>${escapeHtml(p.name)}</td><td class="mono">${escapeHtml(p.sku||'')}</td><td class="right"><span class="badge ${p.stock<=0?'bad':'warn'}">${p.stock ?? 0}</span></td></tr>`).join('')}</tbody></table>`
              : '<div class="muted">All products are well stocked. <a href="#/inventory">Adjust stock</a></div>'}
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
  const isWallet = !!product.walletFlow;
  if (!isWallet) {
    // Regular product — check physical stock
    if ((product.stock ?? 0) < qty) { toast('Not enough stock', 'warn'); return; }
    const existing = state.cart.items.find(i => i.productId === product.id);
    if (existing && product.stock < existing.qty + qty) { toast('Not enough stock', 'warn'); return; }
  } else if (product.walletFlow === 'cashin') {
    // Cash-in draws from the store's wallet balance
    const w = state.wallets.find(x => x.id === product.walletId);
    if (!w) { toast('Wallet not found for this product', 'bad'); return; }
    const need = (Number(product.walletAmount) || 0) * qty;
    // Include everything already queued for this same wallet as cash-in
    const inCart = state.cart.items.reduce((n, i) => {
      if (i.walletFlow === 'cashin' && i.walletId === w.id) return n + (Number(i.walletAmount) || 0) * i.qty;
      return n;
    }, 0);
    if (inCart + need > w.balance + 0.0001) {
      toast(`Not enough ${w.name} balance (${money(w.balance)} available).`, 'warn');
      return;
    }
  }
  const existing = state.cart.items.find(i => i.productId === product.id);
  if (existing) {
    existing.qty += qty;
  } else {
    state.cart.items.push({
      productId: product.id, name: product.name, price: product.price, qty,
      taxable: product.taxable !== false,
      // Wallet snapshot so refunds still work if the product is edited later
      walletId: product.walletId || null,
      walletFlow: product.walletFlow || null,
      walletAmount: Number(product.walletAmount) || 0
    });
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
    const isWallet = !!p.walletFlow;
    let disabled = false, meta = '';
    if (isWallet) {
      const w = state.wallets.find(x => x.id === p.walletId);
      const bal = w ? w.balance : 0;
      if (p.walletFlow === 'cashin') disabled = !w || bal < (Number(p.walletAmount) || 0);
      meta = `${p.walletFlow === 'cashin' ? '↑ Cash-in' : '↓ Cash-out'} · ${money(p.walletAmount || 0)}${w ? ' · ' + w.name + ' ' + money(bal) : ''}`;
    } else {
      disabled = (p.stock ?? 0) <= 0;
      meta = `Stock: ${p.stock ?? 0} · ${escapeHtml(p.sku || '')}`;
    }
    return html`
      <div class="product-card ${disabled ? 'oos' : ''}" data-pid="${p.id}">
        <div class="p-name">${escapeHtml(p.name)} ${isWallet ? '<span class="badge">💳</span>' : ''}</div>
        <div class="p-price">${money(p.price)}${isWallet ? ' <span class="muted" style="font-size:10px;font-weight:400">fee</span>' : ''}</div>
        <div class="p-meta">${meta}</div>
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
  // decrement stock (skip wallet lines) and update wallet balances
  for (const li of sale.items) {
    if (li.walletFlow) {
      const w = state.wallets.find(x => x.id === li.walletId);
      if (w) {
        const delta = (Number(li.walletAmount) || 0) * li.qty;
        w.balance = (Number(w.balance) || 0) + (li.walletFlow === 'cashout' ? delta : -delta);
        await dbPut('wallets', w);
      }
    } else {
      const p = state.products.find(x => x.id === li.productId);
      if (p) { p.stock = Math.max(0, (p.stock || 0) - li.qty); await dbPut('products', p); }
    }
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
        <input id="posSearch" placeholder="Search name, SKU or scan barcode…  (F2)" autofocus />
        <button class="btn" id="posScan" title="Scan with camera (F3)">📷 Scan</button>
        <button class="btn" id="posHelp" title="Keyboard shortcuts (F1)">⌨️</button>
        <select id="posCat" style="max-width:180px">
          <option value="">All categories</option>
          ${state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      ${state.wallets.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${state.wallets.filter(w => w.active !== false).map(w => `<a class="pill" href="#/wallets" title="Open wallets" style="text-decoration:none;color:inherit">💳 ${escapeHtml(w.name)}: <b style="color:${(w.balance||0) < 0 ? 'var(--bad)' : 'var(--accent)'}">${money(w.balance||0)}</b></a>`).join('')}</div>` : ''}
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
    $('#posScan', el).addEventListener('click', async () => {
      if (!isScannerSupported()) { toast('Camera scanning not supported on this browser. Use a keyboard-wedge scanner instead.', 'warn'); return; }
      try {
        const { value, format } = await openScanner();
        const term = String(value).trim();
        const exact = state.products.find(p => p.barcode === term || p.sku?.toLowerCase() === term.toLowerCase());
        if (exact) { addToCart(exact); toast(`Added: ${exact.name} (${format})`, 'good'); }
        else { $('#posSearch', el).value = term; POS.filterText = term; renderCatalog(); toast(`Scanned ${format}: ${term} — no product found`, 'warn'); }
      } catch (e) { if (e.message !== 'cancelled') toast(e.message, 'bad'); }
    });
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

    /* ---------- Keyboard shortcuts (scoped to POS route) ---------- */
    const SHORTCUTS = [
      { keys: 'F1',        label: 'Show this help' },
      { keys: 'F2 / Ctrl+K', label: 'Focus search / scan box' },
      { keys: 'F3',        label: 'Open camera scanner' },
      { keys: 'F4',        label: 'Attach a customer' },
      { keys: 'F6',        label: 'Hold the current sale' },
      { keys: 'F7',        label: 'Clear the cart' },
      { keys: 'F9 / Ctrl+Enter', label: 'Charge / open checkout' },
      { keys: '+',         label: 'Increase quantity of the last line' },
      { keys: '−',         label: 'Decrease quantity of the last line' },
      { keys: 'Delete',    label: 'Remove the last line' },
      { keys: 'Esc',       label: 'Clear search box' },
      { keys: 'Enter',     label: '(inside search) Add exact SKU/barcode match to cart' }
    ];
    const openShortcutsHelp = () => {
      const body = document.createElement('div');
      body.innerHTML = html`
        <table class="data" style="width:100%">
          <thead><tr><th style="width:35%">Shortcut</th><th>Action</th></tr></thead>
          <tbody>
            ${SHORTCUTS.map(s => `<tr><td class="mono">${escapeHtml(s.keys)}</td><td>${escapeHtml(s.label)}</td></tr>`).join('')}
          </tbody>
        </table>
        <div class="muted" style="font-size:12px;margin-top:10px">Tip: shortcuts on function keys (F1–F9) work even while typing in the search box. The <b>+/−/Delete</b> keys only fire when no input is focused.</div>`;
      openModal({ title: '⌨️ POS keyboard shortcuts', body, footer: '<button class="btn primary" data-close2>Close</button>', size: 'lg' })
        .footEl.querySelector('[data-close2]').addEventListener('click', (e) => e.target.closest('.modal-back').remove());
    };
    $('#posHelp', el).addEventListener('click', openShortcutsHelp);

    const inField = () => {
      const a = document.activeElement;
      if (!a) return false;
      if (a.isContentEditable) return true;
      return /INPUT|TEXTAREA|SELECT/.test(a.tagName);
    };
    const posKeyHandler = (e) => {
      // Never hijack when a modal is open
      if (document.querySelector('.modal-back')) return;

      // Function keys — work even inside inputs
      if (e.key === 'F1') { e.preventDefault(); openShortcutsHelp(); return; }
      if (e.key === 'F2') { e.preventDefault(); const s = $('#posSearch', el); s?.focus(); s?.select(); return; }
      if (e.key === 'F3') { e.preventDefault(); $('#posScan', el)?.click(); return; }
      if (e.key === 'F4') { e.preventDefault(); $('#cartCust', el)?.click(); return; }
      if (e.key === 'F6') { e.preventDefault(); $('#cartHold', el)?.click(); return; }
      if (e.key === 'F7') { e.preventDefault(); $('#cartClear', el)?.click(); return; }
      if (e.key === 'F9') { e.preventDefault(); $('#cartPay', el)?.click(); return; }

      // Combos with Ctrl (or Meta on macOS)
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); const s = $('#posSearch', el); s?.focus(); s?.select(); return; }
      if (mod && e.key === 'Enter') { e.preventDefault(); $('#cartPay', el)?.click(); return; }
      if (mod && e.key === 'Backspace') { e.preventDefault(); $('#cartClear', el)?.click(); return; }

      // Esc — clear the search box if it's focused; otherwise leave it alone
      if (e.key === 'Escape') {
        const s = $('#posSearch', el);
        if (document.activeElement === s && s.value) {
          s.value = ''; POS.filterText = ''; renderCatalog();
        }
        return;
      }

      // Line-level shortcuts (only when no input is focused)
      if (inField()) return;
      const last = state.cart.items[state.cart.items.length - 1];
      if (!last) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); setQty(last.productId, last.qty + 1); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); setQty(last.productId, last.qty - 1); return; }
      if (e.key === 'Delete')             { e.preventDefault(); removeFromCart(last.productId); return; }
    };

    // Scope the listener to this route mount — auto-cleanup on hashchange
    const ac = new AbortController();
    window.addEventListener('keydown', posKeyHandler, { signal: ac.signal });
    window.addEventListener('hashchange', () => ac.abort(), { once: true });
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
      <div class="field"><label>Barcode</label>
        <div style="display:flex;gap:6px">
          <input name="barcode" value="${escapeHtml(existing.barcode || '')}" style="flex:1" />
          <button type="button" class="btn small" data-scan-code title="Scan with camera">📷</button>
          <button type="button" class="btn small" data-copy-sku title="Copy SKU into Barcode">= SKU</button>
        </div>
      </div>
      <div class="field"><label>Category</label>
        <select name="category"><option value="">—</option>${state.categories.map(c => `<option value="${c.id}" ${existing.category === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Supplier</label>
        <select name="supplierId"><option value="">—</option>${state.suppliers.map(sp => `<option value="${sp.id}" ${existing.supplierId === sp.id ? 'selected' : ''}>${escapeHtml(sp.name)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Price / Fee</label><input name="price" type="number" step="0.01" min="0" value="${existing.price ?? 0}" /></div>
      <div class="field"><label>Cost</label><input name="cost" type="number" step="0.01" min="0" value="${existing.cost ?? 0}" /></div>
      <div class="field"><label>Stock <span class="muted" style="font-weight:400">(ignored for wallet products)</span></label><input name="stock" type="number" step="1" min="0" value="${existing.stock ?? 0}" /></div>
      <div class="field"><label>Taxable</label>
        <select name="taxable"><option value="1" ${existing.taxable !== false ? 'selected' : ''}>Yes</option><option value="0" ${existing.taxable === false ? 'selected' : ''}>No</option></select>
      </div>
      <div class="field"><label>Active</label>
        <select name="active"><option value="1" ${existing.active !== false ? 'selected' : ''}>Yes</option><option value="0" ${existing.active === false ? 'selected' : ''}>No</option></select>
      </div>
      <div class="field"><label>Wallet flow</label>
        <select name="walletFlow">
          <option value="" ${!existing.walletFlow ? 'selected' : ''}>— none (regular product) —</option>
          <option value="cashin"  ${existing.walletFlow === 'cashin'  ? 'selected' : ''}>Cash-in (customer pays cash → wallet decreases)</option>
          <option value="cashout" ${existing.walletFlow === 'cashout' ? 'selected' : ''}>Cash-out (customer sends to wallet → wallet increases)</option>
        </select>
      </div>
      <div class="field"><label>Wallet</label>
        <select name="walletId">
          <option value="">—</option>
          ${state.wallets.map(w => `<option value="${w.id}" ${existing.walletId === w.id ? 'selected' : ''}>${escapeHtml(w.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="grid-column:1/-1"><label>Wallet amount <span class="muted" style="font-weight:400">(the transaction value that moves in/out of the wallet — Price above is the fee your customer pays)</span></label>
        <input name="walletAmount" type="number" step="0.01" min="0" value="${existing.walletAmount ?? 0}" />
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
          <thead><tr><th>Name</th><th>SKU</th><th>Category</th><th>Supplier</th><th class="right">Price</th><th class="right">Stock</th><th></th></tr></thead>
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
    const supName = (id) => state.suppliers.find(s => s.id === id)?.name || '—';
    $('tbody', el).innerHTML = list.map(p => html`
      <tr data-id="${p.id}">
        <td>${escapeHtml(p.name)} ${p.active === false ? '<span class="badge">inactive</span>' : ''}</td>
        <td class="mono">${escapeHtml(p.sku || '')}</td>
        <td>${escapeHtml(catName(p.category))}</td>
        <td>${escapeHtml(supName(p.supplierId))}</td>
        <td class="right mono">${money(p.price)}</td>
        <td class="right"><span class="badge ${p.stock <= 0 ? 'bad' : p.stock <= 5 ? 'warn' : 'good'}">${p.stock ?? 0}</span></td>
        <td class="right"><button class="btn small" data-edit>Edit</button> <button class="btn small danger" data-del>Delete</button></td>
      </tr>`).join('') || `<tr><td colspan="7"><div class="empty">No products</div></td></tr>`;

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
    // Double-click any row to open the edit dialog
    el.querySelectorAll('#pTable tbody tr[data-id]').forEach(tr => {
      tr.style.cursor = 'pointer';
      tr.title = 'Double-click to edit';
      tr.addEventListener('dblclick', (ev) => {
        if (ev.target.closest('button, input, select, a')) return;
        const p = state.products.find(x => x.id === tr.dataset.id);
        if (p) openProduct(p);
      });
    });
  };

  const openProduct = (existing) => {
    const body = productForm(existing || {});
    // Barcode / QR preview + generate panel
    const previewBox = document.createElement('div');
    previewBox.style.marginTop = '10px';
    previewBox.innerHTML = html`
      <div class="card"><div class="card-h"><h3>Label preview</h3><div class="spacer"></div>
        <span class="pill" id="pvKind">Barcode (Code128)</span>
      </div>
        <div class="card-b">
          <div class="row" style="margin-bottom:8px">
            <button type="button" class="btn small" data-pv-bar>📊 Show barcode</button>
            <button type="button" class="btn small" data-pv-qr>▦ Show QR (product info)</button>
            <button type="button" class="btn small" data-pv-dl>⤓ Download SVG</button>
          </div>
          <div id="pvOut" style="background:#fff;padding:14px;border-radius:10px;display:grid;place-items:center;min-height:120px"></div>
          <div class="muted" style="margin-top:6px;font-size:12px">Barcode encodes the <b>Barcode</b> field (or SKU if blank). QR encodes JSON with name/SKU/price so any QR reader shows product details.</div>
        </div>
      </div>`;
    body.appendChild(previewBox);

    const renderPreview = (kind = 'bar') => {
      const d = readForm(body);
      const out = $('#pvOut', previewBox);
      const kindPill = $('#pvKind', previewBox);
      try {
        if (kind === 'qr') {
          const payload = JSON.stringify({ name: d.name || '', sku: d.sku || '', barcode: d.barcode || '', price: Number(d.price) || 0 });
          out.innerHTML = qrSvg(payload, { scale: 5, margin: 3 });
          kindPill.textContent = 'QR code';
          previewBox.dataset.kind = 'qr';
          previewBox.dataset.value = payload;
        } else {
          const value = (d.barcode || d.sku || '').trim();
          if (!value) { out.innerHTML = '<div class="muted">Enter a Barcode or SKU to preview.</div>'; return; }
          out.innerHTML = code128BSvg(value, { moduleWidth: 2, height: 60 });
          kindPill.textContent = 'Barcode (Code128)';
          previewBox.dataset.kind = 'bar';
          previewBox.dataset.value = value;
        }
      } catch (e) { out.innerHTML = `<div class="muted">Cannot render: ${escapeHtml(e.message)}</div>`; }
    };

    queueMicrotask(() => {
      renderPreview('bar');
      previewBox.querySelector('[data-pv-bar]').addEventListener('click', () => renderPreview('bar'));
      previewBox.querySelector('[data-pv-qr]').addEventListener('click', () => renderPreview('qr'));
      previewBox.querySelector('[data-pv-dl]').addEventListener('click', () => {
        const svg = $('#pvOut', previewBox).innerHTML;
        if (!svg.startsWith('<svg')) { toast('Nothing to download', 'warn'); return; }
        const blob = new Blob([svg], { type: 'image/svg+xml' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        const label = (readForm(body).sku || 'label').replace(/[^\w-]+/g, '_');
        a.download = `${label}-${previewBox.dataset.kind}.svg`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      });
      // Live-refresh when relevant inputs change
      body.querySelectorAll('input[name="sku"], input[name="barcode"], input[name="name"], input[name="price"]').forEach(inp => {
        inp.addEventListener('input', () => renderPreview(previewBox.dataset.kind || 'bar'));
      });
      body.querySelector('[data-copy-sku]')?.addEventListener('click', () => {
        const sku = body.querySelector('input[name="sku"]').value.trim();
        body.querySelector('input[name="barcode"]').value = sku;
        renderPreview('bar');
      });
      body.querySelector('[data-scan-code]')?.addEventListener('click', async () => {
        if (!isScannerSupported()) { toast('Camera scanning not supported. Use a keyboard-wedge scanner into the field.', 'warn'); return; }
        try {
          const { value } = await openScanner();
          body.querySelector('input[name="barcode"]').value = value;
          renderPreview('bar');
        } catch (e) { if (e.message !== 'cancelled') toast(e.message, 'bad'); }
      });
    });

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
        supplierId: d.supplierId || '',
        price: Number(d.price) || 0, cost: Number(d.cost) || 0, stock: Number(d.stock) || 0,
        taxable: d.taxable === '1', active: d.active === '1',
        walletFlow: d.walletFlow || '', walletId: d.walletId || '',
        walletAmount: Number(d.walletAmount) || 0
      });
      if (rec.walletFlow && !rec.walletId) { toast('Wallet flow requires a wallet to be selected.', 'bad'); return; }
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

/* Labels — print sheets of product barcodes / QR codes on real paper sizes */
const PAPER_SIZES = {
  a4:         { name: 'A4',                 w: 210,   h: 297 },
  letter:     { name: 'Short bond (Letter)', w: 215.9, h: 279.4 },
  legal:      { name: 'Long bond (Legal)',   w: 215.9, h: 355.6 }
};

route('/labels', async () => {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = html`
    <h1>Labels</h1><div class="sub">Generate print-ready sheets of product barcodes or QR codes.</div>
    <div class="card no-print">
      <div class="card-h" style="flex-wrap:wrap;gap:8px">
        <label style="margin:0">Type</label>
        <select id="lbKind" style="max-width:170px">
          <option value="bar">Barcode (Code128)</option>
          <option value="qr">QR (product info)</option>
        </select>
        <label style="margin:0 0 0 6px">Paper</label>
        <select id="lbPaper" style="max-width:200px">
          <option value="a4">A4 (210 × 297 mm)</option>
          <option value="letter" selected>Short bond / Letter (8.5 × 11 in)</option>
          <option value="legal">Long bond / Legal (8.5 × 14 in)</option>
        </select>
        <label style="margin:0 0 0 6px">Orient.</label>
        <select id="lbOrient" style="max-width:130px">
          <option value="portrait" selected>Portrait</option>
          <option value="landscape">Landscape</option>
        </select>
        <label style="margin:0 0 0 6px">Cols × Rows</label>
        <select id="lbCols" style="max-width:70px">
          <option>2</option><option selected>3</option><option>4</option><option>5</option><option>6</option>
        </select>
        <span>×</span>
        <select id="lbRows" style="max-width:70px">
          <option>4</option><option>6</option><option>8</option><option selected>10</option><option>12</option>
        </select>
        <label style="margin:0 0 0 6px">Margin</label>
        <select id="lbMargin" style="max-width:90px">
          <option value="5">5 mm</option>
          <option value="8" selected>8 mm</option>
          <option value="10">10 mm</option>
          <option value="15">15 mm</option>
        </select>
      </div>
      <div class="card-b" style="border-top:1px solid var(--border);padding-top:10px">
        <div class="row" style="gap:8px">
          <input id="lbFilter" placeholder="Filter products…" style="max-width:260px" />
          <button class="btn small" id="lbAll">Select all filtered</button>
          <button class="btn small" id="lbNone">Clear</button>
          <div class="spacer"></div>
          <span class="pill" id="lbCount">0 labels · 0 pages</span>
          <button class="btn primary small" id="lbPrint">🖨 Print</button>
        </div>
        <div style="max-height:220px;overflow:auto;margin-top:10px">
          <table class="data">
            <thead><tr><th style="width:32px"></th><th>Name</th><th>SKU</th><th>Barcode</th><th class="right">Qty</th></tr></thead>
            <tbody id="lbList"></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card no-print" style="margin-top:14px">
      <div class="card-h"><h3>Preview</h3><div class="spacer"></div><span class="muted" id="lbPageInfo">—</span></div>
      <div class="card-b" style="background:#e5e7eb;padding:16px;display:flex;flex-direction:column;gap:16px;align-items:center" id="lbPreview"></div>
    </div>

    <div id="lbPrintArea" class="print-only"></div>
    <style id="lbStyle"></style>`;

  // In-memory selection: pid -> qty
  const selection = new Map();
  const readCfg = () => ({
    kind: $('#lbKind', el).value,
    paper: PAPER_SIZES[$('#lbPaper', el).value] || PAPER_SIZES.letter,
    paperKey: $('#lbPaper', el).value,
    orient: $('#lbOrient', el).value,
    cols: Math.max(1, Number($('#lbCols', el).value) || 3),
    rows: Math.max(1, Number($('#lbRows', el).value) || 10),
    marginMm: Math.max(0, Number($('#lbMargin', el).value) || 8)
  });

  const buildLabels = () => {
    const items = [];
    for (const [pid, qty] of selection.entries()) {
      const p = state.products.find(x => x.id === pid); if (!p) continue;
      for (let i = 0; i < qty; i++) items.push(p);
    }
    return items;
  };

  const labelHtml = (p, kind) => {
    let svg = '';
    try {
      if (kind === 'qr') {
        const payload = JSON.stringify({ name: p.name, sku: p.sku, barcode: p.barcode, price: p.price });
        svg = qrSvg(payload, { scale: 3, margin: 2 });
      } else {
        const val = p.barcode || p.sku || p.name;
        svg = code128BSvg(val, { moduleWidth: 1.8, height: 44, paddingH: 6, paddingV: 4 });
      }
    } catch (e) { svg = `<div style="color:#c00;font-size:10px">${escapeHtml(e.message)}</div>`; }
    return `<div class="lb-cell">
      <div class="lb-name">${escapeHtml(p.name)}</div>
      <div class="lb-code">${svg}</div>
      <div class="lb-price">${escapeHtml(state.settings.currency)} ${Number(p.price || 0).toFixed(2)} · ${escapeHtml(p.sku || '')}</div>
    </div>`;
  };

  const updateStyle = () => {
    const c = readCfg();
    const pageW = c.orient === 'portrait' ? c.paper.w : c.paper.h;
    const pageH = c.orient === 'portrait' ? c.paper.h : c.paper.w;
    const contentW = pageW - c.marginMm * 2;
    const contentH = pageH - c.marginMm * 2;
    const cellW = contentW / c.cols;
    const cellH = contentH / c.rows;
    // On-screen preview scales mm to px roughly 3.2 (fits a laptop screen)
    const previewScale = 3.2;
    $('#lbStyle', el).textContent = `
      /* On-screen page previews */
      #lbPreview .lb-page {
        width: ${pageW * previewScale}px;
        height: ${pageH * previewScale}px;
        background: #fff;
        box-shadow: 0 4px 18px rgba(0,0,0,.15);
        padding: ${c.marginMm * previewScale}px;
        box-sizing: border-box;
        display: grid;
        grid-template-columns: repeat(${c.cols}, 1fr);
        grid-template-rows: repeat(${c.rows}, 1fr);
        color: #000;
        page-break-after: always;
      }
      #lbPreview .lb-page.empty { display: grid; place-items: center; color: #94a3b8; font-family: system-ui; }
      #lbPreview .lb-cell,
      #lbPrintArea .lb-cell {
        border: 1px dashed #d1d5db;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        overflow: hidden; padding: 2mm; box-sizing: border-box; text-align: center;
      }
      #lbPreview .lb-cell .lb-name, #lbPrintArea .lb-cell .lb-name { font: 600 8pt system-ui; margin-bottom: 1mm; line-height: 1.1; max-height: 3.2em; overflow: hidden; }
      #lbPreview .lb-cell .lb-price, #lbPrintArea .lb-cell .lb-price { font: 7pt ui-monospace,monospace; color: #333; margin-top: 1mm; }
      #lbPreview .lb-cell .lb-code svg, #lbPrintArea .lb-cell .lb-code svg { max-width: 100%; max-height: ${(cellH * 0.65).toFixed(1)}mm; }
      #lbPreview .lb-cell .lb-code, #lbPrintArea .lb-cell .lb-code { display: grid; place-items: center; width: 100%; }

      /* Print area */
      #lbPrintArea { display: none; }
      @media print {
        @page { size: ${c.paperKey === 'a4' ? 'A4' : c.paperKey === 'legal' ? 'legal' : 'letter'} ${c.orient}; margin: ${c.marginMm}mm; }
        body { background: #fff !important; }
        .sidebar, .topbar, .modal-back, #toast, .no-print, .scrim { display: none !important; }
        .layout { display: block !important; }
        .main, #view, .page { padding: 0 !important; margin: 0 !important; }
        #lbPrintArea { display: block; }
        #lbPrintArea .lb-page {
          width: ${contentW}mm;
          height: ${contentH}mm;
          display: grid;
          grid-template-columns: repeat(${c.cols}, 1fr);
          grid-template-rows: repeat(${c.rows}, 1fr);
          page-break-after: always;
          color: #000;
        }
        #lbPrintArea .lb-page:last-child { page-break-after: auto; }
      }
    `;
  };

  const renderSheet = () => {
    updateStyle();
    const c = readCfg();
    const perPage = c.cols * c.rows;
    const items = buildLabels();
    const pageCount = Math.max(1, Math.ceil(items.length / perPage));

    // Build one .lb-page div per page for on-screen preview and print
    const pageDivs = (target) => {
      target.innerHTML = '';
      if (!items.length) {
        const p = document.createElement('div'); p.className = 'lb-page empty';
        p.textContent = 'Select products above to fill the sheet.';
        target.appendChild(p);
        return;
      }
      for (let pi = 0; pi < pageCount; pi++) {
        const p = document.createElement('div'); p.className = 'lb-page';
        const slice = items.slice(pi * perPage, (pi + 1) * perPage);
        p.innerHTML = slice.map(x => labelHtml(x, c.kind)).join('') +
          Array.from({ length: perPage - slice.length }, () => '<div class="lb-cell" style="border-style:dotted;opacity:.35"></div>').join('');
        target.appendChild(p);
      }
    };
    pageDivs($('#lbPreview', el));
    pageDivs($('#lbPrintArea', el));

    $('#lbCount', el).textContent = `${items.length} label${items.length === 1 ? '' : 's'} · ${pageCount} page${pageCount === 1 ? '' : 's'}`;
    const pageWmm = c.orient === 'portrait' ? c.paper.w : c.paper.h;
    const pageHmm = c.orient === 'portrait' ? c.paper.h : c.paper.w;
    const cellWmm = (pageWmm - c.marginMm * 2) / c.cols;
    const cellHmm = (pageHmm - c.marginMm * 2) / c.rows;
    $('#lbPageInfo', el).textContent = `${c.paper.name} ${c.orient} · ${c.cols}×${c.rows} per page · label ≈ ${cellWmm.toFixed(1)}×${cellHmm.toFixed(1)} mm`;
  };

  const rebuildList = () => {
    const term = ($('#lbFilter', el).value || '').trim().toLowerCase();
    const list = state.products.filter(p => p.active !== false && (!term ||
      p.name.toLowerCase().includes(term) || (p.sku || '').toLowerCase().includes(term) || (p.barcode || '').includes(term)))
      .sort((a, b) => a.name.localeCompare(b.name));
    $('#lbList', el).innerHTML = list.map(p => html`
      <tr data-id="${p.id}">
        <td><input type="checkbox" ${selection.has(p.id) ? 'checked' : ''} data-sel></td>
        <td>${escapeHtml(p.name)}</td>
        <td class="mono">${escapeHtml(p.sku || '')}</td>
        <td class="mono">${escapeHtml(p.barcode || '')}</td>
        <td class="right"><input type="number" min="1" max="99" value="${selection.get(p.id) || 1}" style="width:64px;text-align:right" data-qty></td>
      </tr>`).join('') || `<tr><td colspan="5"><div class="empty">No matching products</div></td></tr>`;
    el.querySelectorAll('#lbList [data-sel]').forEach(cb => cb.addEventListener('change', (e) => {
      const tr = e.target.closest('tr'); const id = tr.dataset.id;
      const qty = Math.max(1, Number(tr.querySelector('[data-qty]').value) || 1);
      if (e.target.checked) selection.set(id, qty); else selection.delete(id);
      renderSheet();
    }));
    el.querySelectorAll('#lbList [data-qty]').forEach(inp => inp.addEventListener('input', (e) => {
      const id = e.target.closest('tr').dataset.id;
      if (selection.has(id)) { selection.set(id, Math.max(1, Number(e.target.value) || 1)); renderSheet(); }
    }));
  };

  queueMicrotask(() => {
    ['lbKind','lbPaper','lbOrient','lbCols','lbRows','lbMargin'].forEach(id =>
      $('#' + id, el).addEventListener('change', renderSheet));
    $('#lbFilter', el).addEventListener('input', rebuildList);
    $('#lbAll', el).addEventListener('click', () => {
      el.querySelectorAll('#lbList tr').forEach(tr => {
        const id = tr.dataset.id;
        const qty = Number(tr.querySelector('[data-qty]')?.value) || 1;
        selection.set(id, qty);
        const cb = tr.querySelector('[data-sel]'); if (cb) cb.checked = true;
      });
      renderSheet();
    });
    $('#lbNone', el).addEventListener('click', () => {
      selection.clear(); rebuildList(); renderSheet();
    });
    $('#lbPrint', el).addEventListener('click', () => window.print());
    rebuildList(); renderSheet();
  });
  return el;
});

/* Wallets — e-wallet accounts (GCash, PayMaya, GoTyme, …) with a single shared balance per wallet */
route('/wallets', async () => {
  const el = document.createElement('div');
  el.className = 'page';
  const totalBal = state.wallets.reduce((n, w) => n + (Number(w.balance) || 0), 0);
  el.innerHTML = html`
    <h1>Wallets</h1>
    <div class="sub">One balance per wallet. All cash-in and cash-out products for a wallet share that balance.</div>
    <div class="grid cols-4" style="margin-bottom:14px">
      <div class="kpi"><div class="label">Wallets</div><div class="value">${state.wallets.length}</div></div>
      <div class="kpi"><div class="label">Total balance across wallets</div><div class="value">${money(totalBal)}</div></div>
      <div class="kpi"><div class="label">Cash-in products</div><div class="value">${state.products.filter(p => p.walletFlow === 'cashin').length}</div></div>
      <div class="kpi"><div class="label">Cash-out products</div><div class="value">${state.products.filter(p => p.walletFlow === 'cashout').length}</div></div>
    </div>
    <div class="card">
      <div class="card-h"><div class="spacer"></div><button class="btn primary small" id="wNew">+ New wallet</button></div>
      <div class="card-b" id="wList"></div>
    </div>`;

  const wCard = (w) => {
    const cashInProducts = state.products.filter(p => p.walletFlow === 'cashin' && p.walletId === w.id);
    const cashOutProducts = state.products.filter(p => p.walletFlow === 'cashout' && p.walletId === w.id);
    // Recent movements from sales
    const moves = [];
    for (const s of state.sales) {
      if (s.refunded) continue;
      for (const li of s.items) {
        if (li.walletId === w.id && li.walletFlow) {
          const amt = (Number(li.walletAmount) || 0) * li.qty;
          moves.push({ at: s.createdAt, saleId: s.id, saleNo: s.number, flow: li.walletFlow, amount: amt, name: li.name, qty: li.qty });
        }
      }
    }
    moves.sort((a, b) => (a.at < b.at ? 1 : -1));
    const recent = moves.slice(0, 8);
    return html`
      <div class="card" style="margin-bottom:10px" data-wid="${w.id}">
        <div class="card-h">
          <h3>💳 ${escapeHtml(w.name)} ${w.active === false ? '<span class="badge">inactive</span>' : ''}</h3>
          <div class="spacer"></div>
          <div style="text-align:right">
            <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.08em">Balance</div>
            <div class="mono" style="font-size:20px;font-weight:700;color:${(w.balance||0) < 0 ? 'var(--bad)' : 'var(--accent)'}">${money(w.balance || 0)}</div>
          </div>
        </div>
        <div class="card-b">
          <div class="row" style="gap:6px;margin-bottom:8px">
            <button class="btn small" data-topup>+ Top up (cash → wallet)</button>
            <button class="btn small" data-withdraw>− Withdraw (wallet → cash)</button>
            <button class="btn small" data-set>Set balance directly</button>
            <button class="btn small" data-quickin>Quick-add cash-in denominations</button>
            <button class="btn small" data-quickout>Quick-add cash-out denominations</button>
            <div class="spacer"></div>
            <button class="btn small" data-edit>Edit</button>
            <button class="btn small danger" data-del>Delete</button>
          </div>
          <div class="grid cols-2">
            <div>
              <h4 style="margin:0 0 4px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em">Cash-in products (${cashInProducts.length})</h4>
              ${cashInProducts.length ? html`<table class="data"><thead><tr><th>Name</th><th class="right">Amount</th><th class="right">Fee</th></tr></thead>
                <tbody>${cashInProducts.map(p => `<tr><td>${escapeHtml(p.name)}</td><td class="right mono">${money(p.walletAmount || 0)}</td><td class="right mono">${money(p.price)}</td></tr>`).join('')}</tbody></table>`
                : '<div class="muted" style="font-size:12px">No cash-in products yet. Use <em>Quick-add</em>.</div>'}
            </div>
            <div>
              <h4 style="margin:0 0 4px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em">Cash-out products (${cashOutProducts.length})</h4>
              ${cashOutProducts.length ? html`<table class="data"><thead><tr><th>Name</th><th class="right">Amount</th><th class="right">Fee</th></tr></thead>
                <tbody>${cashOutProducts.map(p => `<tr><td>${escapeHtml(p.name)}</td><td class="right mono">${money(p.walletAmount || 0)}</td><td class="right mono">${money(p.price)}</td></tr>`).join('')}</tbody></table>`
                : '<div class="muted" style="font-size:12px">No cash-out products yet.</div>'}
            </div>
          </div>
          <h4 style="margin:14px 0 4px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em">Recent movements</h4>
          ${recent.length ? html`<table class="data"><thead><tr><th>When</th><th>Sale</th><th>Flow</th><th>Product</th><th class="right">Amount</th></tr></thead>
            <tbody>${recent.map(m => `<tr><td>${fmtDate(m.at)}</td><td class="mono">${m.saleNo}</td><td><span class="badge ${m.flow === 'cashin' ? 'bad' : 'good'}">${m.flow === 'cashin' ? '− cash-in' : '+ cash-out'}</span></td><td>${escapeHtml(m.name)} × ${m.qty}</td><td class="right mono">${money(m.amount)}</td></tr>`).join('')}</tbody></table>`
            : '<div class="muted" style="font-size:12px">No sales have touched this wallet yet.</div>'}
        </div>
      </div>`;
  };

  const rerender = () => {
    const list = state.wallets.slice().sort((a, b) => a.name.localeCompare(b.name));
    $('#wList', el).innerHTML = list.length ? list.map(wCard).join('') : '<div class="empty"><div class="icn">💳</div>No wallets yet — click <b>+ New wallet</b>.</div>';
    // Wire per-wallet actions
    el.querySelectorAll('[data-wid]').forEach(node => {
      const wid = node.dataset.wid;
      const w = state.wallets.find(x => x.id === wid);
      node.querySelector('[data-edit]')?.addEventListener('click', () => openWalletForm(w));
      node.querySelector('[data-del]')?.addEventListener('click', () => deleteWallet(w));
      node.querySelector('[data-topup]')?.addEventListener('click', () => adjustBalance(w, '+', 'Top up'));
      node.querySelector('[data-withdraw]')?.addEventListener('click', () => adjustBalance(w, '-', 'Withdraw'));
      node.querySelector('[data-set]')?.addEventListener('click', () => setBalance(w));
      node.querySelector('[data-quickin]')?.addEventListener('click', () => quickAdd(w, 'cashin'));
      node.querySelector('[data-quickout]')?.addEventListener('click', () => quickAdd(w, 'cashout'));
    });
  };

  const openWalletForm = (existing) => {
    const body = document.createElement('div');
    body.innerHTML = html`
      <div class="grid cols-2">
        <div class="field"><label>Wallet name</label><input name="name" value="${escapeHtml(existing?.name || '')}" placeholder="e.g. GCash"></div>
        <div class="field"><label>Active</label>
          <select name="active"><option value="1" ${existing?.active !== false ? 'selected' : ''}>Yes</option><option value="0" ${existing?.active === false ? 'selected' : ''}>No</option></select>
        </div>
        ${!existing ? `<div class="field" style="grid-column:1/-1"><label>Starting balance</label><input name="balance" type="number" step="0.01" value="0"></div>` : ''}
      </div>`;
    const foot = document.createElement('div');
    foot.innerHTML = '<button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-save>Save</button>';
    const m = openModal({ title: existing ? 'Edit wallet' : 'New wallet', body, footer: foot });
    foot.querySelector('[data-cancel]').addEventListener('click', m.close);
    foot.querySelector('[data-save]').addEventListener('click', async () => {
      const d = readForm(body);
      if (!d.name?.trim()) return toast('Wallet name required', 'bad');
      const rec = existing ? { ...existing } : { id: uid('w_'), createdAt: nowISO(), balance: Number(d.balance) || 0 };
      rec.name = d.name.trim();
      rec.active = d.active === '1';
      await dbPut('wallets', rec);
      const idx = state.wallets.findIndex(w => w.id === rec.id);
      if (idx >= 0) state.wallets[idx] = rec; else state.wallets.push(rec);
      audit(existing ? 'wallet.update' : 'wallet.create', { id: rec.id, name: rec.name });
      m.close(); toast('Saved', 'good'); rerender();
    });
  };

  const deleteWallet = async (w) => {
    const linked = state.products.filter(p => p.walletId === w.id).length;
    const msg = linked
      ? `Delete "${w.name}"? ${linked} product${linked === 1 ? '' : 's'} will be un-linked from this wallet (they won't be deleted).`
      : `Delete "${w.name}"?`;
    if (!(await confirmModal(msg, { danger: true, okText: 'Delete' }))) return;
    for (const p of state.products) if (p.walletId === w.id) { p.walletId = ''; p.walletFlow = ''; await dbPut('products', p); }
    await dbDel('wallets', w.id);
    state.wallets = state.wallets.filter(x => x.id !== w.id);
    audit('wallet.delete', { id: w.id, name: w.name }); toast('Deleted', 'good'); rerender();
  };

  const adjustBalance = (w, sign, title) => {
    const body = document.createElement('div');
    body.innerHTML = html`
      <div class="muted" style="margin-bottom:8px;font-size:12px">Current balance: <b>${money(w.balance || 0)}</b></div>
      <div class="field"><label>Amount</label><input name="amt" type="number" step="0.01" min="0" autofocus></div>
      <div class="field"><label>Note (optional)</label><input name="note" placeholder="e.g. Owner deposit"></div>`;
    const foot = document.createElement('div');
    foot.innerHTML = `<button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>${escapeHtml(title)}</button>`;
    const m = openModal({ title: `${title} — ${w.name}`, body, footer: foot });
    foot.querySelector('[data-cancel]').addEventListener('click', m.close);
    foot.querySelector('[data-ok]').addEventListener('click', async () => {
      const d = readForm(body);
      const amt = Number(d.amt) || 0;
      if (amt <= 0) return toast('Enter a positive amount', 'bad');
      w.balance = (Number(w.balance) || 0) + (sign === '+' ? amt : -amt);
      await dbPut('wallets', w);
      audit('wallet.adjust', { id: w.id, sign, amount: amt, note: d.note || '' });
      m.close(); toast(`${w.name}: ${sign === '+' ? '+' : '−'}${money(amt)} (${money(w.balance)})`, 'good'); rerender();
    });
  };

  const setBalance = (w) => {
    const body = document.createElement('div');
    body.innerHTML = html`
      <div class="muted" style="margin-bottom:8px;font-size:12px">Current: <b>${money(w.balance || 0)}</b>. Use this when reconciling.</div>
      <div class="field"><label>New balance</label><input name="balance" type="number" step="0.01" value="${w.balance || 0}" autofocus></div>`;
    const foot = document.createElement('div');
    foot.innerHTML = '<button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Set balance</button>';
    const m = openModal({ title: 'Set balance — ' + w.name, body, footer: foot });
    foot.querySelector('[data-cancel]').addEventListener('click', m.close);
    foot.querySelector('[data-ok]').addEventListener('click', async () => {
      const nv = Number($('input[name=balance]', body).value);
      if (isNaN(nv)) return toast('Enter a number', 'bad');
      const old = w.balance;
      w.balance = nv;
      await dbPut('wallets', w);
      audit('wallet.setBalance', { id: w.id, from: old, to: nv });
      m.close(); toast(`${w.name} balance set to ${money(nv)}`, 'good'); rerender();
    });
  };

  const quickAdd = (w, flow) => {
    const body = document.createElement('div');
    const isIn = flow === 'cashin';
    body.innerHTML = html`
      <div class="muted" style="margin-bottom:8px;font-size:12px">This will create ${isIn ? 'cash-in' : 'cash-out'} products for <b>${escapeHtml(w.name)}</b>. Existing products with the same name will be skipped.</div>
      <div class="field"><label>Denominations (comma-separated, in ${state.settings.currency})</label>
        <input name="denoms" value="50, 100, 200, 300, 500, 1000, 2000, 5000">
      </div>
      <div class="field"><label>Fee formula</label>
        <select name="feeMode">
          <option value="flat">Flat fee</option>
          <option value="percent">Percentage of amount</option>
          <option value="tier">Tiered (₱5 up to ₱500, ₱10 up to ₱1000, etc.)</option>
        </select>
      </div>
      <div class="field" id="feeValRow"><label>Fee value</label><input name="feeVal" type="number" step="0.01" value="5"></div>
      <div class="field"><label>Category (optional)</label>
        <select name="category"><option value="">—</option>${state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select>
      </div>`;
    const foot = document.createElement('div');
    foot.innerHTML = '<button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Create products</button>';
    const m = openModal({ title: (isIn ? 'Quick-add cash-in — ' : 'Quick-add cash-out — ') + w.name, body, footer: foot });
    foot.querySelector('[data-cancel]').addEventListener('click', m.close);
    foot.querySelector('[data-ok]').addEventListener('click', async () => {
      const d = readForm(body);
      const denoms = String(d.denoms || '').split(',').map(x => Number(String(x).trim())).filter(x => x > 0);
      if (!denoms.length) return toast('Enter at least one denomination', 'bad');
      const feeVal = Number(d.feeVal) || 0;
      const tier = (amt) => amt <= 500 ? 5 : amt <= 1000 ? 10 : amt <= 2000 ? 15 : amt <= 5000 ? 20 : 25;
      let created = 0, skipped = 0;
      for (const amt of denoms) {
        const name = `${w.name} ${isIn ? 'Cash-in' : 'Cash-out'} ${state.settings.currency}${amt}`;
        if (state.products.some(p => p.name.toLowerCase() === name.toLowerCase())) { skipped++; continue; }
        const fee = d.feeMode === 'flat' ? feeVal
          : d.feeMode === 'percent' ? Math.round(amt * feeVal) / 100
          : tier(amt);
        const rec = {
          id: uid('p_'), createdAt: nowISO(),
          name, sku: `${w.name.substring(0,3).toUpperCase()}-${flow.toUpperCase()}-${amt}`.replace(/\s+/g, ''),
          barcode: '', category: d.category || '', supplierId: '',
          price: fee, cost: 0, stock: 999999,
          taxable: false, active: true,
          walletFlow: flow, walletId: w.id, walletAmount: amt
        };
        await dbPut('products', rec);
        state.products.push(rec);
        created++;
      }
      m.close();
      toast(`Created ${created} product${created === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''}`, 'good');
      rerender();
    });
  };

  queueMicrotask(() => {
    $('#wNew', el).addEventListener('click', () => openWalletForm(null));
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

/* Suppliers */
function supplierForm(existing = {}) {
  const body = document.createElement('div');
  body.innerHTML = html`
    <div class="grid cols-2">
      <div class="field"><label>Supplier name</label><input name="name" value="${escapeHtml(existing.name || '')}" /></div>
      <div class="field"><label>Contact person</label><input name="contact" value="${escapeHtml(existing.contact || '')}" /></div>
      <div class="field"><label>Email</label><input name="email" type="email" value="${escapeHtml(existing.email || '')}" /></div>
      <div class="field"><label>Phone</label><input name="phone" value="${escapeHtml(existing.phone || '')}" /></div>
      <div class="field"><label>Payment terms</label><input name="terms" placeholder="e.g. Net 30, COD, Prepaid" value="${escapeHtml(existing.terms || '')}" /></div>
      <div class="field"><label>Tags (comma separated)</label><input name="tags" value="${escapeHtml((existing.tags || []).join(', '))}" /></div>
      <div class="field" style="grid-column:1/-1"><label>Address</label><input name="address" value="${escapeHtml(existing.address || '')}" /></div>
      <div class="field" style="grid-column:1/-1"><label>Notes</label><textarea name="notes" rows="3">${escapeHtml(existing.notes || '')}</textarea></div>
      <div class="field"><label>Active</label>
        <select name="active"><option value="1" ${existing.active !== false ? 'selected' : ''}>Yes</option><option value="0" ${existing.active === false ? 'selected' : ''}>No</option></select>
      </div>
    </div>`;
  return body;
}

route('/suppliers', async () => {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = html`
    <h1>Suppliers</h1><div class="sub">Vendors you buy inventory from — link products to them for sourcing and cost tracking.</div>
    <div class="card">
      <div class="card-h">
        <input id="spFilter" placeholder="Search name, contact or tag…" style="max-width:280px" />
        <div class="spacer"></div>
        <button class="btn primary small" id="spNew">+ New supplier</button>
      </div>
      <div class="card-b" style="overflow:auto;max-height:calc(100vh - 220px)">
        <table class="data">
          <thead><tr><th>Name</th><th>Contact</th><th>Email</th><th>Phone</th><th>Terms</th><th class="right">Products</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;

  const openSupplier = (existing) => {
    const body = supplierForm(existing || {});
    // Show linked products if editing an existing supplier
    if (existing) {
      const linked = state.products.filter(p => p.supplierId === existing.id);
      const box = document.createElement('div');
      box.style.marginTop = '10px';
      box.innerHTML = html`
        <div class="card"><div class="card-h"><h3>Linked products (${linked.length})</h3></div>
          <div class="card-b" style="max-height:220px;overflow:auto">
            ${linked.length ? `<table class="data"><thead><tr><th>Product</th><th>SKU</th><th class="right">Cost</th><th class="right">Stock</th></tr></thead><tbody>${linked.map(p => `<tr><td>${escapeHtml(p.name)}</td><td class="mono">${escapeHtml(p.sku || '')}</td><td class="right mono">${money(p.cost || 0)}</td><td class="right">${p.stock ?? 0}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">No products linked yet. Assign this supplier in Products → Edit.</div>'}
          </div>
        </div>`;
      body.appendChild(box);
    }
    const foot = document.createElement('div');
    foot.innerHTML = '<button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-save>Save</button>';
    const m = openModal({ title: existing ? existing.name : 'New supplier', body, footer: foot, size: 'lg' });
    foot.querySelector('[data-cancel]').addEventListener('click', m.close);
    foot.querySelector('[data-save]').addEventListener('click', async () => {
      const d = readForm(body);
      if (!d.name?.trim()) return toast('Supplier name required', 'bad');
      const rec = existing ? { ...existing } : { id: uid('sp_'), createdAt: nowISO() };
      Object.assign(rec, {
        name: d.name.trim(), contact: d.contact.trim(), email: d.email.trim(),
        phone: d.phone.trim(), terms: d.terms.trim(), address: d.address, notes: d.notes,
        tags: d.tags.split(',').map(s => s.trim()).filter(Boolean),
        active: d.active === '1'
      });
      await dbPut('suppliers', rec);
      const idx = state.suppliers.findIndex(x => x.id === rec.id);
      if (idx >= 0) state.suppliers[idx] = rec; else state.suppliers.push(rec);
      audit(existing ? 'supplier.update' : 'supplier.create', { id: rec.id, name: rec.name });
      m.close(); toast('Saved', 'good'); rerender();
    });
  };

  const rerender = () => {
    const term = ($('#spFilter', el).value || '').trim().toLowerCase();
    let list = state.suppliers.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (term) list = list.filter(s =>
      s.name.toLowerCase().includes(term) ||
      (s.contact || '').toLowerCase().includes(term) ||
      (s.email || '').toLowerCase().includes(term) ||
      (s.tags || []).some(t => t.toLowerCase().includes(term))
    );
    const productCount = (id) => state.products.filter(p => p.supplierId === id).length;
    $('tbody', el).innerHTML = list.map(s => html`
      <tr data-id="${s.id}">
        <td>${escapeHtml(s.name)} ${s.active === false ? '<span class="badge">inactive</span>' : ''}
          ${(s.tags || []).map(t => `<span class="badge">${escapeHtml(t)}</span>`).join(' ')}</td>
        <td>${escapeHtml(s.contact || '')}</td>
        <td>${escapeHtml(s.email || '')}</td>
        <td>${escapeHtml(s.phone || '')}</td>
        <td>${escapeHtml(s.terms || '')}</td>
        <td class="right"><span class="badge">${productCount(s.id)}</span></td>
        <td class="right"><button class="btn small" data-edit>Open</button> <button class="btn small danger" data-del>Delete</button></td>
      </tr>`).join('') || `<tr><td colspan="7"><div class="empty">No suppliers</div></td></tr>`;
    el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
      const id = b.closest('tr').dataset.id;
      openSupplier(state.suppliers.find(x => x.id === id));
    }));
    el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      const id = b.closest('tr').dataset.id;
      const s = state.suppliers.find(x => x.id === id);
      const linked = state.products.filter(p => p.supplierId === id).length;
      const msg = linked
        ? `Delete "${s.name}"? ${linked} product${linked === 1 ? '' : 's'} will be unlinked from this supplier.`
        : `Delete "${s.name}"?`;
      if (!(await confirmModal(msg, { danger: true, okText: 'Delete' }))) return;
      // unlink products
      for (const p of state.products) {
        if (p.supplierId === id) { p.supplierId = ''; await dbPut('products', p); }
      }
      await dbDel('suppliers', id);
      state.suppliers = state.suppliers.filter(x => x.id !== id);
      audit('supplier.delete', { id, name: s.name });
      toast('Deleted', 'good'); rerender();
    }));
  };

  queueMicrotask(() => {
    $('#spFilter', el).addEventListener('input', rerender);
    $('#spNew', el).addEventListener('click', () => openSupplier(null));
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
        if (!(await confirmModal('Refund this sale? Stock will be restored and any wallet movements reversed.', { danger: true, okText: 'Refund' }))) return;
        s.refunded = true; s.refundedAt = nowISO();
        for (const li of s.items) {
          if (li.walletFlow) {
            const w = state.wallets.find(x => x.id === li.walletId);
            if (w) {
              const delta = (Number(li.walletAmount) || 0) * li.qty;
              // Reverse the original direction
              w.balance = (Number(w.balance) || 0) + (li.walletFlow === 'cashout' ? -delta : delta);
              await dbPut('wallets', w);
            }
          } else {
            const p = state.products.find(x => x.id === li.productId);
            if (p) { p.stock = (p.stock || 0) + li.qty; await dbPut('products', p); }
          }
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
      const rows = [['Name', 'SKU', 'Barcode', 'Category', 'Supplier', 'Price', 'Cost', 'Stock', 'Active']];
      for (const p of state.products) rows.push([p.name, p.sku, p.barcode,
        state.categories.find(c => c.id === p.category)?.name || '',
        state.suppliers.find(s => s.id === p.supplierId)?.name || '',
        p.price, p.cost, p.stock, p.active !== false ? 'yes' : 'no']);
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
        <div class="field"><label>AI Assistant access <span class="muted" style="font-weight:400">(managers only)</span></label>
          <select name="aiAccess"><option value="0" ${!existing?.aiAccess ? 'selected' : ''}>No</option><option value="1" ${existing?.aiAccess ? 'selected' : ''}>Yes</option></select>
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
      rec.aiAccess = d.aiAccess === '1';
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
          <button class="btn" id="doEmail">📧 Email backup to Gmail</button>
          <button class="btn" id="doDrive">☁️ Upload to Google Drive</button>
          <button class="btn danger" id="doReset">Reset all data</button>
        </div>
        <div class="muted" style="margin-top:8px">
          <b>Email backup / Google Drive:</b> on mobile (Android/iOS) both buttons open the OS share sheet with the file already attached — pick Gmail or Drive and you're done. On desktop the app downloads the backup and opens Gmail Compose (or drive.google.com) in a new tab; drag the file into the browser tab to attach/upload — browsers don't allow web pages to attach files directly.
          <br>Import auto-detects both LysiPOS backups and Convex-style POS exports. Everything lives in your browser (IndexedDB).
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:14px"><div class="card-h"><h3>AI Assistant</h3><div class="spacer"></div><span class="pill" id="aiStatus">—</span></div>
      <div class="card-b">
        <div class="grid cols-3">
          <div class="field"><label>Enable AI Assistant</label>
            <select name="aiEnabled">
              <option value="0" ${!state.ai?.enabled ? 'selected' : ''}>Off</option>
              <option value="1" ${state.ai?.enabled ? 'selected' : ''}>On</option>
            </select>
          </div>
          <div class="field"><label>Provider</label>
            <select name="aiProvider">
              <option value="anthropic" ${state.ai?.provider === 'anthropic' ? 'selected' : ''}>Anthropic (cloud)</option>
              <option value="ollama" ${state.ai?.provider === 'ollama' ? 'selected' : ''}>Ollama (local)</option>
              <option value="lms" ${state.ai?.provider === 'lms' ? 'selected' : ''}>LM Studio (local)</option>
            </select>
          </div>
          <div class="field"><label>&nbsp;</label>
            <div class="row" style="gap:6px">
              <button class="btn" id="aiTest" type="button">Test connection</button>
              <button class="btn primary" id="aiSaveCfg" type="button">Save AI settings</button>
            </div>
          </div>
        </div>
        <div id="aiProviderCfg"></div>
        <div class="muted" style="font-size:12px;margin-top:6px">
          Access: <b>Admins</b> always have access when enabled. <b>Managers</b> only if their user has the <em>AI access</em> flag (Users → Edit). Cashiers never.
          <br>API keys and local URLs stay in this browser's IndexedDB and are <b>not</b> written into JSON backups.
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:14px"><div class="card-h"><h3>Google integration</h3><div class="spacer"></div><span class="pill" id="gStatus">—</span></div>
      <div class="card-b">
        <div class="grid cols-3">
          <div class="field" style="grid-column:1/-1"><label>OAuth Client ID</label>
            <input name="gClientId" value="${escapeHtml(state.google?.clientId || '')}" placeholder="12345-abc.apps.googleusercontent.com">
          </div>
          <div class="field"><label>Drive folder name</label>
            <input name="gFolderName" value="${escapeHtml(state.google?.folderName || 'LysiPOS Backups')}">
          </div>
          <div class="field" style="grid-column:2/-1"><label>&nbsp;</label>
            <div class="row" style="gap:6px">
              <button class="btn" id="gSave" type="button">Save</button>
              <button class="btn" id="gSignIn" type="button">🔑 Sign in with Google</button>
              <button class="btn ghost" id="gSignOut" type="button">Sign out</button>
            </div>
          </div>
        </div>
        <div class="muted" style="font-size:12px;margin-top:6px">
          When signed in, <b>☁️ Upload to Google Drive</b> above uploads directly to a "<span id="gFolderPreview">${escapeHtml(state.google?.folderName || 'LysiPOS Backups')}</span>" folder in your Drive (no drag-and-drop). Scope: <code>drive.file</code> — the app can only see and manage files it created. Tokens expire in ~1 hour and stay in <code>sessionStorage</code> only (never in a backup).
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:14px"><div class="card-h"><h3>Auto-backup</h3><div class="spacer"></div><span class="pill" id="abLast">${s.lastAutoBackupAt ? 'Last: ' + fmtDate(s.lastAutoBackupAt) : 'Never run'}</span></div>
      <div class="card-b">
        <div class="grid cols-3">
          <div class="field"><label>Frequency</label>
            <select name="autoBackup">
              <option value="off" ${s.autoBackup === 'off' ? 'selected' : ''}>Off</option>
              <option value="daily" ${s.autoBackup === 'daily' || !s.autoBackup ? 'selected' : ''}>Daily</option>
              <option value="weekly" ${s.autoBackup === 'weekly' ? 'selected' : ''}>Weekly</option>
            </select>
          </div>
          <div class="field"><label>Keep last N backups</label><input name="autoBackupKeep" type="number" min="1" max="50" value="${s.autoBackupKeep || 10}"></div>
          <div class="field"><label>Backup folder (Chrome/Edge)</label>
            <button class="btn" id="pickFolder" type="button">📁 Choose folder…</button>
          </div>
        </div>
        <div class="row" style="margin-top:6px">
          <button class="btn" id="runBackupNow">▶ Run backup now</button>
        </div>
        <div class="muted" style="margin-top:6px">Auto-backup runs at most once per interval (checked at app start). Files land in your browser's IndexedDB — and, if you picked a folder, also on disk as <code>lysipos-backup-YYYY-MM-DD.json</code>.</div>
      </div>
    </div>
    <div class="card" style="margin-top:14px"><div class="card-h"><h3>Rolling backups</h3><div class="spacer"></div><span class="pill" id="bkCount">—</span></div>
      <div class="card-b" style="max-height:280px;overflow:auto">
        <table class="data" id="bkTable"><thead><tr><th>When</th><th>Reason</th><th class="right">Size</th><th></th></tr></thead><tbody></tbody></table>
      </div>
    </div>`;

  const refreshBackupsTable = async () => {
    const list = (await dbGetAll('backups')).sort((a, b) => (a.at < b.at ? 1 : -1));
    $('#bkCount', el).textContent = `${list.length} stored`;
    const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';
    $('#bkTable tbody', el).innerHTML = list.map(b => html`
      <tr data-id="${b.id}">
        <td>${fmtDate(b.at)}</td>
        <td><span class="badge ${b.reason === 'auto' ? 'good' : ''}">${escapeHtml(b.reason || 'manual')}</span></td>
        <td class="right mono">${fmtSize(b.size || 0)}</td>
        <td class="right">
          <button class="btn small" data-dl>Download</button>
          <button class="btn small" data-restore>Restore</button>
          <button class="btn small danger" data-del>Delete</button>
        </td>
      </tr>`).join('') || `<tr><td colspan="4"><div class="empty">No backups yet — auto-backup runs when you next open the app, or click "Run backup now".</div></td></tr>`;
    el.querySelectorAll('#bkTable [data-dl]').forEach(b => b.addEventListener('click', async () => {
      const id = b.closest('tr').dataset.id; const rec = await dbGet('backups', id); if (!rec) return;
      const blob = new Blob([JSON.stringify(rec.data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `lysipos-backup-${dayKey(rec.at)}-${rec.id.slice(2, 8)}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }));
    el.querySelectorAll('#bkTable [data-restore]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmModal('Restore this backup? Current data will be REPLACED.', { danger: true, okText: 'Restore' }))) return;
      const id = b.closest('tr').dataset.id; const rec = await dbGet('backups', id); if (!rec) return;
      await applyImport(rec.data); toast('Restored', 'good'); render();
    }));
    el.querySelectorAll('#bkTable [data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmModal('Delete this backup?', { danger: true }))) return;
      const id = b.closest('tr').dataset.id; await dbDel('backups', id); refreshBackupsTable();
    }));
  };

  queueMicrotask(() => {
    $('#saveSettings', el).addEventListener('click', async () => {
      const inputs = el.querySelectorAll('[name]');
      for (const i of inputs) {
        const key = i.name; let v = i.value;
        if (['taxRate', 'loyaltyPerCurrency', 'loyaltyRedeemValue', 'autoBackupKeep'].includes(key)) v = Number(v) || 0;
        if (key === 'taxInclusive') v = v === '1';
        state.settings[key] = v;
      }
      await saveSettings(); toast('Settings saved', 'good');
      render();
    });
    $('#doExport', el).addEventListener('click', async () => {
      const dump = snapshotData();
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `lysipos-backup-${dayKey()}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    // Build a fresh backup File + a human-readable summary for share targets.
    const buildBackupFile = () => {
      const dump = snapshotData();
      const json = JSON.stringify(dump, null, 2);
      const filename = `lysipos-backup-${dayKey()}.json`;
      const file = new File([json], filename, { type: 'application/json' });
      const summary = [
        `Business: ${state.settings.businessName || '—'}`,
        `Products: ${state.products.length}`,
        `Sales: ${state.sales.length}`,
        `Customers: ${state.customers.length}`,
        `Wallets: ${state.wallets.length}`,
        `Snapshot taken: ${new Date().toLocaleString()}`
      ].join('\n');
      return { file, filename, summary };
    };

    $('#doEmail', el).addEventListener('click', async () => {
      const { file, filename, summary } = buildBackupFile();
      const subject = `${state.settings.businessName || 'LysiPOS'} — backup ${dayKey()}`;
      const body = `Attached: ${filename}\n\n${summary}\n\nRestore in the app under Settings → Data → Import backup.`;
      const to = prompt('Send backup to which email?', state.settings.email || 'your.email@gmail.com');
      if (to === null) return;

      // Path 1: Web Share with a file (mobile Gmail / share sheet)
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: subject, text: body });
          toast('Share sheet opened — pick Gmail to send.', 'good');
          return;
        } catch (e) { if (e.name !== 'AbortError') console.warn(e); }
      }

      // Path 2: Download + open Gmail Compose so the user drags the file on
      const url = URL.createObjectURL(file);
      const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      const gmailUrl = 'https://mail.google.com/mail/?view=cm&fs=1'
        + '&to=' + encodeURIComponent(to || '')
        + '&su=' + encodeURIComponent(subject)
        + '&body=' + encodeURIComponent(body);
      window.open(gmailUrl, '_blank', 'noopener');
      toast('Backup downloaded. Gmail Compose opened — drag the file onto the message to attach.', 'good');
    });

    $('#doDrive', el).addEventListener('click', async () => {
      const { file, filename, summary } = buildBackupFile();

      // Path 1 (preferred): real Drive API upload if we have a Client ID
      if (state.google?.clientId) {
        try {
          toast('Opening Google sign-in…');
          const tok = await googleGetToken([DRIVE_SCOPE, USERINFO_SCOPE]);
          // Ensure a folder for tidiness
          let parentId = state.google.folderId;
          try {
            parentId = await ensureFolder(tok.access_token, state.google.folderName || 'LysiPOS Backups');
            state.google.folderId = parentId; await saveGoogle();
          } catch (e) { console.warn('Folder create/lookup failed, uploading to root:', e); parentId = null; }
          const result = await driveUpload(tok.access_token, file, { name: filename, mimeType: 'application/json', parents: parentId ? [parentId] : undefined });
          toast(`Uploaded to Drive: ${result.name}`, 'good');
          if (result.webViewLink) window.open(result.webViewLink, '_blank', 'noopener');
          audit('data.driveUpload', { id: result.id, name: result.name, size: file.size });
          return;
        } catch (e) {
          console.error(e);
          if (!(await confirmModal('Direct Drive upload failed:\n' + e.message + '\n\nFall back to download + open Drive?', { okText: 'Fallback' }))) return;
        }
      }

      // Path 2: Web Share on mobile — user picks Google Drive from the share sheet
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: filename, text: summary });
          toast('Share sheet opened — pick Google Drive to upload.', 'good');
          return;
        } catch (e) { if (e.name !== 'AbortError') console.warn(e); }
      }

      // Path 3: Download the file, then open Drive so the user drops it in
      const url = URL.createObjectURL(file);
      const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      window.open('https://drive.google.com/drive/my-drive', '_blank', 'noopener');
      toast('Backup downloaded. Drive opened — drag the file onto the Drive page to upload.', 'good');
    });
    $('#doImport', el).addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      if (!(await confirmModal('Importing will REPLACE current data. Continue?', { danger: true, okText: 'Import' }))) { e.target.value = ''; return; }
      const text = await file.text(); let data;
      try { data = JSON.parse(text); } catch { return toast('Invalid file', 'bad'); }
      try {
        const norm = await applyImport(data);
        toast(`Imported: ${(norm.products || []).length} products · ${(norm.sales || []).length} sales · ${(norm.categories || []).length} categories · ${(norm.suppliers || []).length} suppliers`, 'good');
        render();
      } catch (err) {
        console.error(err); toast('Import failed: ' + err.message, 'bad');
      }
    });
    $('#doReset', el).addEventListener('click', async () => {
      if (!(await confirmModal('Erase ALL data and reseed? You will be logged out.', { danger: true, okText: 'Erase' }))) return;
      for (const s of STORES) await dbClear(s);
      _db = null; await seedIfEmpty(); await loadAll(); sessionStorage.clear();
      state.user = null; toast('Reset complete', 'good'); render();
    });
    $('#pickFolder', el).addEventListener('click', pickBackupFolder);
    $('#runBackupNow', el).addEventListener('click', async () => {
      const rec = await saveRollingBackup('manual');
      state.settings.lastAutoBackupAt = nowISO(); await saveSettings();
      const handle = await getBackupFolder();
      if (handle) {
        try { const name = await writeBackupToFolder(handle, JSON.stringify(rec.data, null, 2)); toast('Backup saved: ' + name, 'good'); }
        catch (e) { toast('In-app backup saved, folder write failed', 'warn'); }
      } else { toast('Backup saved (in-app)', 'good'); }
      refreshBackupsTable();
    });
    refreshBackupsTable();

    /* ---------- AI section ---------- */
    const renderAIProviderCfg = () => {
      const provider = $('[name=aiProvider]', el).value;
      const cfg = state.ai.configs?.[provider] || aiDefaultConfig(provider);
      const hostHint = {
        anthropic: 'https://api.anthropic.com',
        ollama: 'http://localhost:11434 — enable CORS by setting env <code>OLLAMA_ORIGINS=' + location.origin + '</code> before starting Ollama',
        lms: 'http://localhost:1234/v1 — in LM Studio, enable "Serve on network" and "Enable CORS" in the Developer tab'
      }[provider];
      $('#aiProviderCfg', el).innerHTML = html`
        <div class="grid cols-3" style="margin-top:8px">
          <div class="field"><label>Base URL</label><input name="aiBaseUrl" value="${escapeHtml(cfg.baseUrl || '')}"></div>
          <div class="field"><label>Model</label><input name="aiModel" value="${escapeHtml(cfg.model || '')}"></div>
          <div class="field"><label>${provider === 'anthropic' ? 'API key' : 'API key (optional)'}</label><input name="aiApiKey" type="password" value="${escapeHtml(cfg.apiKey || '')}"></div>
          <div class="field"><label>Max tokens</label><input name="aiMaxTokens" type="number" min="16" max="8192" value="${cfg.maxTokens || 1024}"></div>
          <div class="field"><label>Temperature</label><input name="aiTemperature" type="number" step="0.05" min="0" max="2" value="${cfg.temperature ?? 0.4}"></div>
        </div>
        <div class="muted" style="font-size:11px;margin-top:4px">Hint: ${hostHint}${provider === 'anthropic' ? '. Browser sends <code>anthropic-dangerous-direct-browser-access: true</code>; your API key is stored locally and travels with your browser only.' : ''}</div>
      `;
      $('#aiStatus', el).textContent = state.ai.enabled ? (provider + ' · ' + (cfg.model || '?')) : 'Off';
    };
    const collectProviderCfg = () => {
      const provider = $('[name=aiProvider]', el).value;
      const cfg = {
        baseUrl: $('[name=aiBaseUrl]', el).value.trim() || AI_DEFAULTS[provider].baseUrl,
        model: $('[name=aiModel]', el).value.trim() || AI_DEFAULTS[provider].model,
        apiKey: $('[name=aiApiKey]', el).value,
        maxTokens: Math.max(16, Number($('[name=aiMaxTokens]', el).value) || 1024),
        temperature: Math.max(0, Math.min(2, Number($('[name=aiTemperature]', el).value) || 0.4))
      };
      return { provider, cfg };
    };
    $('[name=aiProvider]', el).addEventListener('change', renderAIProviderCfg);
    renderAIProviderCfg();
    $('#aiSaveCfg', el).addEventListener('click', async () => {
      const { provider, cfg } = collectProviderCfg();
      state.ai.enabled = $('[name=aiEnabled]', el).value === '1';
      state.ai.provider = provider;
      state.ai.configs = state.ai.configs || {};
      state.ai.configs[provider] = cfg;
      await saveAI();
      toast('AI settings saved', 'good');
      render(); // refresh shell so the ✨ Ask AI button appears/disappears
    });
    $('#aiTest', el).addEventListener('click', async () => {
      const { provider, cfg } = collectProviderCfg();
      $('#aiStatus', el).textContent = 'Testing…';
      const r = await aiTest(provider, cfg);
      $('#aiStatus', el).textContent = r.ok ? '● ' + r.info : '✕ ' + r.error;
      toast(r.ok ? r.info : ('Test failed: ' + r.error), r.ok ? 'good' : 'bad');
    });

    /* ---------- Google integration ---------- */
    const refreshGoogleStatus = () => {
      const tok = readGoogleToken();
      const badge = $('#gStatus', el);
      if (!badge) return;
      if (tok?.access_token && tok?.email) badge.textContent = '● Signed in as ' + tok.email;
      else if (tok?.access_token) badge.textContent = '● Signed in';
      else badge.textContent = state.google?.clientId ? 'Not signed in' : 'No Client ID';
    };
    refreshGoogleStatus();
    $('[name=gFolderName]', el)?.addEventListener('input', (e) => {
      const p = $('#gFolderPreview', el); if (p) p.textContent = e.target.value || 'LysiPOS Backups';
    });
    $('#gSave', el)?.addEventListener('click', async () => {
      const newId = $('[name=gClientId]', el).value.trim();
      const newFolder = $('[name=gFolderName]', el).value.trim() || 'LysiPOS Backups';
      const changed = newId !== state.google.clientId || newFolder !== state.google.folderName;
      state.google.clientId = newId;
      if (newFolder !== state.google.folderName) { state.google.folderName = newFolder; state.google.folderId = null; }
      await saveGoogle();
      toast('Google settings saved' + (changed ? ' — sign in again to use the new value.' : ''), 'good');
      refreshGoogleStatus();
    });
    $('#gSignIn', el)?.addEventListener('click', async () => {
      try {
        if (!state.google.clientId) return toast('Paste a Client ID and Save first.', 'bad');
        const tok = await googleGetToken([DRIVE_SCOPE, USERINFO_SCOPE], { forceConsent: true });
        toast('Signed in as ' + (tok.email || 'Google'), 'good');
        refreshGoogleStatus();
      } catch (e) { toast('Sign-in failed: ' + e.message, 'bad'); }
    });
    $('#gSignOut', el)?.addEventListener('click', async () => {
      await googleSignOut();
      toast('Signed out of Google.', 'good');
      refreshGoogleStatus();
    });
  });
  return el;
});

/* -------------------- Dev Console (admin) -------------------- */
route('/dev', async () => {
  if (!requireRole('admin')) return '<div class="page"><h1>Dev Console</h1><div class="muted">Admin only.</div></div>';

  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = html`
    <h1>Dev Console</h1><div class="sub">Diagnostics, user password reset, and data-store maintenance.</div>

    <div class="grid cols-2">
      <div class="card"><div class="card-h"><h3>Session</h3><div class="spacer"></div><span class="pill" id="dcNet"></span></div>
        <div class="card-b" id="dcSession"></div>
      </div>
      <div class="card"><div class="card-h"><h3>Storage</h3><div class="spacer"></div><span class="pill" id="dcQuota"></span></div>
        <div class="card-b">
          <table class="data" id="dcStores"><thead><tr><th>Store</th><th class="right">Rows</th><th class="right">Est. bytes</th><th></th></tr></thead><tbody></tbody></table>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:14px"><div class="card-h"><h3>Users — quick actions</h3><div class="spacer"></div><button class="btn small" id="dcNewAdmin">+ Ensure default admin</button></div>
      <div class="card-b" style="overflow:auto;max-height:320px">
        <table class="data" id="dcUsers"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Has password?</th><th></th></tr></thead><tbody></tbody></table>
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><div class="card-h"><h3>Audit log</h3><div class="spacer"></div>
        <span class="pill" id="dcAuditCount">—</span>
        <button class="btn small" id="dcAuditDl">⤓ CSV</button>
        <button class="btn small danger" id="dcAuditClear">Clear</button>
      </div>
        <div class="card-b" style="max-height:320px;overflow:auto">
          <table class="data" id="dcAudit"><thead><tr><th>When</th><th>By</th><th>Action</th><th>Meta</th></tr></thead><tbody></tbody></table>
        </div>
      </div>
      <div class="card"><div class="card-h"><h3>Console output</h3><div class="spacer"></div>
        <select id="dcLogFilter" style="max-width:140px"><option value="">All levels</option><option value="warn">warn+</option><option value="error">error only</option></select>
        <button class="btn small" id="dcLogRefresh">↻</button>
        <button class="btn small danger" id="dcLogClear">Clear</button>
      </div>
        <div class="card-b" style="max-height:320px;overflow:auto;padding:0">
          <pre id="dcLog" style="margin:0;padding:12px;font-family:ui-monospace,Menlo,monospace;font-size:11px;white-space:pre-wrap;word-break:break-word"></pre>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:14px"><div class="card-h"><h3>Danger zone</h3></div>
      <div class="card-b">
        <div class="row">
          <button class="btn" id="dcUnregSw">↺ Unregister service worker</button>
          <button class="btn danger" id="dcDropDb">⚠ Delete IndexedDB &amp; reload</button>
          <button class="btn danger" id="dcResetAll">⚠ Reset all data &amp; reseed</button>
        </div>
        <div class="muted" style="margin-top:8px;font-size:12px">Unregistering the service worker forces the next page load to pick up new app code. Deleting the DB wipes every store (settings, products, sales, users…). Reset re-seeds the demo store.</div>
      </div>
    </div>
  `;

  /* ---------- helpers ---------- */
  const renderSession = async () => {
    const box = $('#dcSession', el);
    let quota = null;
    try { if (navigator.storage?.estimate) quota = await navigator.storage.estimate(); } catch {}
    const swRegs = await (navigator.serviceWorker?.getRegistrations?.().catch(() => [])) || [];
    const rows = [
      ['Current user', `${state.user?.name || '—'} (${state.user?.role || '—'})`],
      ['User email', state.user?.email || '—'],
      ['Business', state.settings?.businessName || '—'],
      ['App version', 'lysipos-v3'],
      ['DB name / version', `${DB_NAME} / ${DB_VER}`],
      ['User agent', navigator.userAgent],
      ['Language', navigator.language],
      ['Online', String(navigator.onLine)],
      ['Display mode', window.matchMedia('(display-mode: standalone)').matches ? 'standalone (PWA installed)' : 'browser tab'],
      ['Camera scanner supported', String(isScannerSupported())],
      ['File System Access API', String('showDirectoryPicker' in window)],
      ['Service workers active', String(swRegs.length)],
      ['Storage estimate', quota ? `${(quota.usage / 1048576).toFixed(2)} MB used / ${(quota.quota / 1048576).toFixed(0)} MB quota` : 'n/a']
    ];
    box.innerHTML = rows.map(([k, v]) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px dashed var(--border)"><div class="muted" style="min-width:200px">${escapeHtml(k)}</div><div class="mono" style="text-align:right;word-break:break-all">${escapeHtml(v)}</div></div>`).join('');
    $('#dcNet', el).textContent = navigator.onLine ? '● Online' : '● Offline';
    $('#dcQuota', el).textContent = quota ? `${(quota.usage / 1048576).toFixed(1)} MB` : '—';
  };

  const renderStores = async () => {
    const rows = [];
    for (const s of STORES) {
      const all = await dbGetAll(s);
      const bytes = new Blob([JSON.stringify(all)]).size;
      rows.push([s, all.length, bytes]);
    }
    $('#dcStores tbody', el).innerHTML = rows.map(([s, n, b]) => html`
      <tr>
        <td class="mono">${s}</td>
        <td class="right mono">${n}</td>
        <td class="right mono">${b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(2) + ' MB'}</td>
        <td class="right"><button class="btn small danger" data-clear="${s}" ${s === 'settings' ? 'disabled title="Never clear settings"' : ''}>Clear</button></td>
      </tr>`).join('');
    el.querySelectorAll('[data-clear]').forEach(btn => btn.addEventListener('click', async () => {
      const s = btn.dataset.clear;
      if (!(await confirmModal(`Clear the "${s}" store? This cannot be undone.`, { danger: true, okText: 'Clear' }))) return;
      await dbClear(s);
      if (s === 'users') await ensureAdmin();
      await loadAll(); audit('dev.clearStore', { store: s });
      toast(`Cleared ${s}`, 'good');
      renderStores(); renderUsers();
    }));
  };

  const renderUsers = async () => {
    const users = await dbGetAll('users');
    $('#dcUsers tbody', el).innerHTML = users.map(u => html`
      <tr data-id="${u.id}">
        <td>${escapeHtml(u.name || '')}</td>
        <td class="mono">${escapeHtml(u.email || '')}</td>
        <td><span class="badge">${escapeHtml(u.role || '')}</span></td>
        <td>${u.active !== false ? '<span class="badge good">active</span>' : '<span class="badge bad">disabled</span>'}</td>
        <td>${u.passHash ? '<span class="badge good">yes</span>' : '<span class="badge bad">no</span>'}</td>
        <td class="right">
          <button class="btn small" data-pw>Change password</button>
          <button class="btn small" data-toggle>${u.active !== false ? 'Disable' : 'Enable'}</button>
          <button class="btn small" data-role>Change role</button>
          ${u.id === state.user.id ? '' : '<button class="btn small danger" data-del>Delete</button>'}
        </td>
      </tr>`).join('');
    el.querySelectorAll('#dcUsers [data-pw]').forEach(b => b.addEventListener('click', () => openPwChange(b.closest('tr').dataset.id)));
    el.querySelectorAll('#dcUsers [data-toggle]').forEach(b => b.addEventListener('click', async () => {
      const u = users.find(x => x.id === b.closest('tr').dataset.id); if (!u) return;
      u.active = u.active === false;
      await dbPut('users', u); audit('dev.userToggle', { id: u.id, active: u.active });
      toast(u.active ? 'Enabled' : 'Disabled', 'good'); renderUsers();
    }));
    el.querySelectorAll('#dcUsers [data-role]').forEach(b => b.addEventListener('click', () => openRoleChange(b.closest('tr').dataset.id)));
    el.querySelectorAll('#dcUsers [data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmModal('Delete this user?', { danger: true }))) return;
      const id = b.closest('tr').dataset.id;
      await dbDel('users', id); await ensureAdmin(); await loadAll();
      audit('dev.userDelete', { id }); toast('Deleted', 'good'); renderUsers();
    }));
  };

  const openPwChange = (uid_) => {
    const u = state.users.find(x => x.id === uid_); if (!u) return;
    const body = document.createElement('div');
    body.innerHTML = html`
      <div class="field"><label>User</label><input value="${escapeHtml(u.name)} · ${escapeHtml(u.email)}" disabled></div>
      <div class="field"><label>New password</label><input id="pw1" type="password" autofocus></div>
      <div class="field"><label>Confirm password</label><input id="pw2" type="password"></div>
      <div class="muted" style="font-size:12px">Password is hashed with SHA-256 before storage. No plaintext is kept.</div>`;
    const foot = document.createElement('div');
    foot.innerHTML = '<button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Set password</button>';
    const m = openModal({ title: 'Change password', body, footer: foot });
    foot.querySelector('[data-cancel]').addEventListener('click', m.close);
    foot.querySelector('[data-ok]').addEventListener('click', async () => {
      const p1 = $('#pw1', body).value, p2 = $('#pw2', body).value;
      if (!p1 || p1.length < 4) return toast('Password must be at least 4 characters', 'bad');
      if (p1 !== p2) return toast('Passwords do not match', 'bad');
      u.passHash = await sha256(p1);
      await dbPut('users', u); audit('dev.passwordChange', { id: u.id });
      m.close(); toast('Password updated for ' + u.name, 'good'); renderUsers();
    });
  };

  const openRoleChange = (uid_) => {
    const u = state.users.find(x => x.id === uid_); if (!u) return;
    const body = document.createElement('div');
    body.innerHTML = html`
      <div class="field"><label>User</label><input value="${escapeHtml(u.name)} · ${escapeHtml(u.email)}" disabled></div>
      <div class="field"><label>Role</label>
        <select id="rl">
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
          <option value="manager" ${u.role === 'manager' ? 'selected' : ''}>manager</option>
          <option value="cashier" ${u.role === 'cashier' ? 'selected' : ''}>cashier</option>
        </select>
      </div>`;
    const foot = document.createElement('div');
    foot.innerHTML = '<button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Save</button>';
    const m = openModal({ title: 'Change role', body, footer: foot });
    foot.querySelector('[data-cancel]').addEventListener('click', m.close);
    foot.querySelector('[data-ok]').addEventListener('click', async () => {
      u.role = $('#rl', body).value;
      await dbPut('users', u); await ensureAdmin();
      audit('dev.roleChange', { id: u.id, role: u.role });
      m.close(); toast('Role updated', 'good'); renderUsers();
    });
  };

  const renderAudit = async () => {
    const all = (await dbGetAll('audit')).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 100);
    $('#dcAuditCount', el).textContent = `${all.length} shown`;
    $('#dcAudit tbody', el).innerHTML = all.map(a => html`
      <tr>
        <td class="mono" style="white-space:nowrap">${fmtDate(a.at)}</td>
        <td>${escapeHtml(a.byName || '')}</td>
        <td class="mono">${escapeHtml(a.action)}</td>
        <td class="mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(JSON.stringify(a.meta || {}))}">${escapeHtml(JSON.stringify(a.meta || {}))}</td>
      </tr>`).join('') || `<tr><td colspan="4"><div class="empty">No audit entries</div></td></tr>`;
  };

  const renderLogs = () => {
    const filter = $('#dcLogFilter', el).value;
    const rank = { log: 0, info: 0, warn: 1, error: 2 };
    const min = filter === 'error' ? 2 : filter === 'warn' ? 1 : 0;
    const list = LOG_RING.filter(l => (rank[l.level] ?? 0) >= min);
    const color = (lv) => lv === 'error' ? 'var(--bad)' : lv === 'warn' ? 'var(--warn)' : 'var(--muted)';
    $('#dcLog', el).innerHTML = list.map(l => `<div><span style="color:${color(l.level)}">[${l.level}]</span> <span class="muted">${escapeHtml(l.at.slice(11, 19))}</span> ${escapeHtml(l.msg)}</div>`).join('') || '<div class="muted">No log entries yet.</div>';
  };

  queueMicrotask(async () => {
    await renderSession();
    await renderStores();
    await renderUsers();
    await renderAudit();
    renderLogs();

    $('#dcNewAdmin', el).addEventListener('click', async () => {
      const added = await ensureAdmin();
      toast(added ? 'Default admin created' : 'An admin already exists', added ? 'good' : 'warn');
      renderUsers();
    });
    $('#dcLogRefresh', el).addEventListener('click', renderLogs);
    $('#dcLogFilter', el).addEventListener('change', renderLogs);
    $('#dcLogClear', el).addEventListener('click', () => { LOG_RING.length = 0; renderLogs(); });
    $('#dcAuditDl', el).addEventListener('click', async () => {
      const all = (await dbGetAll('audit')).sort((a, b) => (a.at < b.at ? 1 : -1));
      const rows = [['At', 'By', 'Action', 'Meta']];
      for (const a of all) rows.push([a.at, a.byName || '', a.action, JSON.stringify(a.meta || {})]);
      const csv = rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `audit-${dayKey()}.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('#dcAuditClear', el).addEventListener('click', async () => {
      if (!(await confirmModal('Clear all audit entries? This cannot be undone.', { danger: true, okText: 'Clear' }))) return;
      await dbClear('audit'); toast('Audit log cleared', 'good'); renderAudit();
    });
    $('#dcUnregSw', el).addEventListener('click', async () => {
      if (!navigator.serviceWorker) return toast('No service worker available', 'warn');
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
      toast(`Unregistered ${regs.length} service worker(s). Reload to pick up new code.`, 'good');
    });
    $('#dcDropDb', el).addEventListener('click', async () => {
      if (!(await confirmModal('This will delete ALL LysiPOS data (products, sales, users, settings). The page will reload. Continue?', { danger: true, okText: 'Delete everything' }))) return;
      try { if (_db) { _db.close(); _db = null; } } catch {}
      indexedDB.deleteDatabase(DB_NAME);
      sessionStorage.clear();
      setTimeout(() => location.reload(), 600);
    });
    $('#dcResetAll', el).addEventListener('click', async () => {
      if (!(await confirmModal('Erase ALL data and reseed the demo store? You will be logged out.', { danger: true, okText: 'Erase' }))) return;
      for (const s of STORES) await dbClear(s);
      _db = null; await seedIfEmpty(); await loadAll(); sessionStorage.clear();
      state.user = null; toast('Reset complete', 'good'); render();
    });

    // Keep the online pill live while the page is open
    const onNet = () => { $('#dcNet', el) && ($('#dcNet', el).textContent = navigator.onLine ? '● Online' : '● Offline'); };
    window.addEventListener('online', onNet); window.addEventListener('offline', onNet);
  });

  return el;
});

/* -------------------- AI Assistant -------------------- */

// Build a compact JSON-ish context for the model. Kept small so it fits in
// modest local models too (bounded lists).
function buildAIContext(depth = 'summary') {
  const s = state.settings;
  const now = new Date();
  const cutoff = new Date(now.getTime() - 30 * 864e5);
  const salesRecent = state.sales.filter(x => new Date(x.createdAt) >= cutoff);

  const byDay = {};
  for (const sl of salesRecent) {
    const k = dayKey(sl.createdAt);
    byDay[k] = (byDay[k] || 0) + sl.total;
  }
  const byCat = {}, byCashier = {}, prodQty = {};
  for (const sl of salesRecent) {
    byCashier[sl.cashier?.name || '—'] = (byCashier[sl.cashier?.name || '—'] || 0) + sl.total;
    for (const li of sl.items) {
      const p = state.products.find(x => x.id === li.productId);
      const cat = state.categories.find(c => c.id === p?.category)?.name || 'Uncategorized';
      byCat[cat] = (byCat[cat] || 0) + li.price * li.qty;
      prodQty[li.productId] = (prodQty[li.productId] || 0) + li.qty;
    }
  }
  const top = Object.entries(prodQty).sort((a,b) => b[1]-a[1]).slice(0, 15)
    .map(([pid, q]) => ({ product: state.products.find(p => p.id === pid)?.name || pid, qty: q }));

  const cap = depth === 'full' ? 300 : 120;
  const products = state.products
    .filter(p => p.active !== false)
    .slice(0, cap)
    .map(p => ({
      name: p.name, sku: p.sku, stock: p.stock ?? 0, price: p.price, cost: p.cost,
      category: state.categories.find(c => c.id === p.category)?.name || '',
      supplier: state.suppliers.find(x => x.id === p.supplierId)?.name || ''
    }));
  const lowStock = state.products
    .filter(p => p.active !== false && (p.stock ?? 0) <= (p.lowStockThreshold ?? 5))
    .slice(0, 40)
    .map(p => ({ name: p.name, sku: p.sku, stock: p.stock ?? 0 }));

  const expensesRecent = state.expenses
    .filter(e => new Date(e.date || e.createdAt || 0) >= cutoff);
  const expTotal = expensesRecent.reduce((n, e) => n + Number(e.amount || 0), 0);
  const expByCat = {};
  for (const e of expensesRecent) expByCat[e.category || 'General'] = (expByCat[e.category || 'General'] || 0) + Number(e.amount || 0);

  return {
    business: { name: s.businessName, currency: s.currency, taxRate: s.taxRate, taxInclusive: !!s.taxInclusive },
    today: dayKey(now),
    counts: {
      products: state.products.length,
      customers: state.customers.length,
      suppliers: state.suppliers.length,
      sales_30d: salesRecent.length,
      expenses_30d: expensesRecent.length
    },
    revenue_30d: { total: Object.values(byDay).reduce((a,b) => a+b, 0), by_day: byDay },
    top_products_30d: top,
    revenue_by_category_30d: byCat,
    revenue_by_cashier_30d: byCashier,
    expenses_30d: { total: expTotal, by_category: expByCat },
    low_stock: lowStock,
    products
  };
}

// Fetch and compress the user manual into a plaintext outline + first paragraphs.
let _manualCache = null;
async function loadManualDigest() {
  if (_manualCache) return _manualCache;
  try {
    const r = await fetch('manual.html');
    const html = await r.text();
    // Strip tags but keep some structure
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const parts = [];
    doc.querySelectorAll('h2, h3').forEach(h => parts.push('\n## ' + h.textContent.trim()));
    // Include the first paragraph of each H2 section
    doc.querySelectorAll('h2').forEach(h => {
      let n = h.nextElementSibling;
      let count = 0;
      while (n && n.tagName !== 'H2' && count < 3) {
        if (n.tagName === 'P' || n.tagName === 'UL' || n.tagName === 'OL') {
          parts.push(n.textContent.trim().replace(/\s+/g, ' '));
          count++;
        }
        n = n.nextElementSibling;
      }
    });
    _manualCache = parts.join('\n').slice(0, 6000); // cap at ~6KB
  } catch { _manualCache = '(manual unavailable)'; }
  return _manualCache;
}

async function buildAISystemPrompt() {
  const ctx = buildAIContext();
  const manual = await loadManualDigest();
  return [
    `You are LysiPOS Assistant, embedded in a Point-of-Sale + CRM + SaaS app used by a small business.`,
    `You help the operator understand their store, spot problems, and use the app.`,
    ``,
    `Rules:`,
    `- Ground every answer in the JSON context and manual excerpts below. Do not invent products, customers, sales, or app features.`,
    `- Prefer short, structured answers (bullets, tables) over prose.`,
    `- All amounts are in ${ctx.business.currency}. Today's date is ${ctx.today}.`,
    `- When suggesting actions ("restock these", "raise price on X"), reference the specific product name and current numbers.`,
    `- If a question requires data not in the context, say so and suggest which page in the app has it.`,
    `- Never ask the user for their password or API keys.`,
    ``,
    `=== STORE DATA (last 30 days unless noted) ===`,
    JSON.stringify(ctx),
    ``,
    `=== USER MANUAL OUTLINE ===`,
    manual
  ].join('\n');
}

// Minimal, safe markdown → HTML for chat bubbles.
// Escapes first (so no injection), then applies inline formatting.
function renderChatMd(text) {
  let s = escapeHtml(text);
  // Fenced code blocks ```lang\n...\n```
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) =>
    `<pre style="background:var(--panel-3);padding:8px 10px;border-radius:8px;overflow-x:auto;margin:6px 0;font-family:ui-monospace,Menlo,monospace;font-size:12px">${code.replace(/\n$/, '')}</pre>`);
  // Inline code
  s = s.replace(/`([^`\n]+)`/g, '<code style="background:var(--panel-3);padding:1px 5px;border-radius:5px;font-family:ui-monospace,Menlo,monospace;font-size:.92em">$1</code>');
  // Headings: ###, ##, #
  s = s.replace(/^###\s+(.+)$/gm, '<div style="font-weight:600;margin-top:6px">$1</div>');
  s = s.replace(/^##\s+(.+)$/gm, '<div style="font-weight:700;font-size:14px;margin-top:8px">$1</div>');
  s = s.replace(/^#\s+(.+)$/gm, '<div style="font-weight:700;font-size:15px;margin-top:8px">$1</div>');
  // Bold **text**  (non-greedy, no newline)
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  // Italic *text* — require non-* boundaries so it does not eat leftover **
  s = s.replace(/(^|[^*_])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>');
  // Bullet lines "- " or "* "
  s = s.replace(/^[-*]\s+(.+)$/gm, '• $1');
  // Numbered lists "1. " — leave the digit, just tidy spacing
  s = s.replace(/^(\d+)\.\s+/gm, '$1. ');
  // Strip any stray asterisks the model emitted asymmetrically
  s = s.replace(/\*\*/g, '');
  return s;
}

function openAIChat() {
  if (!canUseAI()) { toast('AI Assistant is not enabled for your account.', 'warn'); return; }
  const provider = state.ai.provider;
  const cfg = state.ai.configs?.[provider] || aiDefaultConfig(provider);
  const providerName = { anthropic: 'Anthropic', ollama: 'Ollama', lms: 'LM Studio' }[provider];

  const body = document.createElement('div');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '10px';
  body.style.minHeight = '360px';
  body.innerHTML = html`
    <div id="aiChat" style="flex:1;min-height:280px;max-height:52vh;overflow:auto;padding:6px 2px;display:flex;flex-direction:column;gap:10px"></div>
    <div id="aiChips" style="display:flex;flex-wrap:wrap;gap:6px"></div>
    <div style="display:flex;gap:6px">
      <textarea id="aiInput" rows="2" placeholder="Ask about products, sales, expenses, or how to use the app…" style="flex:1;resize:vertical"></textarea>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="btn primary" id="aiSend">Send</button>
        <button class="btn ghost" id="aiStop" disabled>Stop</button>
      </div>
    </div>
    <div class="muted" style="font-size:11px">Model: <b>${escapeHtml(cfg.model || '?')}</b> · Provider: ${escapeHtml(providerName)} — answers depend on the connected model.</div>
  `;

  const m = openModal({
    title: '✨ AI Assistant',
    body,
    footer: '<button class="btn ghost" data-close2>Close</button><button class="btn small" data-clearchat>Clear chat</button>',
    size: 'lg'
  });
  m.footEl.querySelector('[data-close2]').addEventListener('click', m.close);
  m.footEl.querySelector('[data-clearchat]').addEventListener('click', () => { messages = []; render(); });

  let messages = [];
  let abortCtl = null;

  const render = () => {
    const box = $('#aiChat', body);
    box.innerHTML = messages.map(msg => {
      const isUser = msg.role === 'user';
      const content = isUser ? escapeHtml(msg.content) : renderChatMd(msg.content);
      return `
      <div style="display:flex;gap:8px;${isUser ? 'justify-content:flex-end' : ''}">
        <div style="max-width:85%;padding:8px 12px;border-radius:12px;background:${isUser ? 'var(--panel-3)' : 'var(--panel-2)'};border:1px solid var(--border);white-space:pre-wrap;word-break:break-word">${content}${msg.streaming ? '<span class="muted"> ▍</span>' : ''}</div>
      </div>`;
    }).join('') || '<div class="empty" style="padding:20px"><div class="icn">✨</div>Ask about your store, sales, expenses, or how to use LysiPOS.</div>';
    box.scrollTop = box.scrollHeight;
  };

  const suggestions = [
    'Which products should I restock this week?',
    'How did sales go in the last 7 days? Any trends?',
    'What are my top 5 products by revenue?',
    'Where is my money going — summarize my expenses.',
    'Which cashier had the best week?',
    'Explain how tax-inclusive pricing works in the settings.'
  ];
  const renderChips = () => {
    $('#aiChips', body).innerHTML = suggestions.map(s => `<button class="btn small ghost" data-sug="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('');
    body.querySelectorAll('[data-sug]').forEach(b => b.addEventListener('click', () => { $('#aiInput', body).value = b.dataset.sug; send(); }));
  };
  renderChips();
  render();

  const send = async () => {
    const text = $('#aiInput', body).value.trim();
    if (!text) return;
    $('#aiInput', body).value = '';
    messages.push({ role: 'user', content: text });
    const assistant = { role: 'assistant', content: '', streaming: true };
    messages.push(assistant);
    render();
    $('#aiSend', body).disabled = true;
    $('#aiStop', body).disabled = false;
    abortCtl = new AbortController();
    try {
      const sys = await buildAISystemPrompt();
      const sendable = messages.filter(m => !m.streaming).map(m => ({ role: m.role, content: m.content }));
      for await (const chunk of chatStream(provider, cfg, sys, sendable, abortCtl.signal)) {
        assistant.content += chunk;
        render();
      }
    } catch (e) {
      if (e.message !== 'aborted') assistant.content += `\n\n[error] ${e.message}\n\n(Common causes: CORS not allowed on the local server, invalid API key, or model not loaded. Check Settings → AI Assistant → Test.)`;
    } finally {
      assistant.streaming = false;
      $('#aiSend', body).disabled = false;
      $('#aiStop', body).disabled = true;
      abortCtl = null;
      render();
    }
  };

  $('#aiSend', body).addEventListener('click', send);
  $('#aiStop', body).addEventListener('click', () => { abortCtl?.abort(); });
  $('#aiInput', body).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  setTimeout(() => $('#aiInput', body)?.focus(), 50);
}

/* -------------------- PWA install prompt -------------------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e;
  const b = $('#installBtn'); if (b) b.style.display = '';
});

/* -------------------- bootstrap -------------------- */
async function runMigrations() {
  // Pre-wallet-feature safety backup: taken once on first boot with the new schema
  // and only if there's existing data worth backing up. Stored as a rolling backup
  // so the user can restore via Settings → Rolling backups if anything goes sideways.
  if (!state.settings.walletMigrationDone) {
    const hasData = state.products.length > 0 || state.sales.length > 0 || state.customers.length > 0;
    if (hasData) {
      try {
        const rec = await saveRollingBackup('pre-wallet-feature');
        console.log('Pre-wallet-feature backup saved:', rec.id);
      } catch (e) { console.error('Pre-migration backup failed:', e); }
    }
    state.settings.walletMigrationDone = true;
    await saveSettings();
  }
}

(async function boot() {
  await seedIfEmpty();
  await ensureAdmin(); // safety net for imported DBs that lost the admin
  await loadAll();
  await runMigrations();
  await restoreSession();
  render();
  // Fire auto-backup after the UI is up
  setTimeout(() => { maybeAutoBackup().catch(console.error); }, 1500);
  // And every 6 hours in case the app stays open
  setInterval(() => { maybeAutoBackup().catch(console.error); }, 6 * 3600 * 1000);
})();
