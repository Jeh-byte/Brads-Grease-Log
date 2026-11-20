// Brad's Grease Log: tick machines off as they're greased, log fuel and oil like the paper sheet.
// Records live in localStorage; problem photos live in IndexedDB (too big for localStorage).
'use strict';
const APP_VERSION = '1.1';
const STORE_KEY = 'greaselog.v1';
const OILS = ['10W', '15W40', '30W', '50W', '85/140', '60W'];
const BACKUP_DAYS = 14;
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const CapApp = NATIVE ? window.Capacitor.registerPlugin('App') : null;
const Files = NATIVE ? window.Capacitor.registerPlugin('Filesystem') : null;
const Sharer = NATIVE ? window.Capacitor.registerPlugin('Share') : null;

// Colour stripe per unit type, close to the colours on the paper sheet.
const TYPE_COLOURS = {
  EX: '#6d8fd1', DZ: '#8fb6dc', WG: '#ee9a6c', WL: '#8fc39a', TK: '#e58aa8', DT: '#e58aa8',
  ST: '#9fcbe0', WT: '#5f7cc4', APS: '#b8b8b8', WC: '#ee9a6c', DR: '#8f9fc9', WS: '#6f86b4', CCM: '#ee9a6c'
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const prefix = (code) => ((String(code).match(/^[A-Za-z]+/) || ['?'])[0]).toUpperCase();
const colour = (code) => TYPE_COLOURS[prefix(code)] || '#b8b8b8';
const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
const round1 = (n) => Math.round(n * 10) / 10;

// ---------- data ----------
function defaults() {
  return {
    units: window.SEED_UNITS.slice(),
    entries: [], // {id, code, at (ISO), greased, smu, diesel, coolant, oils:{grade:L}, fob, notes}
    issues: [],  // {id, code, at, text, photo (bool), doneAt}
    shifts: {},  // workDay -> {shift, name, truck, tanks:[{loc,pump,litres}], meterStart, meterFinish, supervisor, message, comments}
    run: [],     // unit codes on "My run"
    deleted: [], // ids of deleted entries/issues, so a crew handover doesn't bring them back
    settings: { dueDays: 7, dayStart: 6, sort: 'sheet', filter: 'all', rules: {} },
    lastBackup: null,
    lastHandover: null
  };
}
function load() {
  const d = defaults();
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.units) && Array.isArray(s.entries)) {
      const out = Object.assign(d, s);
      out.settings = Object.assign(defaults().settings, s.settings || {});
      out.settings.rules = out.settings.rules || {};
      return out;
    }
  } catch { /* fall through to a fresh start */ }
  return d;
}
const state = load();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Couldn’t save on this phone: ' + (e.message || e)); }
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
function forget(id) { state.deleted.push(id); if (state.deleted.length > 5000) state.deleted.splice(0, state.deleted.length - 5000); }

// Photos (data URLs) in IndexedDB, keyed by issue id.
const Photos = (() => {
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('greaselog-photos', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('photos');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => {
    const t = d.transaction('photos', mode); const req = fn(t.objectStore('photos'));
    t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
  }); };
  return {
    put: (id, url) => tx('readwrite', (s) => s.put(url, id)),
    get: (id) => tx('readonly', (s) => s.get(id)),
    del: (id) => tx('readwrite', (s) => s.delete(id)),
    async all() { const d = await db(); return new Promise((res, rej) => {
      const out = {}; const t = d.transaction('photos'); const c = t.objectStore('photos').openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error);
    }); }
  };
})();

