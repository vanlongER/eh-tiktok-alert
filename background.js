importScripts('updater.js');

// ---------- icon vẽ bằng code: tròn xanh chữ EH, chấm đỏ khi có việc cần xử lý ----------
function drawIcon(size, alert) {
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#0a7d5a';
  g.beginPath(); g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff';
  g.font = 'bold ' + Math.round(size * 0.46) + 'px Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('EH', size / 2, size / 2 + size * 0.03);
  if (alert) {
    g.fillStyle = '#e53935';
    g.beginPath(); g.arc(size * 0.78, size * 0.22, size * 0.2, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#ffffff'; g.lineWidth = Math.max(1, size * 0.05); g.stroke();
  }
  return g.getImageData(0, 0, size, size);
}
function setIcon(alert) {
  try { chrome.action.setIcon({ imageData: { 16: drawIcon(16, alert), 32: drawIcon(32, alert), 48: drawIcon(48, alert) } }); } catch (e) {}
}
setIcon(false);
try { chrome.action.setBadgeBackgroundColor({ color: '#e53935' }); } catch (e) {}
// EH TikTok Báo Trả Hàng - MV3 service worker
// Quét định kỳ trang Quản lý trả hàng (chỉ ĐỌC), báo Telegram. Không bấm gì trên Seller Center.

const BASE = 'https://seller-vn.tiktok.com/order/return?order_sort_comp=OrderSort_UPADTE_TIME_DESC&shop_region=VN';
const URL_PENDING = BASE + '&sub_tab_pending=sub_tab_pending_all&tab=800';
const URL_APPEAL = BASE + '&sub_tab_appealed_disputed=sub_tab_appealed_disputed_all&tab=1000';

const URL_TICKET = 'https://seller-vn.tiktok.com/ticket?shop_region=VN';
const TICKET_DETAIL = (id) => 'https://seller-vn.tiktok.com/ticket/detail/' + id + '?shop_region=VN';
const MAX_TICKET_DETAILS = 5;

const REMIND_MS = 4 * 3600 * 1000;      // nhắc lại tin khiếu nại chưa xử lý mỗi 4 giờ
const AUTH_REMIND_MS = 6 * 3600 * 1000; // nhắc lại lỗi đăng nhập/sai shop
const URGENT_MIN = 8 * 60;              // báo "sắp hết hạn" khi còn dưới 8 giờ

// ---------- hàm chạy TRONG trang Seller Center (tự chứa, không dùng biến ngoài) ----------
async function pageScrape(wantChips) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mainText = () => { const m = document.querySelector('main'); return m ? m.innerText : ''; };

  if (/login|passport|account\/login/i.test(location.href) && !/seller-vn\.tiktok\.com\/order/.test(location.href)) {
    return { loggedOut: true };
  }
  let t = '';
  for (let i = 0; i < 50; i++) {
    t = mainText();
    if (t.includes('Quản lý trả hàng và hoàn tiền') && (t.includes('ID đơn hàng') || i > 24)) break;
    await sleep(500);
  }
  await sleep(1200);
  t = mainText();
  if (!t.includes('Quản lý trả hàng và hoàn tiền')) {
    return { loggedOut: !document.body.innerText.includes('EasyHomeVN'), notRendered: true };
  }
  const body = document.body.innerText;
  const wrongShop = !body.includes('EasyHomeVN') && body.includes('Easy Life VN');

  const num = (re) => { const m = t.match(re); return m ? parseInt(m[1], 10) : 0; };
  const parseCards = (txt) => {
    const parts = txt.split(/ID đơn hàng\s*\n?\s*:\s*\n?\s*/).slice(1);
    return parts.map((p) => ({
      id: (p.split('\n')[0] || '').trim(),
      type: (p.match(/(Trả hàng và hoàn tiền|Chỉ hoàn tiền)/) || [])[1] || '',
      reason: ((p.match(/Lý do\s*:\s*([^\n]+)/) || [])[1] || '').trim(),
      amount: (p.match(/Đã thanh toán\s*\n?\s*:\s*\n?\s*([\d.,]+₫)/) || [])[1] || '',
      left: ((p.match(/Còn lại\s*([^\n]+)/) || [])[1] || '').trim(),
      ship: ((p.match(/Trạng thái kho vận trả hàng\s*\n\s*([^\n]+)/) || [])[1] || '').trim(),
      shipTime: ((p.match(/Trạng thái kho vận trả hàng\s*\n\s*[^\n]+\n\s*([^\n]+)/) || [])[1] || '').trim(),
      status: (p.match(/Đang chờ phê duyệt|Yêu cầu hoàn tiền đã hoàn tất|Đã đóng yêu cầu|Đang chờ[^\n]*/) || [])[0] || ''
    })).filter((c) => /^\d{12,}$/.test(c.id));
  };

  const out = {
    wrongShop,
    respond24: num(/Respond within 24 hours\s*\n?\s*(\d+)/i) || num(/Phản hồi trong 24 giờ\s*\n?\s*(\d+)/i),
    disputesWaiting: num(/Disputes awaiting response\s*\n?\s*(\d+)/i),
    pendingCount: num(/Đang chờ bạn\s*\n?\s*(\d+)/),
    cards: parseCards(t)
  };

  if (wantChips) {
    out.evidenceCount = num(/Cần bằng chứng bổ sung\s*\n?\s*(\d+)/);
    out.replyCount = num(/Phản hồi mới từ dịch vụ khách hàng\s*\n?\s*(\d+)/);
    const clickChip = async (label) => {
      const els = [...document.querySelectorAll('div,span,button,li,label')]
        .filter((e) => (e.innerText || '').trim().startsWith(label) && (e.innerText || '').length < label.length + 8);
      els.sort((a, b) => a.innerText.length - b.innerText.length);
      if (!els[0]) return [];
      els[0].click();
      await sleep(2800);
      return parseCards(mainText());
    };
    out.evidenceCards = out.evidenceCount > 0 ? await clickChip('Cần bằng chứng bổ sung') : [];
    out.replyCards = out.replyCount > 0 ? await clickChip('Phản hồi mới từ dịch vụ khách hàng') : [];
  }
  return out;
}


