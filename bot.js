/**
 * ⚽ World Cup 2026 Telegram Bot
 * 
 * Nguồn dữ liệu: football-data.org (miễn phí, WC bao gồm)
 *   → Đăng ký free tại: https://www.football-data.org/client/register
 *   → Sau khi đăng ký nhận API key qua email (~1 phút)
 * 
 * Chức năng:
 *   1. Lịch thi đấu hôm nay / sắp tới
 *   2. Tường thuật live (cập nhật 2 phút/lần)
 *   3. Kết quả sau trận
 *   4. Bảng xếp hạng các bảng
 *   5. Subscribe / Unsubscribe thông báo tự động
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const schedule    = require('node-schedule');
const fs          = require('fs');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN  = process.env.BOT_TOKEN;
const FD_API_KEY = process.env.FD_API_KEY; // football-data.org key

if (!BOT_TOKEN)  { console.error('❌ Thiếu BOT_TOKEN trong .env'); process.exit(1); }
if (!FD_API_KEY) { console.error('❌ Thiếu FD_API_KEY trong .env'); process.exit(1); }

// football-data.org: World Cup 2026 = competition WC, season 2026
const FD_BASE    = 'https://api.football-data.org/v4';
const WC_CODE    = 'WC';
const WC_SEASON  = 2026;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── STATE ────────────────────────────────────────────────────────────────────
const STATE_FILE = './subscribers.json';
let subscribers  = loadState();

// key: matchId → { homeScore, awayScore, status, halfNotified }
const liveCache  = {};
// Set của matchId đã gửi kết quả (tránh trùng)
const sentResults = new Set();

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE));
  } catch (_) {}
  return { schedule: [], live: [], result: [] };
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(subscribers, null, 2));
}

function sub(type, chatId) {
  chatId = String(chatId);
  if (!subscribers[type].includes(chatId)) { subscribers[type].push(chatId); saveState(); return true; }
  return false;
}

function unsub(type, chatId) {
  chatId = String(chatId);
  const i = subscribers[type].indexOf(chatId);
  if (i !== -1) { subscribers[type].splice(i, 1); saveState(); return true; }
  return false;
}

function broadcast(type, text) {
  for (const id of subscribers[type]) {
    bot.sendMessage(id, text, { parse_mode: 'HTML' }).catch(() => {});
  }
}

// UTC → giờ VN (UTC+7)
function vnTime(utcStr) {
  if (!utcStr) return '--:--';
  const d = new Date(utcStr);
  const vn = new Date(d.getTime() + 7 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(vn.getUTCDate())}/${pad(vn.getUTCMonth()+1)} ${pad(vn.getUTCHours())}:${pad(vn.getUTCMinutes())}`;
}

function flag(teamName) {
  // Một số đội hay gặp - thêm flag emoji thân thiện
  const flags = {
    'Brazil':'🇧🇷','Argentina':'🇦🇷','France':'🇫🇷','Germany':'🇩🇪','Spain':'🇪🇸',
    'England':'󠁧󠁢󠁥󠁮󠁧󠁿','Portugal':'🇵🇹','Netherlands':'🇳🇱','Belgium':'🇧🇪',
    'Italy':'🇮🇹','Mexico':'🇲🇽','USA':'🇺🇸','Japan':'🇯🇵','South Korea':'🇰🇷',
    'Morocco':'🇲🇦','Senegal':'🇸🇳','Australia':'🇦🇺','Canada':'🇨🇦',
    'Croatia':'🇭🇷','Uruguay':'🇺🇾','Colombia':'🇨🇴','Ecuador':'🇪🇨',
  };
  return flags[teamName] || '🏳';
}

// ─── API ──────────────────────────────────────────────────────────────────────
const fdClient = axios.create({
  baseURL: FD_BASE,
  headers: { 'X-Auth-Token': FD_API_KEY },
  timeout: 10000
});

async function fdGet(path, params = {}) {
  const r = await fdClient.get(path, { params });
  return r.data;
}

// Lấy tất cả trận WC 2026
async function getAllMatches() {
  const data = await fdGet(`/competitions/${WC_CODE}/matches`, { season: WC_SEASON });
  return data.matches || [];
}

// Trận hôm nay (theo giờ UTC)
async function getTodayMatches() {
  const today = new Date().toISOString().slice(0, 10);
  const data  = await fdGet(`/competitions/${WC_CODE}/matches`, {
    season: WC_SEASON, dateFrom: today, dateTo: today
  });
  return data.matches || [];
}

// Trận đang live
async function getLiveMatches() {
  const data = await fdGet(`/competitions/${WC_CODE}/matches`, {
    season: WC_SEASON, status: 'IN_PLAY,PAUSED,HALF_TIME'
  });
  return data.matches || [];
}

// Trận sắp diễn ra (giờ tới)
async function getUpcoming(hours = 24) {
  const now = new Date();
  const end = new Date(now.getTime() + hours * 3600 * 1000);
  const data = await fdGet(`/competitions/${WC_CODE}/matches`, {
    season: WC_SEASON,
    dateFrom: now.toISOString().slice(0, 10),
    dateTo:   end.toISOString().slice(0, 10),
    status:   'SCHEDULED,TIMED'
  });
  const matches = (data.matches || []).filter(m => {
    const t = new Date(m.utcDate).getTime();
    return t >= now.getTime() && t <= end.getTime();
  });
  return matches.sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
}

// Standings
async function getStandings() {
  const data = await fdGet(`/competitions/${WC_CODE}/standings`, { season: WC_SEASON });
  return data.standings || [];
}

// ─── FORMAT ───────────────────────────────────────────────────────────────────
function fmtMatch(m) {
  const home  = m.homeTeam?.shortName || m.homeTeam?.name || '?';
  const away  = m.awayTeam?.shortName || m.awayTeam?.name || '?';
  const hg    = m.score?.fullTime?.home;
  const ag    = m.score?.fullTime?.away;
  const stage = m.stage?.replace(/_/g, ' ') || m.group || '';
  const time  = vnTime(m.utcDate);
  const hasScore = hg !== null && hg !== undefined;
  const score = hasScore ? `<b>${hg} – ${ag}</b>` : `<i>${time}</i>`;
  return `${flag(home)} ${home}  ${score}  ${away} ${flag(away)}${stage ? `  <i>[${stage}]</i>` : ''}`;
}

function fmtLive(m) {
  const home   = m.homeTeam?.shortName || m.homeTeam?.name || '?';
  const away   = m.awayTeam?.shortName || m.awayTeam?.name || '?';
  const hg     = m.score?.fullTime?.home ?? m.score?.halfTime?.home ?? 0;
  const ag     = m.score?.fullTime?.away ?? m.score?.halfTime?.away ?? 0;
  const min    = m.minute || '?';
  const status = m.status || 'LIVE';
  const label  = status === 'HALF_TIME' ? '⏸ HT' : status === 'PAUSED' ? '⏸ PAUSED' : `⏱ ${min}'`;
  return `🔴 <b>LIVE</b>  ${flag(home)} ${home} <b>${hg}–${ag}</b> ${away} ${flag(away)}  ${label}`;
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, `
⚽ <b>World Cup 2026 Bot</b>  🏆

Chào mừng! Tôi cung cấp dữ liệu live từ FIFA World Cup 2026.

<b>📋 Lệnh:</b>
/today      – Lịch thi đấu hôm nay (giờ VN)
/upcoming   – Trận đấu trong 24h tới
/live       – Trận đang diễn ra 🔴
/results    – Kết quả gần nhất
/standings  – Bảng xếp hạng
/subscribe  – 🔔 Đăng ký thông báo tự động
/unsubscribe– 🔕 Hủy thông báo
/help       – Trợ giúp

<i>Giải đấu: 11/6/2026 – 19/7/2026 | USA · Canada · Mexico</i>
  `.trim(), { parse_mode: 'HTML' });
});

bot.onText(/\/today/, async msg => {
  const chatId = msg.chat.id;
  try {
    const list = await getTodayMatches();
    if (!list.length) return bot.sendMessage(chatId, '📅 Hôm nay không có trận đấu.', { parse_mode: 'HTML' });
    const text = `📅 <b>Lịch thi đấu hôm nay</b>\n\n` + list.map(fmtMatch).join('\n');
    bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Lỗi: ${e.message}`);
  }
});

bot.onText(/\/upcoming/, async msg => {
  const chatId = msg.chat.id;
  try {
    const list = await getUpcoming(24);
    if (!list.length) return bot.sendMessage(chatId, '⏰ Không có trận trong 24h tới.', { parse_mode: 'HTML' });
    const text = `⏰ <b>Trận đấu trong 24h tới</b>\n\n` + list.map(fmtMatch).join('\n');
    bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Lỗi: ${e.message}`);
  }
});

bot.onText(/\/live/, async msg => {
  const chatId = msg.chat.id;
  try {
    const list = await getLiveMatches();
    if (!list.length) return bot.sendMessage(chatId,
      '⚽ Không có trận đang diễn ra.\n\n→ /upcoming để xem lịch sắp tới', { parse_mode: 'HTML' });
    const text = `🔴 <b>Đang diễn ra – Live</b>\n\n` + list.map(fmtLive).join('\n\n');
    bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Lỗi: ${e.message}`);
  }
});

bot.onText(/\/results/, async msg => {
  const chatId = msg.chat.id;
  try {
    const data = await fdGet(`/competitions/${WC_CODE}/matches`, {
      season: WC_SEASON, status: 'FINISHED'
    });
    const list = (data.matches || []).slice(-10).reverse();
    if (!list.length) return bot.sendMessage(chatId, '📊 Chưa có kết quả.', { parse_mode: 'HTML' });
    const text = `🏁 <b>Kết quả gần nhất</b>\n\n` + list.map(fmtMatch).join('\n');
    bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Lỗi: ${e.message}`);
  }
});

bot.onText(/\/standings/, async msg => {
  const chatId = msg.chat.id;
  try {
    const standings = await getStandings();
    if (!standings.length) return bot.sendMessage(chatId, '📊 Chưa có dữ liệu.');

    let text = `🏆 <b>Bảng xếp hạng WC 2026</b>\n`;
    for (const sg of standings.slice(0, 6)) {
      const label = sg.group || sg.stage || '';
      text += `\n<b>── Bảng ${label} ──</b>\n`;
      for (const row of (sg.table || []).slice(0, 4)) {
        const t   = row.team?.shortName || row.team?.name || '?';
        const pts = row.points ?? 0;
        const pl  = row.playedGames ?? 0;
        const gd  = row.goalDifference ?? 0;
        text += `  ${row.position}. ${t}  ${pl}tr  <b>${pts}pts</b>  GD:${gd}\n`;
      }
    }
    bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Lỗi: ${e.message}`);
  }
});

bot.onText(/\/subscribe/, msg => {
  bot.sendMessage(msg.chat.id, '🔔 <b>Chọn loại thông báo muốn nhận:</b>', {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [{ text: '📅 Lịch thi đấu (trước 1h)', callback_data: 'sub_schedule' }],
      [{ text: '🔴 Tường thuật Live (bàn thắng, kick-off)', callback_data: 'sub_live' }],
      [{ text: '🏁 Kết quả sau mỗi trận', callback_data: 'sub_result' }],
      [{ text: '✅ Đăng ký TẤT CẢ', callback_data: 'sub_all' }],
    ]}
  });
});

bot.onText(/\/unsubscribe/, msg => {
  bot.sendMessage(msg.chat.id, '🔕 <b>Hủy đăng ký:</b>', {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [{ text: '📅 Hủy lịch',     callback_data: 'unsub_schedule' }],
      [{ text: '🔴 Hủy live',     callback_data: 'unsub_live'     }],
      [{ text: '🏁 Hủy kết quả', callback_data: 'unsub_result'   }],
      [{ text: '❌ Hủy TẤT CẢ',  callback_data: 'unsub_all'      }],
    ]}
  });
});

bot.onText(/\/help/, msg => {
  bot.sendMessage(msg.chat.id, `
<b>⚽ Trợ giúp World Cup 2026 Bot</b>

<b>Tra cứu:</b>
/today       Lịch hôm nay (giờ VN)
/upcoming    Trận trong 24h tới
/live        Đang diễn ra (real-time)
/results     10 kết quả gần nhất
/standings   Bảng xếp hạng

<b>Thông báo tự động:</b>
/subscribe   Đăng ký push notification
/unsubscribe Hủy đăng ký

<b>Thông tin kỹ thuật:</b>
• API: football-data.org (free)
• Tường thuật: cập nhật mỗi 2 phút
• Múi giờ: UTC+7 (Việt Nam)
• Giải: 11/6 – 19/7/2026
  `.trim(), { parse_mode: 'HTML' });
});

// ─── INLINE KEYBOARD CALLBACKS ────────────────────────────────────────────────
bot.on('callback_query', q => {
  const chatId = String(q.message.chat.id);
  const msgId  = q.message.message_id;
  const d      = q.data;
  bot.answerCallbackQuery(q.id);

  const responses = {
    'sub_all':       [['schedule','live','result'], '✅ Đã đăng ký <b>tất cả</b> thông báo!'],
    'sub_schedule':  [['schedule'], '✅ Đã đăng ký <b>lịch thi đấu</b> (thông báo trước 1h).'],
    'sub_live':      [['live'],     '✅ Đã đăng ký <b>tường thuật live</b> (kick-off, bàn thắng, hết hiệp).'],
    'sub_result':    [['result'],   '✅ Đã đăng ký <b>kết quả</b> sau mỗi trận.'],
    'unsub_all':     [['schedule','live','result'], '🔕 Đã hủy <b>tất cả</b> thông báo.', true],
    'unsub_schedule':[['schedule'], '🔕 Đã hủy thông báo <b>lịch</b>.', true],
    'unsub_live':    [['live'],     '🔕 Đã hủy <b>tường thuật live</b>.', true],
    'unsub_result':  [['result'],   '🔕 Đã hủy thông báo <b>kết quả</b>.', true],
  };

  const [types, text, isUnsub] = responses[d] || [[], 'Không rõ lệnh.'];
  types.forEach(t => isUnsub ? unsub(t, chatId) : sub(t, chatId));
  bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }).catch(() => {});
});

// ─── SCHEDULED JOBS ───────────────────────────────────────────────────────────

// Job 1: Mỗi 30 phút – kiểm tra trận trong 60 phút tới → thông báo lịch
schedule.scheduleJob('*/30 * * * *', async () => {
  if (!subscribers.schedule.length) return;
  try {
    const soon = await getUpcoming(1);
    for (const m of soon) {
      const home  = m.homeTeam?.shortName || m.homeTeam?.name || '?';
      const away  = m.awayTeam?.shortName || m.awayTeam?.name || '?';
      const stage = m.stage?.replace(/_/g,' ') || m.group || '';
      broadcast('schedule',
        `⏰ <b>Trận sắp bắt đầu!</b>\n\n${flag(home)} ${home} vs ${away} ${flag(away)}\n🕐 ${vnTime(m.utcDate)} (giờ VN)${stage?`\n📌 ${stage}`:''}\n\n→ /live để theo dõi`
      );
    }
  } catch (_) {}
});