// ---------- dates ----------
const pad = (n) => String(n).padStart(2, '0');
const localKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// A work day runs from dayStart (e.g. 6am) to dayStart the next morning, so night shift stays together.
const workDay = (at) => localKey(new Date(new Date(at).getTime() - state.settings.dayStart * 3600e3));
const keyToDate = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const dayDiff = (a, b) => Math.round((keyToDate(a) - keyToDate(b)) / 864e5);
const fmtTime = (at) => new Date(at).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
const fmtDay = (k) => keyToDate(k).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDate = (k) => keyToDate(k).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtWhen = (at) => `${new Date(at).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })} ${fmtTime(at)}`;
const toLocalInput = (d) => `${localKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const todayKey = () => workDay(new Date());

// ---------- grease rules and status ----------
function ruleFor(code) {
  const r = state.settings.rules[prefix(code)];
  return r && r.every > 0 ? r : { mode: 'days', every: state.settings.dueDays };
}
function summaries() {
  const m = {};
  const sorted = state.entries.slice().sort((a, b) => a.at.localeCompare(b.at));
  for (const e of sorted) {
    const s = m[e.code] || (m[e.code] = {});
    if (e.smu != null) s.smu = e;
    if (e.greased) { s.grease = e; s.smuAtGrease = s.smu ? s.smu.smu : null; }
    if (e.diesel != null) s.fuel = e;
  }
  for (const i of state.issues) if (!i.doneAt) { const s = m[i.code] || (m[i.code] = {}); s.issues = (s.issues || 0) + 1; }
  return m;
}
// urgency: 0 = just greased, 1 = due now, Infinity = never greased
function status(code, sum) {
  const rule = ruleFor(code);
  if (!sum || !sum.grease) return { cls: 'never', urgency: Infinity, label: 'Not greased yet' };
  const d = dayDiff(todayKey(), workDay(sum.grease.at));
  const ago = d <= 0 ? `today ${fmtTime(sum.grease.at)}` : d === 1 ? 'yesterday' : `${d} days ago`;
  let urgency, label;
  if (rule.mode === 'hours') {
    if (sum.smuAtGrease == null || !sum.smu) {
      urgency = d / state.settings.dueDays;
      label = `Greased ${ago} · no SMU`;
    } else {
      const h = round1(sum.smu.smu - sum.smuAtGrease);
      urgency = h / rule.every;
      label = `Greased ${ago} · ${h} of ${rule.every} h`;
    }
  } else {
    urgency = d / rule.every;
    label = `Greased ${ago}`;
  }
  const cls = d <= 0 && urgency < 1 ? 'today' : urgency >= 1 ? 'over' : urgency >= (rule.mode === 'hours' ? 0.85 : (rule.every - 1) / rule.every) && rule.every > 1 ? 'soon' : 'ok';
  return { cls, urgency, label: cls === 'over' ? `${label} · due` : label };
}
const isDue = (st) => st.cls === 'over' || st.cls === 'soon' || st.cls === 'never';

function entryText(e) {
  const bits = [];
  if (e.greased) bits.push('<span class="g">Greased</span>');
  if (e.diesel != null) bits.push(`Diesel ${e.diesel} L`);
  if (e.smu != null) bits.push(`SMU ${e.smu}`);
  if (e.coolant != null) bits.push(`Coolant ${e.coolant} L`);
  for (const o of OILS) if (e.oils && e.oils[o] != null) bits.push(`${o} ${e.oils[o]} L`);
  if (e.fob) bits.push('New fob needed');
  if (e.notes) bits.push(`“${esc(e.notes)}”`);
  return bits.join(' · ') || 'Entry';
}

// SMU sanity check: lower than an earlier reading, higher than a later one, or more hours than have passed.
function smuWarning(code, smu, atIso, excludeId) {
  if (smu == null) return null;
  const at = new Date(atIso).getTime();
  const list = state.entries.filter((e) => e.code === code && e.smu != null && e.id !== excludeId);
  let prev = null, next = null;
  for (const e of list) {
    const t = new Date(e.at).getTime();
    if (t <= at && (!prev || t > new Date(prev.at).getTime())) prev = e;
    if (t > at && (!next || t < new Date(next.at).getTime())) next = e;
  }
  if (prev && smu < prev.smu) return `${smu} is lower than the last SMU for ${code} (${prev.smu} on ${fmtWhen(prev.at)}).`;
  if (prev) {
    const passed = (at - new Date(prev.at).getTime()) / 3600e3;
    if (smu - prev.smu > passed + 1) return `${smu} is ${round1(smu - prev.smu)} h more than the last SMU (${prev.smu} on ${fmtWhen(prev.at)}), but only ${Math.max(0, Math.round(passed))} h have passed.`;
  }
  if (next && smu > next.smu) return `${smu} is higher than a later SMU for ${code} (${next.smu} on ${fmtWhen(next.at)}).`;
  return null;
}

// ---------- Machines tab ----------
function renderUnits() {
  const sums = summaries();
  const q = norm($('search').value);
  const { filter, sort } = state.settings;
  const all = state.units.map((code, i) => ({ code, i, sum: sums[code], st: status(code, sums[code]) }));
  let list = all;
  if (q) list = list.filter((u) => norm(u.code).includes(q));
  if (filter === 'due') list = list.filter((u) => isDue(u.st));
  if (filter === 'today') list = list.filter((u) => u.st.cls === 'today');
  if (filter === 'run') list = list.filter((u) => state.run.includes(u.code));
  if (sort === 'oldest') list = list.slice().sort((a, b) => (b.st.urgency - a.st.urgency) || (a.i - b.i));

  const scope = filter === 'run' && state.run.length ? all.filter((u) => state.run.includes(u.code)) : all;
  const doneToday = scope.filter((u) => u.st.cls === 'today').length;
  const due = scope.filter((u) => u.st.cls === 'over').length;
  $('topSub').textContent = `${doneToday} of ${scope.length}${filter === 'run' && state.run.length ? ' on my run' : ''} greased today` + (due ? ` · ${due} due` : '');
  $('runChip').textContent = state.run.length ? `My run (${state.run.length})` : 'My run';
  $('pickRunBtn').hidden = filter !== 'run';

  let html = '', lastPrefix = null;
  for (const u of list) {
    if (sort === 'sheet' && !q && prefix(u.code) !== lastPrefix) {
      lastPrefix = prefix(u.code);
      const r = ruleFor(u.code);
      html += `<div class="section-head" style="--c:${colour(u.code)}"><i></i>${esc(lastPrefix)}<span>every ${r.every} ${r.mode === 'hours' ? 'h' : r.every === 1 ? 'day' : 'days'}</span></div>`;
    }
    const extra = [];
    if (u.sum && u.sum.grease && u.st.cls !== 'today') extra.push(fmtWhen(u.sum.grease.at));
    if (u.sum && u.sum.fuel) {
      const fd = dayDiff(todayKey(), workDay(u.sum.fuel.at));
      extra.push(`Fuel ${u.sum.fuel.diesel} L ${fd <= 0 ? 'today' : fd === 1 ? 'yesterday' : fd + 'd ago'}`);
    }
    if (u.sum && u.sum.smu) extra.push(`SMU ${u.sum.smu.smu}`);
    const warn = u.sum && u.sum.issues ? `<span class="warn" title="Needs attention">⚠${u.sum.issues > 1 ? u.sum.issues : ''}</span>` : '';
    html += `<div class="unit st-${u.st.cls}" style="--c:${colour(u.code)}">
      <button class="info" data-open="${esc(u.code)}">
        <span class="code">${esc(u.code)}${warn}</span>
        <span class="meta"><b>${esc(u.st.label)}</b><small>${esc(extra.join(' · ') || 'Tap to log fuel, oil, SMU')}</small></span>
      </button>
      <button class="fuel" data-fuel="${esc(u.code)}" aria-label="Log fuel for ${esc(u.code)}">⛽</button>
      <button class="tick" data-tick="${esc(u.code)}" aria-label="Mark ${esc(u.code)} greased">✓</button>
    </div>`;
  }
  const emptyMsg = q ? `No machine matches “${esc($('search').value)}”.`
    : filter === 'run' && !state.run.length ? 'No machines on your run yet. Tap “✎ Pick my run”.'
    : filter === 'today' ? 'Nothing greased yet today.' : 'Nothing due. 👍';
  $('unitList').innerHTML = html || `<p class="empty">${emptyMsg}</p>`;
  document.querySelectorAll('#filterChips button').forEach((b) => b.classList.toggle('on', b.dataset.filter === filter));
  document.querySelectorAll('#sortChips button[data-sort]').forEach((b) => b.classList.toggle('on', b.dataset.sort === sort));
  renderAlerts();
}
function renderAlerts() {
  let html = '';
  const open = state.issues.filter((i) => !i.doneAt).length;
  if (open) html += `<button class="alert attn" data-attn-open><span>⚠ <strong>${open}</strong> need${open === 1 ? 's' : ''} attention</span><span>View ›</span></button>`;
  const days = state.lastBackup ? (Date.now() - new Date(state.lastBackup)) / 864e5 : Infinity;
  if (state.entries.length >= 10 && days >= BACKUP_DAYS)
    html += `<div class="alert"><span>${state.entries.length} entries are only on this phone.</span><button class="btn" data-backup>Back up</button></div>`;
  $('alerts').innerHTML = html;
}

$('unitList').addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-tick]');
  if (t) return quickTick(t.dataset.tick);
  const f = ev.target.closest('[data-fuel]');
  if (f) return openNum(f.dataset.fuel, 'fuel');
  const o = ev.target.closest('[data-open]');
  if (o) openUnit(o.dataset.open);
});
$('alerts').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-backup]')) guard(backupNow)();
  if (ev.target.closest('[data-attn-open]')) openAttn();
});
$('search').addEventListener('input', renderUnits);
$('filterChips').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  state.settings.filter = b.dataset.filter; save(); renderUnits();
  if (b.dataset.filter === 'run' && !state.run.length) openRun();
});
$('sortChips').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-sort]'); if (!b) return;
  state.settings.sort = b.dataset.sort; save(); renderUnits();
});
$('pickRunBtn').addEventListener('click', openRun);

function addEntry(rec) {
  const e = { id: uid(), ...rec };
  state.entries.push(e);
  save(); renderAll();
  return e;
}
function undoEntry(e) {
  state.entries = state.entries.filter((x) => x.id !== e.id);
  forget(e.id); save(); renderAll();
}

function quickTick(code) {
  const sum = summaries()[code];
  const st = status(code, sum);
  if (st.cls === 'today' || (sum && sum.grease && workDay(sum.grease.at) === todayKey())) {
    const e = sum.grease;
    const onlyGrease = e.diesel == null && e.smu == null && e.coolant == null && !e.fob && !e.notes && !Object.keys(e.oils || {}).length;
    if (!confirm(`${code} was already ticked as greased today at ${fmtTime(e.at)}.\n\nRemove that tick?`)) return;
    if (onlyGrease) { state.entries = state.entries.filter((x) => x.id !== e.id); forget(e.id); }
    else e.greased = false;
    save(); renderAll();
    toast(`${code}: grease tick removed`);
    return;
  }
  if (ruleFor(code).mode === 'hours') return openNum(code, 'grease');
  const e = addEntry({ code, at: new Date().toISOString(), greased: true });
  if (navigator.vibrate) navigator.vibrate(30);
  toast(`${code} greased ✓`, 'Undo', () => undoEntry(e));
}

// ---------- quick number dialog: fuel, or grease with SMU ----------
let numCtx = null;
function openNum(code, mode) {
  numCtx = { code, mode };
  const sum = summaries()[code];
  $('nTitle').textContent = mode === 'fuel' ? `⛽ Fuel ${code}` : `✓ Grease ${code}`;
  $('nHint').textContent = mode === 'grease'
    ? `${code} is greased by hours (every ${ruleFor(code).every} h). Enter the SMU now so the app knows when it's next due.`
    : (sum && sum.fuel ? `Last fuel: ${sum.fuel.diesel} L, ${fmtWhen(sum.fuel.at)}` : '');
  $('nDieselWrap').hidden = mode !== 'fuel';
  $('nGreasedWrap').hidden = mode !== 'fuel';
  $('nSkip').hidden = mode !== 'grease';
  $('nDiesel').value = ''; $('nSmu').value = ''; $('nGreased').checked = false;
  $('nSmu').placeholder = sum && sum.smu ? `last ${sum.smu.smu}` : '';
  $('numDlg').returnValue = '';
  $('numDlg').showModal();
  setTimeout(() => (mode === 'fuel' ? $('nDiesel') : $('nSmu')).focus(), 50);
}
$('numDlg').addEventListener('close', () => {
  const rv = $('numDlg').returnValue; const ctx = numCtx; numCtx = null;
  if (!ctx || (rv !== 'save' && rv !== 'skip')) return;
  const at = new Date().toISOString();
  const smu = rv === 'skip' ? null : num($('nSmu').value);
  const rec = { code: ctx.code, at, greased: ctx.mode === 'grease' || $('nGreased').checked, smu };
  if (ctx.mode === 'fuel') {
    rec.diesel = num($('nDiesel').value);
    if (rec.diesel == null && smu == null && !rec.greased) { toast('Nothing filled in, so nothing saved'); return; }
  }
  const w = smuWarning(ctx.code, smu, at);
  if (w && !confirm(`Check the SMU:\n\n${w}\n\nSave it anyway?`)) { numCtx = ctx; $('numDlg').showModal(); return; }
  const e = addEntry(rec);
  if (navigator.vibrate) navigator.vibrate(30);
  const bits = [rec.diesel != null ? `${rec.diesel} L` : '', rec.greased ? 'greased ✓' : '', smu != null ? `SMU ${smu}` : ''].filter(Boolean);
  toast(`${ctx.code} ${bits.join(' · ')}`, 'Undo', () => undoEntry(e));
});