// ---------- Nhật ký phiếu: danh sách ----------
async function pageTicketList() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mainText = () => { const m = document.querySelector('main'); return m ? m.innerText : ''; };
  let t = '';
  for (let i = 0; i < 90; i++) {
    t = mainText();
    if (t.includes('Nhật ký phiếu') && t.includes('Kiểm tra chi tiết')) break;
    if (t.includes('Nhật ký phiếu') && i > 60 && /Không có dữ liệu|No data|Chưa có/.test(t)) break;
    await sleep(500);
  }
  await sleep(800);
  t = mainText();
  if (!t.includes('Nhật ký phiếu')) return { notRendered: true };
  const chunks = t.split('Kiểm tra chi tiết');
  const rows = [];
  for (const c of chunks) {
    const id = (c.match(/ID phiếu\s*:\s*(\d+)/) || [])[1];
    if (!id) continue;
    const dates = [...c.matchAll(/(\d{2}\/\d{2}\/\d{4})\s*\n?\s*(\d{2}:\d{2}:\d{2})/g)].map((m) => m[1] + ' ' + m[2]);
    rows.push({
      id,
      order: (c.match(/ID đơn hàng\s*:\s*(\d+)/) || [])[1] || '',
      subject: ((c.match(/([^\n]+)\n\s*ID phiếu/) || [])[1] || '').trim(),
      status: (c.slice(c.indexOf('ID phiếu')).match(/Đang xử lý|Đã đóng|Chờ[^\n]*/) || [])[0] || '',
      created: dates[0] || '',
      updated: dates[1] || dates[0] || ''
    });
  }
  return { rows };
}

