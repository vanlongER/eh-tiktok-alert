document.getElementById('open').onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };
chrome.storage.local.get(['lastScan', 'lastUpdateCheck'], (l) => {
  const a = l.lastScan ? new Date(l.lastScan.at).toLocaleString('vi-VN') + '\n' + l.lastScan.status : 'Chưa quét lần nào.';
  const b = l.lastUpdateCheck ? '\nCập nhật: ' + l.lastUpdateCheck.status : '';
  document.getElementById('st').textContent = 'Phiên bản ' + chrome.runtime.getManifest().version + '\n' + a + b;
});