// ---------- machine dialog: full entry like the paper sheet ----------
$('oilFields').innerHTML = OILS.map((o, i) =>
  `<label class="field">${o}<input id="fOil${i}" type="number" step="0.5" inputmode="decimal"></label>`).join('');
let dlgCode = null;
let pendingPhoto = null; // data URL waiting to be saved with a new problem

function openUnit(code, editId) {
  dlgCode = code;
  const sum = summaries()[code];
  const st = status(code, sum);
  const e = editId ? state.entries.find((x) => x.id === editId) : null;
  $('dlgTitle').textContent = code;
  $('dlgStatus').textContent = e ? `Editing entry from ${fmtWhen(e.at)}` : st.cls === 'never' ? 'No grease logged yet'
    : st.cls === 'today' ? st.label : `${st.label} (${fmtWhen(sum.grease.at)})`;
  $('dlgStatus').style.color = `var(--${st.cls === 'today' || st.cls === 'ok' ? 'ok' : st.cls === 'never' ? 'muted' : st.cls})`;
  $('fEditId').value = e ? e.id : '';
  $('fGreased').checked = e ? !!e.greased : st.cls !== 'today';
  $('fAt').value = toLocalInput(e ? new Date(e.at) : new Date());
  $('fSmu').value = e?.smu ?? '';
  $('fSmu').placeholder = sum?.smu ? `last ${sum.smu.smu}` : '';
  $('fDiesel').value = e?.diesel ?? '';
  $('fCoolant').value = e?.coolant ?? '';
  OILS.forEach((o, i) => { $('fOil' + i).value = e?.oils?.[o] ?? ''; });
  $('fFob').checked = !!e?.fob;
  $('fNotes').value = e?.notes ?? '';
  $('fProblem').value = '';
  setPendingPhoto(null);
  $('problemBox').hidden = !!e;
  $('fSave').textContent = e ? 'Save changes' : 'Save';
  renderDlgIssues();
  renderDlgHist();
  $('unitDlg').returnValue = '';
  if (!$('unitDlg').open) $('unitDlg').showModal();
}
function renderDlgIssues() {
  const list = state.issues.filter((i) => i.code === dlgCode && !i.doneAt);
  $('dlgIssues').innerHTML = list.map((i) => issueHtml(i)).join('');
  loadThumbs($('dlgIssues'));
}
function renderDlgHist() {
  const list = state.entries.filter((e) => e.code === dlgCode).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
  $('dlgHist').innerHTML = list.length ? list.map((e) => `<div class="entry">
      <span class="when">${esc(fmtWhen(e.at))}</span>
      <span class="what">${entryText(e)}</span>
      <button type="button" data-edit="${e.id}" aria-label="Edit">✎</button>
      <button type="button" data-del="${e.id}" aria-label="Delete">🗑</button></div>`).join('')
    : '<p class="hint">Nothing logged for this machine yet.</p>';
}
$('dlgHist').addEventListener('click', (ev) => {
  const ed = ev.target.closest('[data-edit]');
  if (ed) { openUnit(dlgCode, ed.dataset.edit); $('unitDlg').scrollTop = 0; return; }
  const del = ev.target.closest('[data-del]');
  if (!del) return;
  const e = state.entries.find((x) => x.id === del.dataset.del);
  if (!e || !confirm(`Delete this entry?\n\n${fmtWhen(e.at)}: ${entryText(e).replace(/<[^>]+>/g, '')}`)) return;
  state.entries = state.entries.filter((x) => x.id !== e.id);
  forget(e.id); save(); renderAll(); renderDlgHist();
  if ($('fEditId').value === e.id) openUnit(dlgCode);
});
$('dlgIssues').addEventListener('click', issueClick);

// Photo for a new problem: shrink to 1280 px JPEG so it doesn't fill the phone.
function shrinkImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Couldn’t read that photo')); };
    img.src = url;
  });
}
function setPendingPhoto(url) {
  pendingPhoto = url;
  $('fPhotoPrev').hidden = !url; $('fPhotoDel').hidden = !url;
  if (url) $('fPhotoPrev').src = url; else $('fPhotoPrev').removeAttribute('src');
  $('fPhotoBtn').textContent = url ? '📷 Retake' : '📷 Add photo';
}
$('fPhotoBtn').addEventListener('click', () => $('fPhoto').click());
$('fPhotoDel').addEventListener('click', () => setPendingPhoto(null));
$('fPhoto').addEventListener('change', async () => {
  const f = $('fPhoto').files[0]; $('fPhoto').value = '';
  if (!f) return;
  try { setPendingPhoto(await shrinkImage(f)); } catch (e) { toast(e.message); }
});