// ---------- Nhật ký phiếu: chi tiết + lịch sử trò chuyện ----------
async function pageTicketDetail() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mainText = () => (document.querySelector('main') || document.body).innerText.replace(/(LCP_Loading_Skeleton_?)+/g, '');
  let t = '';
  for (let i = 0; i < 90; i++) {
    t = mainText();
    if (t.includes('Lịch sử trò chuyện') && /(Nhân viên hỗ trợ|Bạn)\s*:/.test(t)) break;
    await sleep(500);
  }
  await sleep(800);
  t = mainText();
  if (!t.includes('Lịch sử trò chuyện')) return { notRendered: true };
  const a = t.indexOf('Lịch sử trò chuyện');
  let b = t.search(/Vấn đề của tôi đã được giải quyết|Gửi tin nhắn/);
  if (b < 0) b = t.length;
  const lines = t.slice(a + 'Lịch sử trò chuyện'.length, b).split('\n').map((s) => s.trim()).filter((s) => s && s !== 'Xem thêm');
  const msgs = [];
  for (const ln of lines) {
    const m = ln.match(/^(Nhân viên hỗ trợ|Bạn|Hệ thống|Khách hàng)\s*:\s*(.*)$/);
    if (m) msgs.push({ who: m[1], text: m[2] });
    else if (msgs.length) msgs[msgs.length - 1].text += ' ' + ln;
  }
  const status = (t.match(/Đang xử lý|Đã đóng|Chờ[^\n]*/) || [])[0] || '';
  return { status, msgs };
}

// ---------- tiện ích ----------
const SEP = '━━━━━━━━━━━━';
function card(title, lines, url, linkText) {
  return '<b>' + title + '</b>\n' + SEP + '\n' + lines.filter((x) => x !== undefined && x !== null && x !== false).join('\n') + (url ? '\n\n🔗 <a href="' + url + '">' + linkText + '</a>' : '');
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const leftMin = (s) => {
  if (!s) return null;
  const d = (s.match(/(\d+)\s*ngày/) || [])[1], h = (s.match(/(\d+)\s*giờ/) || [])[1], m = (s.match(/(\d+)\s*phút/) || [])[1];
  if (d == null && h == null && m == null) return null;
  return (+d || 0) * 1440 + (+h || 0) * 60 + (+m || 0);
};

async function getCfg() {
  const c = await chrome.storage.sync.get({ token: '', chatId: '', threadId: '', intervalMin: 10, heartbeat: true });
  return c;
}

async function tg(cfg, text) {
  const body = { chat_id: cfg.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (cfg.threadId) body.message_thread_id = Number(cfg.threadId);
  try {
    const r = await fetch('https://api.telegram.org/bot' + cfg.token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!j.ok) return { ok: false, err: j.description || 'Telegram lỗi' };
    return { ok: true };
  } catch (e) { return { ok: false, err: String(e) }; }
}

async function runFn(tabId, func) {
  const res = await chrome.scripting.executeScript({ target: { tabId }, func });
  return res && res[0] ? res[0].result : null;
}

async function runInTab(tabId, wantChips) {
  const res = await chrome.scripting.executeScript({ target: { tabId }, func: pageScrape, args: [wantChips] });
  return res && res[0] ? res[0].result : null;
}

function waitComplete(tabId, ms = 30000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') return resolve(tab);
      } catch (e) { return resolve(null); }
      if (Date.now() - t0 > ms) return resolve(null);
      setTimeout(tick, 500);
    };
    tick();
  });
}