// Job 2: Sáng 8h VN (1h UTC) – gửi lịch hôm nay
schedule.scheduleJob('0 1 * * *', async () => {
  if (!subscribers.schedule.length) return;
  try {
    const list = await getTodayMatches();
    if (!list.length) return;
    broadcast('schedule',
      `☀️ <b>Lịch thi đấu hôm nay</b>\n\n${list.map(fmtMatch).join('\n')}\n\n⏰ Giờ Việt Nam (UTC+7)`
    );
  } catch (_) {}
});

// Job 3: Mỗi 2 phút – theo dõi trận live → gửi bàn thắng, kick-off, hết hiệp
schedule.scheduleJob('*/2 * * * *', async () => {
  if (!subscribers.live.length) return;
  try {
    const lives = await getLiveMatches();
    for (const m of lives) {
      const id   = String(m.id);
      const home = m.homeTeam?.shortName || m.homeTeam?.name || '?';
      const away = m.awayTeam?.shortName || m.awayTeam?.name || '?';
      const hg   = m.score?.fullTime?.home ?? 0;
      const ag   = m.score?.fullTime?.away ?? 0;
      const st   = m.status;
      const key  = `${hg}-${ag}`;

      const prev = liveCache[id] || { key: null, kickoffSent: false, htSent: false };

      // Kick-off
      if (!prev.kickoffSent) {
        broadcast('live', `🟢 <b>KICK OFF!</b>\n\n${flag(home)} ${home} vs ${away} ${flag(away)} bắt đầu!`);
        prev.kickoffSent = true;
      }

      // Bàn thắng
      if (prev.key !== null && prev.key !== key) {
        let scorer = '';
        if (hg > ag)        scorer = `⚽ ${home} ghi bàn!`;
        else if (ag > hg)   scorer = `⚽ ${away} ghi bàn!`;
        else                scorer = `⚽ Bàn thắng!`;
        broadcast('live',
          `🚨 <b>BÀN THẮNG!</b>\n\n${flag(home)} ${home} <b>${hg} – ${ag}</b> ${away} ${flag(away)}\n${scorer}`
        );
      }

      // Hết hiệp 1
      if (!prev.htSent && (st === 'HALF_TIME' || st === 'PAUSED')) {
        broadcast('live',
          `⏸ <b>HẾT HIỆP 1</b>\n\n${flag(home)} ${home} <b>${hg} – ${ag}</b> ${away} ${flag(away)}\n\nHiệp 2 sắp bắt đầu.`
        );
        prev.htSent = true;
      }

      liveCache[id] = { key, kickoffSent: prev.kickoffSent, htSent: prev.htSent };
    }
  } catch (_) {}
});