$('unitDlg').addEventListener('close', async () => {
  if ($('unitDlg').returnValue !== 'save') return;
  const oils = {};
  OILS.forEach((o, i) => { const v = num($('fOil' + i).value); if (v != null) oils[o] = v; });
  const at = $('fAt').value ? new Date($('fAt').value) : new Date();
  const rec = {
    code: dlgCode, at: (isNaN(at) ? new Date() : at).toISOString(), greased: $('fGreased').checked,
    smu: num($('fSmu').value), diesel: num($('fDiesel').value), coolant: num($('fCoolant').value),
    oils, fob: $('fFob').checked, notes: $('fNotes').value.trim()
  };
  const problem = $('fProblem').value.trim();
  const editId = $('fEditId').value;
  const old = editId ? state.entries.find((x) => x.id === editId) : null;
  const empty = !rec.greased && rec.smu == null && rec.diesel == null && rec.coolant == null && !Object.keys(oils).length && !rec.fob && !rec.notes;
  if (!editId && empty && !problem && !pendingPhoto) { toast('Nothing filled in, so nothing saved'); return; }
  const w = smuWarning(dlgCode, rec.smu, rec.at, editId);
  if (w && (!old || old.smu !== rec.smu) && !confirm(`Check the SMU:\n\n${w}\n\nSave it anyway?`)) { $('unitDlg').showModal(); return; }

  // Problems for the Needs attention list
  const newIssues = [];
  if (rec.fob && !(old && old.fob) && !state.issues.some((i) => i.code === dlgCode && !i.doneAt && i.fob))
    newIssues.push({ id: uid(), code: dlgCode, at: rec.at, text: 'New fob needed', fob: true, photo: false, doneAt: null });
  if (problem || pendingPhoto) {
    const iss = { id: uid(), code: dlgCode, at: rec.at, text: problem || 'See photo', photo: !!pendingPhoto, doneAt: null };
    if (pendingPhoto) {
      try { await Photos.put(iss.id, pendingPhoto); } catch { iss.photo = false; toast('Photo couldn’t be saved'); }
    }
    newIssues.push(iss);
  }
  state.issues.push(...newIssues);

  if (old) { Object.assign(old, rec); toast(`${dlgCode} entry updated`); save(); renderAll(); }
  else if (!empty) {
    const e = addEntry(rec);
    toast(`${dlgCode} saved${rec.greased ? ' · greased ✓' : ''}${newIssues.length ? ' · ⚠ added' : ''}`, 'Undo', () => {
      const ids = new Set(newIssues.map((i) => i.id));
      state.issues = state.issues.filter((i) => !ids.has(i.id));
      for (const i of newIssues) { forget(i.id); if (i.photo) Photos.del(i.id).catch(() => {}); }
      undoEntry(e);
    });
  } else { save(); renderAll(); toast(`${dlgCode}: ⚠ added to Needs attention`); }
  setPendingPhoto(null);
});

// ---------- Needs attention ----------
let attnView = 'open';
function issueHtml(i) {
  return `<div class="issue${i.doneAt ? ' done' : ''}">
    ${i.photo ? `<img class="thumb" data-photo="${i.id}" alt="Photo">` : ''}
    <div class="what"><b>${esc(i.code)}</b> ${esc(i.text)}<small>${esc(fmtWhen(i.at))}${i.doneAt ? ' · fixed ' + esc(fmtWhen(i.doneAt)) : ''}</small></div>
    ${i.doneAt ? `<button type="button" class="btn" data-reopen="${i.id}">Reopen</button>` : `<button type="button" class="btn ok" data-done="${i.id}">✓ Fixed</button>`}
  </div>`;
}
async function loadThumbs(root) {
  for (const img of root.querySelectorAll('img[data-photo]')) {
    try { const url = await Photos.get(img.dataset.photo); if (url) img.src = url; else img.remove(); } catch { img.remove(); }
  }
}
function issueClick(ev) {
  const ph = ev.target.closest('img[data-photo]');
  if (ph && ph.src) { $('photoBig').src = ph.src; $('photoDlg').showModal(); return; }
  const d = ev.target.closest('[data-done]'), r = ev.target.closest('[data-reopen]');
  const id = (d || r)?.dataset.done || (d || r)?.dataset.reopen;
  const i = id && state.issues.find((x) => x.id === id);
  if (!i) return;
  i.doneAt = d ? new Date().toISOString() : null;
  save(); renderAll();
  if ($('attnDlg').open) renderAttn();
  if ($('unitDlg').open) renderDlgIssues();
  toast(d ? `${i.code}: marked fixed` : `${i.code}: reopened`);
}
function openAttn() { attnView = 'open'; renderAttn(); $('attnDlg').showModal(); }
function renderAttn() {
  const list = state.issues.filter((i) => (attnView === 'open' ? !i.doneAt : i.doneAt))
    .sort((a, b) => (attnView === 'open' ? a.at.localeCompare(b.at) : b.doneAt.localeCompare(a.doneAt))).slice(0, 100);
  $('attnList').innerHTML = list.map(issueHtml).join('') || `<p class="empty">${attnView === 'open' ? 'Nothing needs attention. 👍' : 'Nothing marked fixed yet.'}</p>`;
  document.querySelectorAll('#attnChips button').forEach((b) => b.classList.toggle('on', b.dataset.attn === attnView));
  loadThumbs($('attnList'));
}
$('attnChips').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) { attnView = b.dataset.attn; renderAttn(); } });
$('attnList').addEventListener('click', issueClick);

// ---------- My run ----------
function openRun() { renderRunPick(); $('runDlg').returnValue = ''; $('runDlg').showModal(); }
function renderRunPick() {
  let html = '', last = null;
  for (const code of state.units) {
    if (prefix(code) !== last) { if (last) html += '</div>'; last = prefix(code); html += `<div class="section-head" style="--c:${colour(code)}"><i></i>${esc(last)}</div><div class="pickgrid">`; }
    html += `<button type="button" class="pickbtn${state.run.includes(code) ? ' on' : ''}" data-pick="${esc(code)}">${esc(code)}</button>`;
  }
  $('runPick').innerHTML = html + (last ? '</div>' : '');
}
$('runPick').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-pick]'); if (!b) return;
  const c = b.dataset.pick;
  state.run = state.run.includes(c) ? state.run.filter((x) => x !== c) : [...state.run, c];
  b.classList.toggle('on'); save();
});
$('runAddDue').addEventListener('click', () => {
  const sums = summaries();
  for (const c of state.units) if (isDue(status(c, sums[c])) && !state.run.includes(c)) state.run.push(c);
  save(); renderRunPick();
});
$('runClear').addEventListener('click', () => { state.run = []; save(); renderRunPick(); });
$('runDlg').addEventListener('close', () => { state.settings.filter = 'run'; save(); renderAll(); });