// mở danh sách phiếu, rồi mở chi tiết các phiếu mới / có cập nhật (tối đa MAX_TICKET_DETAILS)
async function fetchTickets(tabId, prev) {
  await chrome.tabs.update(tabId, { url: URL_TICKET });
  await sleep(1500);
  await waitComplete(tabId);
  const list = await runFn(tabId, pageTicketList);
  if (!list || list.notRendered || !list.rows) return { err: 'không tải được Nhật ký phiếu' };
  const known = (prev && prev.tickets) || null;      // null = lần đầu
  const need = list.rows.filter((r) => {
    if (!known) return r.status === 'Đang xử lý';
    const k = known[r.id];
    return !k || k.updated !== r.updated || k.status !== r.status;
  }).slice(0, MAX_TICKET_DETAILS);
  const details = {};
  for (const r of need) {
    await chrome.tabs.update(tabId, { url: TICKET_DETAIL(r.id) });
    await sleep(1500);
    await waitComplete(tabId);
    details[r.id] = await runFn(tabId, pageTicketDetail);
  }
  return { rows: list.rows, details, firstTickets: !known };
}

// ---------- quét chính ----------
async function killOrphanTab() {
  try {
    const o = await chrome.storage.local.get({ scanTab: 0 });
    if (o.scanTab) { try { await chrome.tabs.remove(o.scanTab); } catch (e) {} await chrome.storage.local.set({ scanTab: 0 }); }
  } catch (e) {}
}
chrome.runtime.onStartup.addListener(killOrphanTab);
killOrphanTab();

