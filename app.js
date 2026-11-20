// Brad's Grease Log: tick machines off as they're greased, log fuel and oil like the paper sheet.
// Everything is stored on the phone (localStorage); back up from Settings.
'use strict';
const APP_VERSION = '1.0';
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
const prefix = (code) => ((code.match(/^[A-Za-z]+/) || ['?'])[0]).toUpperCase();
const colour = (code) => TYPE_COLOURS[prefix(code)] || '#b8b8b8';
const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));

// ---------- data ----------
function defaults() {
  return {
    units: window.SEED_UNITS.slice(),
    entries: [], // {id, code, at (ISO), greased, smu, diesel, coolant, oils:{grade:L}, fob, notes}
    settings: { dueDays: 7, dayStart: 6, sort: 'sheet', filter: 'all' },
    lastBackup: null
  };
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.units) && Array.isArray(s.entries)) {
      s.settings = Object.assign(defaults().settings, s.settings || {});
      return s;
    }
  } catch { /* fall through to a fresh start */ }
  return defaults();
}
const state = load();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Couldn’t save on this phone: ' + (e.message || e)); }
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// ---------- dates ----------
const pad = (n) => String(n).padStart(2, '0');
const localKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// A work day runs from dayStart (e.g. 6am) to dayStart the next morning, so night shift stays together.
const workDay = (at) => localKey(new Date(new Date(at).getTime() - state.settings.dayStart * 3600e3));
const keyToDate = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const dayDiff = (a, b) => Math.round((keyToDate(a) - keyToDate(b)) / 864e5);
const fmtTime = (at) => new Date(at).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
const fmtDay = (k) => keyToDate(k).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtWhen = (at) => `${new Date(at).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })} ${fmtTime(at)}`;
const toLocalInput = (d) => `${localKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const todayKey = () => workDay(new Date());

// ---------- per-machine summary ----------
function summaries() {
  const m = {};
  for (const e of state.entries) {
    const s = m[e.code] || (m[e.code] = {});
    if (e.greased && (!s.grease || e.at > s.grease.at)) s.grease = e;
    if (e.diesel != null && (!s.fuel || e.at > s.fuel.at)) s.fuel = e;
    if (e.smu != null && (!s.smu || e.at > s.smu.at)) s.smu = e;
  }
  return m;
}
function status(sum) {
  if (!sum || !sum.grease) return { cls: 'never', days: Infinity, label: 'Not greased yet' };
  const d = dayDiff(todayKey(), workDay(sum.grease.at));
  const due = state.settings.dueDays;
  const label = d <= 0 ? `Greased today ${fmtTime(sum.grease.at)}` : d === 1 ? 'Greased yesterday' : `Greased ${d} days ago`;
  const cls = d <= 0 ? 'today' : d >= due ? 'over' : d >= due - 1 && due > 1 ? 'soon' : 'ok';
  return { cls, days: d, label: cls === 'over' ? `${label} · due` : label };
}
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

// ---------- Machines tab ----------
function renderUnits() {
  const sums = summaries();
  const q = norm($('search').value);
  const { filter, sort } = state.settings;
  let list = state.units.map((code, i) => ({ code, i, sum: sums[code], st: status(sums[code]) }));
  if (q) list = list.filter((u) => norm(u.code).includes(q));
  if (filter === 'due') list = list.filter((u) => u.st.cls === 'over' || u.st.cls === 'soon' || u.st.cls === 'never');
  if (filter === 'today') list = list.filter((u) => u.st.cls === 'today');
  if (sort === 'oldest') list.sort((a, b) => (b.st.days - a.st.days) || (a.i - b.i));

  const doneToday = state.units.filter((c) => status(sums[c]).cls === 'today').length;
  const overdue = state.units.filter((c) => status(sums[c]).cls === 'over').length;
  $('topSub').textContent = `${doneToday} of ${state.units.length} greased today` + (overdue ? ` · ${overdue} due` : '');

  let html = '', lastPrefix = null;
  for (const u of list) {
    if (sort === 'sheet' && !q && prefix(u.code) !== lastPrefix) {
      lastPrefix = prefix(u.code);
      html += `<div class="section-head" style="--c:${colour(u.code)}"><i></i>${esc(lastPrefix)}</div>`;
    }
    const extra = [];
    if (u.sum && u.sum.grease && u.st.cls !== 'today') extra.push(fmtWhen(u.sum.grease.at));
    if (u.sum && u.sum.fuel) {
      const fd = dayDiff(todayKey(), workDay(u.sum.fuel.at));
      extra.push(`Fuel ${u.sum.fuel.diesel} L ${fd <= 0 ? 'today' : fd === 1 ? 'yesterday' : fd + 'd ago'}`);
    }
    if (u.sum && u.sum.smu) extra.push(`SMU ${u.sum.smu.smu}`);
    html += `<div class="unit st-${u.st.cls}" style="--c:${colour(u.code)}">
      <button class="info" data-open="${esc(u.code)}">
        <span class="code">${esc(u.code)}</span>
        <span class="meta"><b>${esc(u.st.label)}</b><small>${esc(extra.join(' · ') || 'Tap to log fuel, oil, SMU')}</small></span>
      </button>
      <button class="tick" data-tick="${esc(u.code)}" aria-label="Mark ${esc(u.code)} greased">✓</button>
    </div>`;
  }
  $('unitList').innerHTML = html || `<p class="empty">${q ? 'No machine matches “' + esc($('search').value) + '”.' : filter === 'today' ? 'Nothing greased yet today.' : 'Nothing due. 👍'}</p>`;
  document.querySelectorAll('#filterChips button').forEach((b) => b.classList.toggle('on', b.dataset.filter === filter));
  document.querySelectorAll('#sortChips button').forEach((b) => b.classList.toggle('on', b.dataset.sort === sort));
  renderAlerts();
}
function renderAlerts() {
  const days = state.lastBackup ? (Date.now() - new Date(state.lastBackup)) / 864e5 : Infinity;
  $('alerts').innerHTML = state.entries.length >= 10 && days >= BACKUP_DAYS
    ? `<div class="alert"><span>${state.entries.length} entries are only on this phone.</span><button class="btn" data-backup>Back up</button></div>` : '';
}

$('unitList').addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-tick]');
  if (t) return quickTick(t.dataset.tick);
  const o = ev.target.closest('[data-open]');
  if (o) openUnit(o.dataset.open);
});
$('alerts').addEventListener('click', (ev) => { if (ev.target.closest('[data-backup]')) guard(backupNow)(); });
$('search').addEventListener('input', renderUnits);
$('filterChips').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  state.settings.filter = b.dataset.filter; save(); renderUnits();
});
$('sortChips').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  state.settings.sort = b.dataset.sort; save(); renderUnits();
});

function quickTick(code) {
  const sum = summaries()[code];
  if (status(sum).cls === 'today') {
    const e = sum.grease;
    const onlyGrease = e.diesel == null && e.smu == null && e.coolant == null && !e.fob && !e.notes && !Object.keys(e.oils || {}).length;
    if (!confirm(`${code} was already ticked as greased today at ${fmtTime(e.at)}.\n\nRemove that tick?`)) return;
    if (onlyGrease) state.entries = state.entries.filter((x) => x.id !== e.id);
    else e.greased = false;
    save(); renderAll();
    toast(`${code}: grease tick removed`);
    return;
  }
  const e = { id: uid(), code, at: new Date().toISOString(), greased: true };
  state.entries.push(e);
  save(); renderAll();
  if (navigator.vibrate) navigator.vibrate(30);
  toast(`${code} greased ✓`, 'Undo', () => {
    state.entries = state.entries.filter((x) => x.id !== e.id);
    save(); renderAll();
  });
}

// ---------- machine dialog: full entry like the paper sheet ----------
$('oilFields').innerHTML = OILS.map((o, i) =>
  `<label class="field">${o}<input id="fOil${i}" type="number" step="0.5" inputmode="decimal"></label>`).join('');
let dlgCode = null;

function openUnit(code, editId) {
  dlgCode = code;
  const sum = summaries()[code];
  const st = status(sum);
  const e = editId ? state.entries.find((x) => x.id === editId) : null;
  $('dlgTitle').textContent = code;
  $('dlgStatus').textContent = e ? `Editing entry from ${fmtWhen(e.at)}` : st.cls === 'never' ? 'No grease logged yet' : st.cls === 'today' ? st.label : `${st.label} (${fmtWhen(sum.grease.at)})`;
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
  $('fSave').textContent = e ? 'Save changes' : 'Save';
  renderDlgHist();
  $('unitDlg').returnValue = '';
  if (!$('unitDlg').open) $('unitDlg').showModal();
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
  save(); renderAll(); renderDlgHist();
  if ($('fEditId').value === e.id) openUnit(dlgCode);
});
$('unitDlg').addEventListener('close', () => {
  if ($('unitDlg').returnValue !== 'save') return;
  const oils = {};
  OILS.forEach((o, i) => { const v = num($('fOil' + i).value); if (v != null) oils[o] = v; });
  const at = $('fAt').value ? new Date($('fAt').value) : new Date();
  const rec = {
    code: dlgCode, at: (isNaN(at) ? new Date() : at).toISOString(), greased: $('fGreased').checked,
    smu: num($('fSmu').value), diesel: num($('fDiesel').value), coolant: num($('fCoolant').value),
    oils, fob: $('fFob').checked, notes: $('fNotes').value.trim()
  };
  const empty = !rec.greased && rec.smu == null && rec.diesel == null && rec.coolant == null && !Object.keys(oils).length && !rec.fob && !rec.notes;
  const editId = $('fEditId').value;
  if (editId) {
    const e = state.entries.find((x) => x.id === editId);
    if (e) Object.assign(e, rec);
    toast(`${dlgCode} entry updated`);
  } else {
    if (empty) { toast('Nothing filled in, so nothing saved'); return; }
    state.entries.push({ id: uid(), ...rec });
    toast(`${dlgCode} saved${rec.greased ? ' · greased ✓' : ''}`);
  }
  save(); renderAll();
});

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

// ---------- Shift tab: one work day in paper-sheet columns ----------
let shiftDay = null;
function renderShift() {
  const k = shiftDay || todayKey();
  const list = state.entries.filter((e) => workDay(e.at) === k).sort((a, b) => a.at.localeCompare(b.at));
  $('dayTitle').textContent = fmtDay(k) + (k === todayKey() ? ' (today)' : '');
  const h = state.settings.dayStart;
  $('daySub').textContent = `${pad(h)}:00 to ${pad(h)}:00 next day`;
  $('dayNext').disabled = k >= todayKey();
  const sum = (f) => list.reduce((t, e) => t + (f(e) || 0), 0);
  const greased = new Set(list.filter((e) => e.greased).map((e) => e.code)).size;
  const tot = [`${greased} greased`, `Diesel ${sum((e) => e.diesel)} L`];
  const cool = sum((e) => e.coolant); if (cool) tot.push(`Coolant ${cool} L`);
  for (const o of OILS) { const v = sum((e) => e.oils?.[o]); if (v) tot.push(`${o} ${v} L`); }
  const fobs = list.filter((e) => e.fob).length; if (fobs) tot.push(`${fobs} new fob${fobs > 1 ? 's' : ''}`);
  $('dayTotals').innerHTML = list.length ? tot.map((t) => `<span>${esc(t)}</span>`).join('') : '';
  const v = (x) => (x == null ? '' : esc(x));
  $('dayTable').innerHTML = list.length
    ? `<tr><th>Unit</th><th>SMU</th><th>Diesel</th><th>Time</th><th>New fob</th><th>Greased</th><th>Coolant</th>${OILS.map((o) => `<th>${o}</th>`).join('')}<th>Notes</th></tr>` +
      list.map((e) => `<tr data-open="${esc(e.code)}" data-id="${e.id}"><td>${esc(e.code)}</td><td>${v(e.smu)}</td><td>${v(e.diesel)}</td><td>${esc(fmtTime(e.at))}</td>
        <td>${e.fob ? '✓' : ''}</td><td>${e.greased ? '✓' : ''}</td><td>${v(e.coolant)}</td>${OILS.map((o) => `<td>${v(e.oils?.[o])}</td>`).join('')}<td>${v(e.notes)}</td></tr>`).join('')
    : '<tr><td class="empty">Nothing logged this day.</td></tr>';
}
$('dayTable').addEventListener('click', (ev) => {
  const r = ev.target.closest('tr[data-open]');
  if (r) openUnit(r.dataset.open, r.dataset.id);
});
const shiftBy = (n) => {
  const d = keyToDate(shiftDay || todayKey()); d.setDate(d.getDate() + n);
  const k = localKey(d);
  shiftDay = k >= todayKey() ? null : k;
  renderShift();
};
$('dayPrev').addEventListener('click', () => shiftBy(-1));
$('dayNext').addEventListener('click', () => shiftBy(1));

// ---------- Settings ----------
$('dayStart').innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${pad(h)}:00</option>`).join('');
function renderSettings() {
  $('dueDays').value = state.settings.dueDays;
  $('dayStart').value = state.settings.dayStart;
  if (document.activeElement !== $('unitsText')) $('unitsText').value = state.units.join('\n');
  $('backupInfo').textContent = state.lastBackup ? `Last backup: ${fmtWhen(state.lastBackup)}.` : 'No backup saved yet. Everything is only on this phone.';
  $('versionLine').textContent = `Brad's Grease Log ${APP_VERSION} · ${state.entries.length} entries · ${state.units.length} machines`;
}
$('dueDays').addEventListener('change', () => {
  const v = Math.round(num($('dueDays').value));
  if (v >= 1 && v <= 60) { state.settings.dueDays = v; save(); renderAll(); toast(`Grease due after ${v} day${v > 1 ? 's' : ''}`); }
  else $('dueDays').value = state.settings.dueDays;
});
$('dayStart').addEventListener('change', () => { state.settings.dayStart = Number($('dayStart').value); save(); renderAll(); });
$('unitsSave').addEventListener('click', () => {
  const seen = new Set();
  const list = $('unitsText').value.split(/[\n,]+/).map((s) => s.trim().toUpperCase()).filter((s) => s && !seen.has(s) && seen.add(s));
  if (!list.length) { toast('Add at least one machine'); return; }
  const added = list.filter((c) => !state.units.includes(c)).length;
  const removed = state.units.filter((c) => !list.includes(c)).length;
  state.units = list; save(); renderAll();
  toast(`Machines saved (${list.length})` + (added ? ` · ${added} added` : '') + (removed ? ` · ${removed} removed` : ''));
});