// ---------- History tab ----------
let histLimit = 150;
function renderHistory() {
  const q = norm($('histSearch').value);
  const all = state.entries.filter((e) => !q || norm(e.code).includes(q)).sort((a, b) => b.at.localeCompare(a.at));
  const list = all.slice(0, histLimit);
  let html = '', day = null;
  for (const e of list) {
    const k = workDay(e.at);
    if (k !== day) { day = k; html += `<div class="dayhead">${esc(fmtDay(k))}${k === todayKey() ? ' · today' : ''}</div>`; }
    html += `<div class="entry tap" data-open="${esc(e.code)}" data-id="${e.id}">
      <span class="when">${esc(fmtTime(e.at))}</span>
      <span class="what"><b>${esc(e.code)}</b>${entryText(e)}</span></div>`;
  }
  $('histList').innerHTML = html || `<p class="empty">${q ? 'Nothing logged for that machine.' : 'Nothing logged yet. Tick a machine on the Machines tab.'}</p>`;
  $('histMore').hidden = all.length <= histLimit;
}
$('histList').addEventListener('click', (ev) => {
  const r = ev.target.closest('[data-open]');
  if (r) openUnit(r.dataset.open, r.dataset.id);
});
$('histSearch').addEventListener('input', () => { histLimit = 150; renderHistory(); });
$('histMore').addEventListener('click', () => { histLimit += 150; renderHistory(); });

// ---------- Shift tab: the paper sheet for one work day ----------
let shiftDay = null;
const curShiftKey = () => shiftDay || todayKey();
function shiftRec(k, create) {
  if (state.shifts[k]) return state.shifts[k];
  // Carry name, truck and supervisor over from the latest earlier sheet.
  const prev = Object.keys(state.shifts).filter((x) => x < k).sort().pop();
  const p = prev ? state.shifts[prev] : {};
  const h = new Date().getHours(), s = state.settings.dayStart;
  const rec = { shift: k === todayKey() && ((h - s + 24) % 24) >= 12 ? 'night' : (p.shift || 'day'), name: p.name || '', truck: p.truck || '',
    supervisor: p.supervisor || '', tanks: [], meterStart: null, meterFinish: null, message: '', comments: '' };
  if (create) state.shifts[k] = rec;
  return rec;
}
function shiftData(k) {
  const sh = shiftRec(k, false);
  const list = state.entries.filter((e) => workDay(e.at) === k).sort((a, b) => a.at.localeCompare(b.at));
  const sum = (f) => round1(list.reduce((t, e) => t + (f(e) || 0), 0));
  const A = round1((sh.tanks || []).reduce((t, x) => t + (num(x.litres) || 0), 0));
  const B = sh.meterStart != null && sh.meterFinish != null ? round1(sh.meterFinish - sh.meterStart) : null;
  const C = sum((e) => e.diesel);
  const D = B != null ? round1(B - C) : null;
  const oils = Object.fromEntries(OILS.map((o) => [o, sum((e) => e.oils?.[o])]));
  return { sh, list, A, B, C, D, coolant: sum((e) => e.coolant), oils,
    greased: new Set(list.filter((e) => e.greased).map((e) => e.code)).size, fobs: list.filter((e) => e.fob).length };
}
function renderShift() {
  const k = curShiftKey();
  const d = shiftData(k);
  $('dayTitle').textContent = fmtDay(k) + (k === todayKey() ? ' (today)' : '');
  const h = state.settings.dayStart;
  $('daySub').textContent = `${pad(h)}:00 to ${pad(h)}:00 next day`;
  $('dayNext').disabled = k >= todayKey();

  // header fields (don't clobber the field being typed in)
  document.querySelectorAll('#shiftCard [data-sh]').forEach((inp) => {
    if (inp !== document.activeElement) inp.value = d.sh[inp.dataset.sh] ?? '';
  });
  document.querySelectorAll('#shiftType button').forEach((b) => b.classList.toggle('on', b.dataset.shift === d.sh.shift));
  if (!$('tankRows').contains(document.activeElement)) {
    const tanks = d.sh.tanks && d.sh.tanks.length ? d.sh.tanks : [{}];
    $('tankRows').innerHTML = tanks.map((t, i) => `<div class="tank" data-i="${i}">
      <input data-t="loc" placeholder="Tank location" value="${esc(t.loc || '')}">
      <input data-t="pump" placeholder="Pump" value="${esc(t.pump || '')}">
      <input data-t="litres" type="number" inputmode="decimal" placeholder="Litres" value="${esc(t.litres ?? '')}"></div>`).join('');
  }
  renderCalc(d);

  const tot = [`${d.greased} greased`, `Diesel ${d.C} L`];
  if (d.coolant) tot.push(`Coolant ${d.coolant} L`);
  for (const o of OILS) if (d.oils[o]) tot.push(`${o} ${d.oils[o]} L`);
  if (d.fobs) tot.push(`${d.fobs} new fob${d.fobs > 1 ? 's' : ''}`);
  $('dayTotals').innerHTML = d.list.length ? tot.map((t) => `<span>${esc(t)}</span>`).join('') : '';
  const v = (x) => (x == null ? '' : esc(x));
  $('dayTable').innerHTML = d.list.length
    ? `<tr><th>Unit</th><th>SMU</th><th>Diesel</th><th>Time</th><th>New fob</th><th>Greased</th><th>Coolant</th>${OILS.map((o) => `<th>${o}</th>`).join('')}<th>Notes</th></tr>` +
      d.list.map((e) => `<tr data-open="${esc(e.code)}" data-id="${e.id}"><td>${esc(e.code)}</td><td>${v(e.smu)}</td><td>${v(e.diesel)}</td><td>${esc(fmtTime(e.at))}</td>
        <td>${e.fob ? '✓' : ''}</td><td>${e.greased ? '✓' : ''}</td><td>${v(e.coolant)}</td>${OILS.map((o) => `<td>${v(e.oils?.[o])}</td>`).join('')}<td>${v(e.notes)}</td></tr>`).join('')
    : '<tr><td class="empty">Nothing logged this day.</td></tr>';
}
function renderCalc(d) {
  const f = (x) => (x == null ? '–' : `${x} L`);
  const bad = d.D != null && Math.abs(d.D) > 0.5;
  $('shiftCalc').innerHTML = `
    <div><span>A · Total fuel filled</span><b>${f(d.A)}</b></div>
    <div><span>B · Meter (finish − start)</span><b>${f(d.B)}</b></div>
    <div><span>C · Total fuel issued</span><b>${f(d.C)}</b></div>
    <div class="${bad ? 'bad' : d.D != null ? 'good' : ''}"><span>D · Variance (B − C)</span><b>${f(d.D)}</b></div>`;
}
$('dayTable').addEventListener('click', (ev) => {
  const r = ev.target.closest('tr[data-open]');
  if (r) openUnit(r.dataset.open, r.dataset.id);
});
const shiftBy = (n) => {
  const d = keyToDate(curShiftKey()); d.setDate(d.getDate() + n);
  const k = localKey(d);
  shiftDay = k >= todayKey() ? null : k;
  renderShift();
};
$('dayPrev').addEventListener('click', () => shiftBy(-1));
$('dayNext').addEventListener('click', () => shiftBy(1));
$('shiftCard').addEventListener('input', (ev) => {
  const sh = shiftRec(curShiftKey(), true);
  const t = ev.target;
  if (t.dataset.sh) {
    sh[t.dataset.sh] = t.type === 'number' ? num(t.value) : t.value;
  } else if (t.dataset.t) {
    const i = Number(t.closest('.tank').dataset.i);
    sh.tanks = sh.tanks || [];
    while (sh.tanks.length <= i) sh.tanks.push({});
    sh.tanks[i][t.dataset.t] = t.dataset.t === 'litres' ? num(t.value) : t.value;
  } else return;
  save(); renderCalc(shiftData(curShiftKey()));
});
$('shiftType').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  shiftRec(curShiftKey(), true).shift = b.dataset.shift; save(); renderShift();
});
$('addTank').addEventListener('click', () => {
  const sh = shiftRec(curShiftKey(), true);
  sh.tanks = sh.tanks && sh.tanks.length ? sh.tanks : [{}];
  sh.tanks.push({}); save();
  document.activeElement?.blur(); renderShift();
});

