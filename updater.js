// Tự cập nhật: tải file mới từ GitHub, ghi đè vào thư mục extension (đã cấp quyền 1 lần), rồi tự tải lại.
const UPDATE_URL = 'https://raw.githubusercontent.com/vanlongER/eh-tiktok-alert/main/update.json';

function ehIdb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('eh-updater', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function ehKvGet(k) {
  const db = await ehIdb();
  return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function ehKvSet(k, v) {
  const db = await ehIdb();
  return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
}
function ehVerCmp(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

// trả về {ok, status, needDir?}
async function checkUpdate(force) {
  try {
    const cur = chrome.runtime.getManifest().version;
    const r = await fetch(UPDATE_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return { ok: false, status: 'Không tải được update.json (' + r.status + ')' };
    const u = await r.json();
    if (!u || !u.version || !Array.isArray(u.files) || !u.files.includes('manifest.json')) return { ok: false, status: 'update.json sai định dạng' };
    if (!force && ehVerCmp(u.version, cur) <= 0) return { ok: true, status: 'Đang dùng bản mới nhất: ' + cur };
    const dir = await ehKvGet('dir');
    if (!dir) return { ok: false, needDir: true, status: 'Có bản ' + u.version + ' nhưng chưa chọn thư mục extension' };
    if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') return { ok: false, needDir: true, status: 'Có bản ' + u.version + ' nhưng cần cấp lại quyền thư mục' };
    const base = UPDATE_URL.replace('update.json', '');
    const files = [];
    for (const f of u.files) {
      if (!/^[\w.\-]+$/.test(f)) return { ok: false, status: 'Tên file không hợp lệ: ' + f };
      const fr = await fetch(base + f + '?t=' + Date.now(), { cache: 'no-store' });
      if (!fr.ok) return { ok: false, status: 'Không tải được ' + f };
      const tx = await fr.text();
      if (!tx.trim()) return { ok: false, status: 'File rỗng: ' + f };
      files.push([f, tx]);
    }
    files.sort((a, b) => (a[0] === 'manifest.json') - (b[0] === 'manifest.json')); // manifest ghi sau cùng
    for (const [f, tx] of files) {
      const fh = await dir.getFileHandle(f, { create: true });
      const w = await fh.createWritable();
      await w.write(tx);
      await w.close();
    }
    await chrome.storage.local.set({ updatedTo: u.version, updatedNotes: u.notes || '' });
    setTimeout(() => chrome.runtime.reload(), 600);
    return { ok: true, status: 'Đã cập nhật lên ' + u.version + ', đang tải lại...' };
  } catch (e) {
    return { ok: false, status: 'Lỗi cập nhật: ' + e };
  }
}