// ---------- backup, restore, CSV ----------
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
async function backupNow() {
  const body = JSON.stringify({ format: 'grease-log-backup', version: 1, app: APP_VERSION, exportedAt: new Date().toISOString(),
    units: state.units, settings: state.settings, entries: state.entries });
  if (!await saveFile(`grease-log-backup-${localKey(new Date())}.json`, body, 'application/json')) { toast('Backup not saved'); return; }
  state.lastBackup = new Date().toISOString(); save(); renderAll();
  toast(`Backup saved: ${state.entries.length} entries`);
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
const guard = (fn) => async () => { try { await fn(); } catch (err) { toast(`Couldn’t save the file: ${err?.message || err}`); } };
$('backupBtn').addEventListener('click', guard(backupNow));
$('csvBtn').addEventListener('click', guard(exportCsv));
$('restoreBtn').addEventListener('click', () => $('restoreFile').click());

let pending = null;
$('restoreFile').addEventListener('change', async () => {
  const f = $('restoreFile').files[0]; $('restoreFile').value = '';
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch { toast('That file isn’t a Grease Log backup'); return; }
  if (data?.format !== 'grease-log-backup' || !Array.isArray(data.entries)) { toast('That file isn’t a Grease Log backup'); return; }
  pending = data;
  $('restoreBody').innerHTML = `<p>Backup from <strong>${esc(new Date(data.exportedAt).toLocaleString('en-AU'))}</strong>: ${data.entries.length} entries, ${(data.units || []).length} machines.</p>
    <p class="hint">Entries from the backup are added to this phone (ones already here are kept). The machine list is replaced by the backup’s list.</p>`;
  $('restoreDlg').returnValue = '';
  $('restoreDlg').showModal();
});
$('restoreDlg').addEventListener('close', () => {
  if ($('restoreDlg').returnValue !== 'restore' || !pending) { pending = null; return; }
  const byId = new Map(state.entries.map((e) => [e.id, e]));
  for (const e of pending.entries) if (e && e.id && e.code && e.at) byId.set(e.id, e);
  state.entries = [...byId.values()];
  if (Array.isArray(pending.units) && pending.units.length) state.units = pending.units.map(String);
  if (pending.settings) Object.assign(state.settings, pending.settings);
  pending = null; save(); renderAll();
  toast(`Restored. ${state.entries.length} entries on this phone.`);
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
  const open = document.querySelector('dialog[open]');
  if (open) { open.close('cancel'); return; }
  if (tab !== 'units') { showTab('units'); return; }
  CapApp.exitApp();
});

// Refresh "today" when the app comes back to the front (e.g. next morning).
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderAll(); });

if ('serviceWorker' in navigator && !NATIVE && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
showTab('units');