async function scan(manual) {
  const cfg = await getCfg();
  if (!cfg.token || !cfg.chatId) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.storage.local.set({ lastScan: { at: Date.now(), status: 'Chưa nhập token/chat id Telegram' } });
    return { ok: false, err: 'Chưa cài Telegram' };
  }
  const L = await chrome.storage.local.get({ scanning: 0, state: null });
  if (Date.now() - L.scanning < (manual ? 60 : 180) * 1000) return { ok: false, err: 'Đang quét' };
  await killOrphanTab();
  await chrome.storage.local.set({ scanning: Date.now() });

  let tab = null, pend = null, appeal = null, tix = null;
  try {
    tab = await chrome.tabs.create({ url: URL_PENDING, active: false });
    await chrome.storage.local.set({ scanTab: tab.id });
    await waitComplete(tab.id);
    pend = await runInTab(tab.id, false);
    if (pend && !pend.loggedOut && !pend.notRendered) {
      await chrome.tabs.update(tab.id, { url: URL_APPEAL });
      await sleep(1500);
      await waitComplete(tab.id);
      appeal = await runInTab(tab.id, true);
      try { tix = await fetchTickets(tab.id, L.state); } catch (e) { tix = { err: String(e) }; }
    }
  } catch (e) {
    await chrome.storage.local.set({ lastScan: { at: Date.now(), status: 'Lỗi quét: ' + e } });
  } finally {
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch (e) {} }
    await chrome.storage.local.set({ scanning: 0, scanTab: 0 });
  }

  const now = Date.now();
  const st = L.state || { seenPending: {}, alerted: {}, first: true, lastHeartbeatDay: '' };
  const msgs = [];       // {text, mark?:[keys]}
  const curVer = chrome.runtime.getManifest().version;
  if (st.version !== curVer) {
    if (st.version) { const lu = await chrome.storage.local.get('updatedNotes'); msgs.push({ text: card('🔄 ĐÃ TỰ CẬP NHẬT EXTENSION', ['Bản mới: ' + curVer, lu.updatedNotes ? '📝 ' + esc(lu.updatedNotes) : '']) }); }
    st.version = curVer;
  }

  // lỗi đăng nhập / sai shop / không đọc được
  const authBad = !pend || pend.loggedOut || pend.notRendered || pend.wrongShop || !appeal || appeal.loggedOut;
  if (authBad) {
    const key = 'auth';
    if (!st.alerted[key] || now - st.alerted[key] > AUTH_REMIND_MS) {
      let why = 'không đọc được trang';
      if (pend && pend.wrongShop) why = 'đang đăng nhập SAI SHOP (Easy Life VN)';
      else if (!pend || pend.loggedOut || pend.notRendered) why = 'Seller Center chưa đăng nhập hoặc trang không tải được';
      msgs.push({ text: card('⚠️ KHÔNG QUÉT ĐƯỢC', ['❌ ' + why, '👉 Mở Chrome, đăng nhập shop EasyHomeVN rồi để nguyên đó.']), mark: [key] });
    }
    await chrome.storage.local.set({ state: st, lastScan: { at: now, status: 'Không quét được: ' + (pend && pend.wrongShop ? 'sai shop' : 'chưa đăng nhập/không tải được') } });
    await flush(cfg, st, msgs, now);
    return { ok: false, err: 'auth' };
  }
  delete st.alerted.auth;

  // 1) trả hàng: CHỈ báo khi ĐVVC đã giao hàng trả về shop (hoặc yêu cầu chỉ hoàn tiền, không có vận chuyển)
  const pending = pend.cards;
  const ids = new Set(pending.map((c) => c.id));
  if (st.first) {
    msgs.push({
      text: card('✅ BẮT ĐẦU THEO DÕI EASYHOMEVN', [
        '↩️ Trả hàng chờ bạn: ' + pend.pendingCount,
        '📎 Khiếu nại cần bằng chứng: ' + appeal.evidenceCount,
        '💬 TikTok phản hồi mới: ' + appeal.replyCount,
        '',
        'Trả hàng chỉ báo khi ĐVVC đã giao hàng về shop.'
      ], URL_PENDING, 'Mở trả hàng')
    });
  }
  const actionable = (c) => c.ship === 'Đã giao' || !c.ship;   // đã giao về shop, hoặc chỉ hoàn tiền
  for (const c of pending) {
    if (!actionable(c)) continue;
    const delivered = c.ship === 'Đã giao';
    const key = 'deliv:' + c.id;
    if (!st.alerted[key]) {
      msgs.push({
        text: card(delivered ? '📬 HÀNG TRẢ ĐÃ VỀ SHOP' : '💸 YÊU CẦU HOÀN TIỀN MỚI', [
          '📦 Đơn: <code>' + c.id + '</code>',
          '📝 ' + esc(c.reason || c.type),
          '💰 ' + c.amount,
          delivered && c.shipTime ? '🚚 ĐVVC giao lúc ' + esc(c.shipTime) : '',
          c.left ? '⏳ Còn ' + esc(c.left) : '',
          delivered ? '👉 Quay video mở hộp rồi phản hồi' : ''
        ], URL_PENDING, 'Mở trả hàng'),
        mark: [key]
      });
    }
  }
  for (const c of pending) {
    if (!actionable(c)) continue;
    const m = leftMin(c.left);
    const key = 'urgent:' + c.id;
    if (m != null && m <= URGENT_MIN && !st.alerted[key]) {
      msgs.push({ text: card('⏰ SẮP HẾT HẠN XỬ LÝ', ['📦 Đơn: <code>' + c.id + '</code>', '📝 ' + esc(c.reason || c.type), '💰 ' + c.amount, '⏳ Còn ' + esc(c.left)], URL_PENDING, 'Mở trả hàng'), mark: [key] });
    }
  }
  Object.keys(st.alerted).forEach((k) => { const m = k.match(/^(deliv|urgent):(\d+)$/); if (m && !ids.has(m[2])) delete st.alerted[k]; });
  st.seenPending = {};
  ids.forEach((id) => { st.seenPending[id] = st.seenPending[id] || now; });

  // 2) tin của TikTok trong khiếu nại
  const groups = [
    { cnt: appeal.evidenceCount, cards: appeal.evidenceCards || [], pre: 'ev', title: '🚨 KHIẾU NẠI: TIKTOK CẦN BẰNG CHỨNG', hint: '⚠️ Video để link công khai (Drive/YouTube/Terabox). Trả lời trong 24h, không là THUA.' },
    { cnt: appeal.replyCount, cards: appeal.replyCards || [], pre: 'rp', title: '💬 KHIẾU NẠI: TIKTOK NHẮN TIN MỚI', hint: '⚠️ Vào xem và trả lời trong 24h, không là THUA.' }
  ];
  for (const g of groups) {
    if (!g.cnt) continue;
    const keys = g.cards.length ? g.cards.map((c) => g.pre + ':' + c.id) : [g.pre + ':count' + g.cnt];
    const due = keys.filter((k) => !st.alerted[k] || now - st.alerted[k] > REMIND_MS);
    if (!due.length) continue;
    const repeat = keys.some((k) => st.alerted[k]);
    const lines = g.cards.length ? g.cards.map((c) => '📦 <code>' + c.id + '</code> · 💰 ' + c.amount) : ['📊 Số lượng: ' + g.cnt];
    msgs.push({ text: card(g.title + (repeat ? ' (nhắc lại)' : ''), lines.concat([g.hint]), URL_APPEAL, 'Mở khiếu nại'), mark: keys });
  }
  // dọn alerted của đơn không còn nằm trong nhóm nữa (để lần sau báo lại nếu TikTok nhắn tiếp)
  const live = new Set();
  groups.forEach((g) => (g.cards.length ? g.cards.map((c) => g.pre + ':' + c.id) : (g.cnt ? [g.pre + ':count' + g.cnt] : [])).forEach((k) => live.add(k)));
  Object.keys(st.alerted).forEach((k) => { if (/^(ev|rp):/.test(k) && !live.has(k)) delete st.alerted[k]; });


  // 2b) Nhật ký phiếu: phiếu mới / có cập nhật + nội dung chat
  if (tix && tix.rows) {
    st.tickets = st.tickets || {};
    for (const r of tix.rows) {
      const det = tix.details[r.id];
      const prevT = st.tickets[r.id];
      if (det && !det.notRendered) {
        const hash = r.updated + '|' + r.status + '|' + (det.msgs || []).length;
        if (!prevT || prevT.hash !== hash) {
          const last = (det.msgs || []).slice(-4);
          const icon = (w) => (w === 'Nhân viên hỗ trợ' ? '👩‍💼' : '🙋');
          const body = last.map((m) => icon(m.who) + ' ' + esc(m.text.length > 160 ? m.text.slice(0, 160) + '…' : m.text)).join('\n');
          const lastWho = last.length ? last[last.length - 1].who : '';
          const waiting = r.status === 'Đang xử lý' && lastWho === 'Nhân viên hỗ trợ';
          const title = tix.firstTickets ? '📋 PHIẾU HỖ TRỢ ĐANG MỞ' : (prevT ? '📨 PHIẾU HỖ TRỢ CÓ TIN MỚI' : '📨 PHIẾU HỖ TRỢ MỚI');
          msgs.push({
            text: card(title, [
              '🎫 Phiếu: <code>' + r.id + '</code>',
              r.order ? '📦 Đơn: <code>' + r.order + '</code>' : '',
              (r.status === 'Đã đóng' ? '⚫ ' : '🟢 ') + esc(det.status || r.status) + ' · 🕒 ' + r.updated,
              waiting ? '👉 <b>TikTok nhắn sau cùng, chờ mày trả lời</b>' : '',
              '',
              body || '(không đọc được nội dung chat)'
            ], TICKET_DETAIL(r.id), 'Mở phiếu'),
            ok: () => { st.tickets[r.id] = { updated: r.updated, status: r.status, hash }; }
          });
          continue;
        }
      }
      if (!det && (tix.firstTickets || (prevT && prevT.updated === r.updated && prevT.status === r.status))) st.tickets[r.id] = { updated: r.updated, status: r.status, hash: (prevT && prevT.hash) || '' };
    }
  } else if (tix && tix.err) {
    st.ticketErr = tix.err;
  }

  // 3) tin "còn sống" mỗi ngày (1 lần, sau 8h sáng)
  const d = new Date(now + 7 * 3600 * 1000);
  const day = d.toISOString().slice(0, 10);
  if (cfg.heartbeat && !st.first && st.lastHeartbeatDay !== day && d.getUTCHours() >= 8) {
    msgs.push({ text: card('👀 ĐANG THEO DÕI OK', ['↩️ Trả hàng chờ bạn: ' + pend.pendingCount, '📎 Khiếu nại cần bằng chứng: ' + appeal.evidenceCount, '💬 TikTok phản hồi mới: ' + appeal.replyCount]) });
    st.lastHeartbeatDay = day;
  }

  const wasFirst = st.first;
  const sent = await flush(cfg, st, msgs, now);
  if (wasFirst && sent) st.first = false;
  await chrome.storage.local.set({
    state: st,
    lastScan: { at: now, status: 'OK – chờ bạn ' + pend.pendingCount + ', cần bằng chứng ' + appeal.evidenceCount + ', phản hồi mới ' + appeal.replyCount + (tix && tix.rows ? ', phiếu ' + tix.rows.length : (tix && tix.err ? ' (lỗi phiếu: ' + tix.err + ')' : '')) + (sent === false ? ' (gửi Telegram lỗi)' : '') }
  });
  await chrome.action.setBadgeText({ text: (appeal.evidenceCount + appeal.replyCount) > 0 ? String(appeal.evidenceCount + appeal.replyCount) : '' });
  setIcon((appeal.evidenceCount + appeal.replyCount) > 0);
  return { ok: true };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// gửi lần lượt; chỉ đánh dấu đã báo khi gửi thành công. Trả về false nếu có tin gửi lỗi.