// Shift as text (WhatsApp / SMS)
function shiftText(k) {
  const d = shiftData(k), sh = d.sh;
  const L = [`FUEL & OIL USAGE – ${fmtDate(k)} – ${sh.shift === 'night' ? 'NIGHT' : 'DAY'} SHIFT`];
  if (sh.name) L.push(`Name: ${sh.name}`);
  if (sh.truck) L.push(`Service truck: ${sh.truck}`);
  const tanks = (sh.tanks || []).filter((t) => t.loc || t.pump || t.litres != null);
  if (tanks.length) { L.push('', 'Fuel filled:'); for (const t of tanks) L.push(`- ${[t.loc, t.pump && 'pump ' + t.pump, t.litres != null && t.litres + ' L'].filter(Boolean).join(', ')}`); }
  L.push('', `A Total fuel filled: ${d.A} L`);
  if (sh.meterStart != null || sh.meterFinish != null) L.push(`Bulk meter: ${sh.meterStart ?? '?'} → ${sh.meterFinish ?? '?'}`);
  L.push(`B Meter variance: ${d.B ?? '–'} L`, `C Total fuel issued: ${d.C} L`, `D Variance B−C: ${d.D ?? '–'} L`);
  L.push('', `Greased: ${d.greased} machines`);
  if (d.coolant) L.push(`Coolant: ${d.coolant} L`);
  const oilBits = OILS.filter((o) => d.oils[o]).map((o) => `${o} ${d.oils[o]} L`);
  if (oilBits.length) L.push(`Oil: ${oilBits.join(', ')}`);
  L.push('', 'Unit | SMU | Diesel | Time | Greased | other');
  for (const e of d.list) {
    const other = [e.coolant != null && `coolant ${e.coolant}`, ...OILS.filter((o) => e.oils?.[o] != null).map((o) => `${o} ${e.oils[o]}`), e.fob && 'NEW FOB', e.notes].filter(Boolean).join(', ');
    L.push(`${e.code} | ${e.smu ?? ''} | ${e.diesel ?? ''} | ${fmtTime(e.at)} | ${e.greased ? '✓' : ''}${other ? ' | ' + other : ''}`);
  }
  const open = state.issues.filter((i) => !i.doneAt);
  if (open.length) { L.push('', 'Needs attention:'); for (const i of open) L.push(`- ${i.code}: ${i.text} (${fmtWhen(i.at)})`); }
  if (sh.message) L.push('', `Message: ${sh.message}`);
  if (sh.comments) L.push('', `Comments: ${sh.comments}`);
  if (sh.supervisor) L.push('', `Supervisor: ${sh.supervisor}`);
  return L.join('\n');
}

// Shift as a picture laid out like the paper sheet.
function shiftCanvas(k) {
  const d = shiftData(k), sh = d.sh;
  const W = 1400, P = 30, RH = 38;
  const cols = [['Unit', 140], ['SMU', 120], ['Diesel', 110], ['Time', 110], ['New fob', 90], ['Greased', 95], ['Coolant', 95], ...OILS.map((o) => [o, 78]), ['Notes', 0]];
  const used = cols.reduce((t, c) => t + c[1], 0); cols[cols.length - 1][1] = W - 2 * P - used;
  const open = state.issues.filter((i) => !i.doneAt);
  const tanks = (sh.tanks || []).filter((t) => t.loc || t.pump || t.litres != null);
  const H = P + 60 + 6 * RH + Math.max(1, tanks.length) * RH + 20 + RH * (d.list.length + 1) + 30 + (open.length ? RH * (open.length + 1) : 0) + (sh.comments ? RH * 2 : 0) + 60;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#111'; g.textBaseline = 'middle';
  const font = (sz, b) => { g.font = `${b ? 'bold ' : ''}${sz}px Arial, sans-serif`; };
  const box = (x, y, w, h, fill) => { if (fill) { g.fillStyle = fill; g.fillRect(x, y, w, h); } g.strokeStyle = '#999'; g.lineWidth = 1; g.strokeRect(x + .5, y + .5, w, h); g.fillStyle = '#111'; };
  const text = (s, x, y, w, align) => {
    s = String(s ?? ''); while (s.length > 1 && g.measureText(s).width > w - 10) s = s.slice(0, -2) + '…';
    g.textAlign = align || 'left'; g.fillText(s, align === 'center' ? x + w / 2 : x + 6, y);
  };
  let y = P;
  font(30, true); g.textAlign = 'left'; g.fillText('Fuel & Oil Usage Sheet for Service Trucks', P, y + 18); y += 54;
  // header grid
  const half = (W - 2 * P) / 2, lw = 190;
  const rows = [['Date', fmtDate(k), 'Bulk meter start', sh.meterStart ?? ''], ['Shift', sh.shift === 'night' ? 'NIGHT' : 'DAY', 'Bulk meter finish', sh.meterFinish ?? ''],
    ['Name', sh.name, 'B · Meter variance', d.B != null ? d.B + ' L' : ''], ['Service truck ID', sh.truck, 'C · Total fuel issued', d.C + ' L'],
    ['Supervisor', sh.supervisor, 'D · Variance B − C', d.D != null ? d.D + ' L' : ''], ['Message', sh.message, 'A · Total fuel filled', d.A + ' L']];
  font(17);
  for (const [a, b, cc, dd] of rows) {
    box(P, y, lw, RH, '#e5e5e5'); box(P + lw, y, half - lw, RH); box(P + half, y, lw, RH, '#e5e5e5'); box(P + half + lw, y, half - lw, RH, cc.startsWith('D') && d.D != null && Math.abs(d.D) > 0.5 ? '#fde2e2' : null);
    font(16, true); text(a, P, y + RH / 2, lw); text(cc, P + half, y + RH / 2, lw);
    font(17); text(b, P + lw, y + RH / 2, half - lw); text(dd, P + half + lw, y + RH / 2, half - lw);
    y += RH;
  }
  // tanks
  const tw = [half, half / 2, half / 2];
  const trows = tanks.length ? tanks : [{}];
  for (const t of trows) {
    let x = P;
    [[t.loc ? 'Tank: ' + t.loc : 'Tank location', tw[0]], [t.pump ? 'Pump ' + t.pump : 'Pump', tw[1]], [t.litres != null ? t.litres + ' L' : 'Litres', tw[2]]].forEach(([s, w]) => { box(x, y, w, RH); font(16); text(s, x, y + RH / 2, w); x += w; });
    y += RH;
  }
  y += 20;
  // entries table
  let x = P;
  for (const [h, w] of cols) { box(x, y, w, RH, h === 'Unit' ? '#d6d6d6' : '#e5e5e5'); font(15, true); text(h, x, y + RH / 2, w, 'center'); x += w; }
  y += RH;
  for (const e of d.list) {
    x = P;
    const vals = [e.code, e.smu, e.diesel, fmtTime(e.at), e.fob ? '✓' : '', e.greased ? '✓' : '', e.coolant, ...OILS.map((o) => e.oils?.[o]), e.notes];
    vals.forEach((s, i) => { const [, w] = cols[i]; box(x, y, w, RH, i === 0 ? colour(e.code) + '55' : i === 4 ? '#f6d5c8' : null); font(17, i === 0); text(s, x, y + RH / 2, w, i === cols.length - 1 ? 'left' : 'center'); x += w; });
    y += RH;
  }
  if (!d.list.length) { font(17); g.textAlign = 'left'; g.fillText('Nothing logged this day.', P + 6, y + RH / 2); y += RH; }
  font(16, true); g.textAlign = 'left';
  g.fillText(`Totals: ${d.greased} greased · Diesel ${d.C} L${d.coolant ? ' · Coolant ' + d.coolant + ' L' : ''}${OILS.filter((o) => d.oils[o]).map((o) => ` · ${o} ${d.oils[o]} L`).join('')}`, P, y + 18);
  y += 40;
  if (open.length) {
    font(18, true); g.fillText('Needs attention', P, y + RH / 2); y += RH;
    font(16); for (const i of open) { g.fillText(`⚠ ${i.code}: ${i.text}  (${fmtWhen(i.at)})`, P, y + RH / 2); y += RH; }
  }
  if (sh.comments) { font(16, true); g.fillText('Serviceperson comments:', P, y + RH / 2); y += RH; font(16); g.fillText(sh.comments.slice(0, 160), P, y + RH / 2); y += RH; }
  return c;
}

