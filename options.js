const $ = (id) => document.getElementById(id);
const say = (t) => { $('msg').textContent = t; };
async function load() {
  const c = await chrome.storage.sync.get({ token: '', chatId: '', threadId: '', intervalMin: 10, heartbeat: true });
  $('token').value = c.token; $('chatId').value = c.chatId; $('threadId').value = c.threadId;
  $('intervalMin').value = c.intervalMin; $('heartbeat').checked = c.heartbeat;
  const l = await chrome.storage.local.get('lastScan');
  $('last').textContent = l.lastScan ? 'Lần quét gần nhất: ' + new Date(l.lastScan.at).toLocaleString('vi-VN') + ' – ' + l.lastScan.status : '';
}
$('save').onclick = async () => {
  await chrome.storage.sync.set({
    token: $('token').value.trim(), chatId: $('chatId').value.trim(), threadId: $('threadId').value.trim(),
    intervalMin: Math.max(5, Number($('intervalMin').value) || 10), heartbeat: $('heartbeat').checked
  });
  say('Đã lưu.');
};
$('test').onclick = async () => { await $('save').onclick(); say('Đang gửi thử...'); const r = await chrome.runtime.sendMessage({ type: 'test' }); say(r && r.ok ? 'Gửi thử OK, kiểm tra Telegram.' : 'Lỗi: ' + (r && r.err)); };
$('scan').onclick = async () => { await $('save').onclick(); say('Đang quét (khoảng 30 giây)...'); const r = await chrome.runtime.sendMessage({ type: 'scanNow' }); say(r && r.ok ? 'Quét xong.' : 'Không quét được: ' + (r && r.err)); $('pickdir').onclick = async () => {
  try {
    const h = await showDirectoryPicker({ id: 'ehext', mode: 'readwrite' });
    let okManifest = false;
    try { const f = await (await h.getFileHandle('manifest.json')).getFile(); okManifest = /EH TikTok/.test(await f.text()); } catch (e) {}
    if (!okManifest) { $('updmsg').textContent = 'Thư mục này không phải thư mục extension (không thấy manifest.json). Chọn lại đúng thư mục.'; return; }
    await ehKvSet('dir', h);
    $('updmsg').textContent = 'Đã chọn thư mục: ' + h.name + '. Tự cập nhật đã sẵn sàng.';
  } catch (e) { $('updmsg').textContent = 'Chưa chọn thư mục (' + e.name + ').'; }
};
$('upd').onclick = async () => { $('updmsg').textContent = 'Đang kiểm tra...'; const r = await chrome.runtime.sendMessage({ type: 'updateNow' }); $('updmsg').textContent = r ? r.status : 'Lỗi'; };
(async () => {
  const d = await ehKvGet('dir').catch(() => null);
  const l = await chrome.storage.local.get('lastUpdateCheck');
  $('updmsg').textContent = (d ? 'Thư mục đã chọn: ' + d.name + '. ' : 'Chưa chọn thư mục. ') + (l.lastUpdateCheck ? 'Lần kiểm tra gần nhất: ' + l.lastUpdateCheck.status : '');
})();
load(); };
$('reset').onclick = async () => { await chrome.runtime.sendMessage({ type: 'reset' }); say('Đã xoá. Lần quét sau sẽ gửi lại tin "Bắt đầu theo dõi".'); };
load();