async function flush(cfg, st, msgs, now) {
  let allOk = true;
  for (const m of msgs) {
    const r = await tg(cfg, m.text);
    if (r.ok) { (m.mark || []).forEach((k) => (st.alerted[k] = now)); if (m.ok) m.ok(); }
    else { allOk = false; }
  }
  await chrome.storage.local.set({ state: st });
  return allOk;
}

// ---------- tự cập nhật ----------
async function autoUpdate() {
  const r = await checkUpdate(false);
  await chrome.storage.local.set({ lastUpdateCheck: { at: Date.now(), status: r.status } });
  if (r.needDir) {
    const L = await chrome.storage.local.get({ updAlertAt: 0 });
    if (Date.now() - L.updAlertAt > 24 * 3600 * 1000) {
      const cfg = await getCfg();
      if (cfg.token && cfg.chatId) {
        const t = await tg(cfg, card('⚠️ TỰ CẬP NHẬT CẦN QUYỀN', ['📦 ' + esc(r.status), '👉 Mở Cài đặt extension, bấm "Chọn thư mục extension".']));
        if (t.ok) await chrome.storage.local.set({ updAlertAt: Date.now() });
      }
    }
  }
}

// ---------- lịch + sự kiện ----------
async function schedule() {
  const cfg = await getCfg();
  await chrome.alarms.clear('scan');
  chrome.alarms.create('update', { delayInMinutes: 2, periodInMinutes: 60 });
  chrome.alarms.create('scan', { delayInMinutes: 1, periodInMinutes: Math.max(5, Number(cfg.intervalMin) || 10) });
}
chrome.runtime.onInstalled.addListener(() => { schedule(); });
chrome.runtime.onStartup.addListener(() => { schedule(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'scan') scan(false); else if (a.name === 'update') autoUpdate(); });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'sync' && ch.intervalMin) schedule(); });

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  (async () => {
    if (msg.type === 'scanNow') send(await scan(true));
    else if (msg.type === 'test') { const cfg = await getCfg(); send(await tg(cfg, card('✅ GỬI THỬ OK', ['Extension EH TikTok Báo Trả Hàng đã nối được Telegram.']))); }
    else if (msg.type === 'updateNow') { const r = await checkUpdate(true); await chrome.storage.local.set({ lastUpdateCheck: { at: Date.now(), status: r.status } }); send(r); }
    else if (msg.type === 'reset') { await chrome.storage.local.remove('state'); send({ ok: true }); }
    else send({ ok: false });
  })();
  return true;
});