async function shareText(text, title) {
  if (Sharer) { try { await Sharer.share({ title, text, dialogTitle: title }); } catch { /* backed out */ } return; }
  if (navigator.share) { try { await navigator.share({ title, text }); } catch { /* backed out */ } return; }
  try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into a message.'); } catch { toast('Couldn’t share on this browser'); }
}
async function sharePng(canvas, name, title) {
  const dataUrl = canvas.toDataURL('image/png');
  if (Files && Sharer) {
    const r = await Files.writeFile({ path: name, data: dataUrl.split(',')[1], directory: 'CACHE' });
    try { await Sharer.share({ title, files: [r.uri], dialogTitle: title }); } catch { /* backed out */ }
    return;
  }
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  const file = new File([blob], name, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title }); } catch { /* backed out */ } return; }
  const a = document.createElement('a'); a.href = dataUrl; a.download = name; document.body.append(a); a.click(); a.remove();
}
$('sendText').addEventListener('click', guard(() => shareText(shiftText(curShiftKey()), `Fuel & oil sheet ${fmtDate(curShiftKey())}`)));
$('sendPic').addEventListener('click', guard(() => sharePng(shiftCanvas(curShiftKey()), `fuel-oil-sheet-${curShiftKey()}.png`, `Fuel & oil sheet ${fmtDate(curShiftKey())}`)));

// ---------- Settings ----------
$('dayStart').innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${pad(h)}:00</option>`).join('');
function renderSettings() {
  $('dueDays').value = state.settings.dueDays;
  $('dayStart').value = state.settings.dayStart;
  if (!$('ruleRows').contains(document.activeElement)) {
    const prefixes = [...new Set(state.units.map(prefix))];
    $('ruleRows').innerHTML = prefixes.map((p) => {
      const r = state.settings.rules[p];
      return `<div class="rule" data-p="${esc(p)}" style="--c:${TYPE_COLOURS[p] || '#b8b8b8'}"><b>${esc(p)}</b>
        <select data-r="mode"><option value="">Default</option><option value="days"${r?.mode === 'days' ? ' selected' : ''}>Every … days</option><option value="hours"${r?.mode === 'hours' ? ' selected' : ''}>Every … SMU hours</option></select>
        <input data-r="every" type="number" min="1" inputmode="numeric" value="${r ? r.every : ''}" placeholder="${state.settings.dueDays}"${r ? '' : ' disabled'}></div>`;
    }).join('');
  }
  if (document.activeElement !== $('unitsText')) $('unitsText').value = state.units.join('\n');
  $('backupInfo').textContent = state.lastBackup ? `Last backup: ${fmtWhen(state.lastBackup)}.` : 'No backup saved yet. Everything is only on this phone.';
  $('handoverInfo').textContent = state.lastHandover ? `Last loaded from the other crew: ${fmtWhen(state.lastHandover)}.` : '';
  $('versionLine').textContent = `Brad's Grease Log ${APP_VERSION} · ${state.entries.length} entries · ${state.units.length} machines`;
}
$('ruleRows').addEventListener('change', (ev) => {
  const row = ev.target.closest('.rule'); if (!row) return;
  const p = row.dataset.p;
  const mode = row.querySelector('[data-r="mode"]').value;
  const inp = row.querySelector('[data-r="every"]');
  if (!mode) { delete state.settings.rules[p]; inp.value = ''; inp.disabled = true; }
  else {
    inp.disabled = false;
    let every = Math.round(num(inp.value));
    if (!(every > 0)) { every = mode === 'hours' ? 250 : state.settings.dueDays; inp.value = every; }
    state.settings.rules[p] = { mode, every };
  }
  save(); toast(mode ? `${p}: grease every ${state.settings.rules[p].every} ${mode === 'hours' ? 'SMU hours' : 'days'}` : `${p}: back to default`);
});
$('dueDays').addEventListener('change', () => {
  const v = Math.round(num($('dueDays').value));
  if (v >= 1 && v <= 60) { state.settings.dueDays = v; save(); renderAll(); toast(`Default: grease every ${v} day${v > 1 ? 's' : ''}`); }
  else $('dueDays').value = state.settings.dueDays;
});
$('dayStart').addEventListener('change', () => { state.settings.dayStart = Number($('dayStart').value); save(); renderAll(); });
$('unitsSave').addEventListener('click', () => {
  const seen = new Set();
  const list = $('unitsText').value.split(/[\n,]+/).map((s) => s.trim().toUpperCase()).filter((s) => s && !seen.has(s) && seen.add(s));
  if (!list.length) { toast('Add at least one machine'); return; }
  const added = list.filter((c) => !state.units.includes(c)).length;
  const removed = state.units.filter((c) => !list.includes(c)).length;
  state.units = list; state.run = state.run.filter((c) => list.includes(c));
  save(); document.activeElement?.blur(); renderAll();
  toast(`Machines saved (${list.length})` + (added ? ` · ${added} added` : '') + (removed ? ` · ${removed} removed` : ''));
});