// Job 4: Mỗi 5 phút – phát hiện trận vừa kết thúc → gửi kết quả
schedule.scheduleJob('*/5 * * * *', async () => {
  if (!subscribers.result.length) return;
  try {
    const data = await fdGet(`/competitions/${WC_CODE}/matches`, {
      season: WC_SEASON, status: 'FINISHED'
    });
    const cutoff = Date.now() - 3 * 3600 * 1000;
    const recent = (data.matches || []).filter(m => {
      const t  = new Date(m.utcDate).getTime();
      const id = String(m.id);
      return t >= cutoff && !sentResults.has(id);
    });

    for (const m of recent) {
      const id   = String(m.id);
      const home = m.homeTeam?.shortName || m.homeTeam?.name || '?';
      const away = m.awayTeam?.shortName || m.awayTeam?.name || '?';
      const hg   = m.score?.fullTime?.home ?? '?';
      const ag   = m.score?.fullTime?.away ?? '?';
      const stage = m.stage?.replace(/_/g,' ') || m.group || '';

      let winner = '🤝 Hòa';
      if (hg > ag)      winner = `🏆 ${home} thắng!`;
      else if (ag > hg) winner = `🏆 ${away} thắng!`;

      broadcast('result',
        `🏁 <b>KẾT QUẢ</b>${stage?` – ${stage}`:''}\n\n${flag(home)} ${home} <b>${hg} – ${ag}</b> ${away} ${flag(away)}\n\n${winner}`
      );
      sentResults.add(id);
      delete liveCache[id];
    }
  } catch (_) {}
});

// ─── BOOT ─────────────────────────────────────────────────────────────────────
console.log('⚽ World Cup 2026 Bot đang khởi động...');
console.log('📡 API: football-data.org (free tier)');
console.log('👥 Subscribers:', JSON.stringify({
  schedule: subscribers.schedule.length,
  live: subscribers.live.length,
  result: subscribers.result.length
}));

bot.on('polling_error', e => console.error('[polling_error]', e.message));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e?.message || e));

console.log('✅ Bot đang chạy! Mở Telegram và thử /start');