// ---------- files: backup, handover, restore, CSV ----------
async function saveFile(name, text, mime) {
  if (Files && Sharer) {
    const r = await Files.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
    try { await Sharer.share({ title: name, files: [r.uri], dialogTitle: `Save or send ${name}` }); }
    catch { return false; }
    return true;
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}
async function bundle(kind) {
  let photos = {};
  try { photos = await Photos.all(); } catch { /* no photos */ }
  return JSON.stringify({ format: 'grease-log-backup', kind, version: 2, app: APP_VERSION, exportedAt: new Date().toISOString(),
    units: state.units, settings: state.settings, entries: state.entries, issues: state.issues, shifts: state.shifts,
    deleted: state.deleted, photos });
}
async function backupNow() {
  if (!await saveFile(`grease-log-backup-${localKey(new Date())}.json`, await bundle('backup'), 'application/json')) { toast('Backup not saved'); return; }
  state.lastBackup = new Date().toISOString(); save(); renderAll();
  toast(`Backup saved: ${state.entries.length} entries`);
}
async function handoverSend() {
  const name = `grease-log-handover-${localKey(new Date())}-${pad(new Date().getHours())}${pad(new Date().getMinutes())}.json`;
  if (await saveFile(name, await bundle('handover'), 'application/json')) toast('Handover file ready to send');
}
// Merge another phone's (or a backup's) data in. Nothing here is lost; deletions from either side stick.
async function mergeIn(data, replaceSetup) {
  const gone = new Set([...state.deleted, ...(Array.isArray(data.deleted) ? data.deleted : [])]);
  state.deleted = [...gone].slice(-5000);
  const before = new Set(state.entries.map((e) => e.id));
  const byId = new Map(state.entries.map((e) => [e.id, e]));
  for (const e of data.entries || []) if (e && e.id && e.code && e.at && !byId.has(e.id)) byId.set(e.id, e);
  state.entries = [...byId.values()].filter((e) => !gone.has(e.id));
  const added = state.entries.filter((e) => !before.has(e.id)).length;
  const iss = new Map(state.issues.map((i) => [i.id, i]));
  for (const i of data.issues || []) {
    if (!i || !i.id) continue;
    const mine = iss.get(i.id);
    if (!mine) iss.set(i.id, i);
    else if (i.doneAt && !mine.doneAt) mine.doneAt = i.doneAt;
  }
  state.issues = [...iss.values()].filter((i) => !gone.has(i.id));
  for (const [k, sh] of Object.entries(data.shifts || {})) if (!state.shifts[k] || replaceSetup) state.shifts[k] = sh;
  for (const [id, url] of Object.entries(data.photos || {})) { try { await Photos.put(id, url); } catch { /* skip */ } }
  if (replaceSetup) {
    if (Array.isArray(data.units) && data.units.length) state.units = data.units.map(String);
    if (data.settings) Object.assign(state.settings, data.settings);
  } else {
    for (const u of data.units || []) if (!state.units.includes(u)) state.units.push(String(u));
  }
  return added;
}
function csv(rows) {
  const cell = (x) => {
    let s = x == null ? '' : String(x);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
async function exportCsv() {
  const rows = state.entries.slice().sort((a, b) => a.at.localeCompare(b.at)).map((e) => {
    const d = new Date(e.at);
    return [workDay(e.at), localKey(d), `${pad(d.getHours())}:${pad(d.getMinutes())}`, e.code, e.smu, e.diesel, e.fob ? 'Yes' : '',
      e.greased ? 'Yes' : '', e.coolant, ...OILS.map((o) => e.oils?.[o]), e.notes];
  });
  await saveFile(`grease-log-${localKey(new Date())}.csv`,
    csv([['Work day', 'Date', 'Time', 'Unit', 'SMU', 'Diesel (L)', 'New fob needed', 'Greased', 'Coolant (L)', ...OILS.map((o) => `${o} (L)`), 'Notes'], ...rows]), 'text/csv');
}
function guard(fn) { return async () => { try { await fn(); } catch (err) { toast(`Something went wrong: ${err?.message || err}`); } }; }
$('backupBtn').addEventListener('click', guard(backupNow));
$('csvBtn').addEventListener('click', guard(exportCsv));
$('handoverSend').addEventListener('click', guard(handoverSend));
let fileMode = 'restore';
$('restoreBtn').addEventListener('click', () => { fileMode = 'restore'; $('dataFile').click(); });
$('handoverLoad').addEventListener('click', () => { fileMode = 'handover'; $('dataFile').click(); });

let pending = null;
$('dataFile').addEventListener('change', async () => {
  const f = $('dataFile').files[0]; $('dataFile').value = '';
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch { toast('That file isn’t from Grease Log'); return; }
  if (data?.format !== 'grease-log-backup' || !Array.isArray(data.entries)) { toast('That file isn’t from Grease Log'); return; }
  pending = { data, mode: fileMode };
  const known = new Set(state.entries.map((e) => e.id));
  const fresh = data.entries.filter((e) => e && !known.has(e.id)).length;
  const when = esc(new Date(data.exportedAt).toLocaleString('en-AU'));
  if (fileMode === 'handover') {
    $('restoreTitle').textContent = 'Load the other crew’s log?';
    $('restoreBody').innerHTML = `<p>File from <strong>${when}</strong>: <strong>${fresh}</strong> new entr${fresh === 1 ? 'y' : 'ies'} to add.</p>
      <p class="hint">Their ticks, fuel and problems are added to yours. Your own entries, machine list and settings stay as they are.</p>`;
    $('restoreOk').textContent = 'Load';
  } else {
    $('restoreTitle').textContent = 'Restore backup?';
    $('restoreBody').innerHTML = `<p>Backup from <strong>${when}</strong>: ${data.entries.length} entries, ${(data.units || []).length} machines.</p>
      <p class="hint">Entries from the backup are added to this phone (ones already here are kept). The machine list and settings are replaced by the backup’s.</p>`;
    $('restoreOk').textContent = 'Restore';
  }
  $('restoreDlg').returnValue = '';
  $('restoreDlg').showModal();
});
$('restoreDlg').addEventListener('close', async () => {
  const p = pending; pending = null;
  if ($('restoreDlg').returnValue !== 'restore' || !p) return;
  const added = await mergeIn(p.data, p.mode === 'restore');
  if (p.mode === 'handover') state.lastHandover = new Date().toISOString();
  save(); renderAll();
  toast(p.mode === 'handover' ? `Loaded: ${added} new entries from the other crew` : `Restored. ${state.entries.length} entries on this phone.`);
});

// ---------- tabs, toast, back button ----------
let tab = 'units';
function showTab(t) {
  tab = t;
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== 'tab-' + t;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  if (t === 'today') shiftDay = null;
  renderAll();
  window.scrollTo(0, 0);
}
$('tabs').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) showTab(b.dataset.tab); });

function renderAll() {
  if (tab === 'units') renderUnits();
  else if (tab === 'history') renderHistory();
  else if (tab === 'today') renderShift();
  else renderSettings();
}

let toastTimer = null;
function toast(msg, actionLabel, action) {
  const t = $('toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + (actionLabel ? `<button>${esc(actionLabel)}</button>` : '');
  if (actionLabel) t.querySelector('button').onclick = () => { t.hidden = true; action(); };
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, actionLabel ? 6000 : 3000);
}

CapApp?.addListener('backButton', () => {
  const open = [...document.querySelectorAll('dialog[open]')].pop();
  if (open) { open.close('cancel'); return; }
  if (tab !== 'units') { showTab('units'); return; }
  CapApp.exitApp();
});

// Refresh "today" when the app comes back to the front (e.g. next morning).
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderAll(); });

if ('serviceWorker' in navigator && !NATIVE && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
showTab('units');
