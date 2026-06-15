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
  const statuses = ['IN_PLAY', 'PAUSED', 'HALF_TIME'];
  const results = await Promise.allSettled(
    statuses.map(s => fdGet(`/competitions/${WC_CODE}/matches`, {
      season: WC_SEASON, status: s
    }))
  );
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value.matches || []);
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

// ─── DỰ ĐOÁN TỈ SỐ (Poisson model) ──────────────────────────────────────────
// Ý tưởng: dựa trên số bàn thắng/bại trung bình mỗi trận của từng đội tại
// WC2026 (đã đấu) so với trung bình toàn giải, suy ra "sức tấn công" và
// "sức phòng ngự" tương đối. Từ đó tính λ (số bàn kỳ vọng) cho mỗi đội rồi
// dùng phân phối Poisson để tìm tỉ số có xác suất cao nhất + % thắng/hòa/thua.

let teamStatsCache = { data: null, ts: 0 };
const STATS_TTL_MS = 30 * 60 * 1000; // cache 30 phút

// Gom thống kê (số trận, bàn ghi được, bàn thua) cho từng đội từ các trận đã
// kết thúc (FINISHED) tại WC2026.
async function getTeamStats() {
  const now = Date.now();
  if (teamStatsCache.data && now - teamStatsCache.ts < STATS_TTL_MS) return teamStatsCache.data;

  const data    = await fdGet(`/competitions/${WC_CODE}/matches`, { season: WC_SEASON, status: 'FINISHED' });
  const matches = data.matches || [];
  const stats   = {}; // teamId -> { played, scored, conceded }
  const ensure  = id => stats[id] || (stats[id] = { played: 0, scored: 0, conceded: 0 });

  for (const m of matches) {
    const hg = m.score?.fullTime?.home;
    const ag = m.score?.fullTime?.away;
    if (hg === null || hg === undefined || ag === null || ag === undefined) continue;
    const h = ensure(m.homeTeam.id);
    const a = ensure(m.awayTeam.id);
    h.played++; h.scored += hg; h.conceded += ag;
    a.played++; a.scored += ag; a.conceded += hg;
  }

  teamStatsCache = { data: stats, ts: now };
  return stats;
}

// Trung bình bàn/trận của toàn giải tính tới hiện tại (dùng làm baseline)
function leagueAvgGoals(stats) {
  let played = 0, goals = 0;
  for (const s of Object.values(stats)) { played += s.played; goals += s.scored; }
  // Nếu giải chưa có trận nào kết thúc → dùng mức trung bình World Cup lịch sử (~1.35 bàn/đội/trận)
  return played > 0 ? goals / played : 1.35;
}

function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
function poissonP(lambda, k) { return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k); }

// Dự đoán cho 1 trận: trả về tỉ số khả năng cao nhất + % thắng/hòa/thua
async function predictMatch(m) {
  const stats     = await getTeamStats();
  const leagueAvg = leagueAvgGoals(stats);

  const hs = stats[m.homeTeam?.id] || { played: 0, scored: 0, conceded: 0 };
  const as = stats[m.awayTeam?.id] || { played: 0, scored: 0, conceded: 0 };

  // Hệ số tấn công / phòng ngự so với trung bình giải (1 = trung bình)
  const hAttack  = hs.played ? (hs.scored   / hs.played) / leagueAvg : 1;
  const hDefense = hs.played ? (hs.conceded / hs.played) / leagueAvg : 1;
  const aAttack  = as.played ? (as.scored   / as.played) / leagueAvg : 1;
  const aDefense = as.played ? (as.conceded / as.played) / leagueAvg : 1;

  const HOME_ADV = 1.1; // lợi thế sân nhà ~10% (áp dụng luôn cho sân trung lập như ước lượng đơn giản)

  let lambdaHome = leagueAvg * hAttack * aDefense * HOME_ADV;
  let lambdaAway = leagueAvg * aAttack * hDefense;

  // Chặn biên tránh λ quá lớn/nhỏ khi mẫu dữ liệu còn ít
  lambdaHome = Math.min(Math.max(lambdaHome, 0.3), 4);
  lambdaAway = Math.min(Math.max(lambdaAway, 0.3), 4);

  const MAX_GOALS = 6;
  let best = { home: 0, away: 0, p: -1 };
  let pHome = 0, pDraw = 0, pAway = 0;

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = poissonP(lambdaHome, h) * poissonP(lambdaAway, a);
      if (p > best.p) best = { home: h, away: a, p };
      if (h > a) pHome += p; else if (h === a) pDraw += p; else pAway += p;
    }
  }

  return {
    score:  { home: best.home, away: best.away },
    prob:   { home: pHome, draw: pDraw, away: pAway },
    sample: { home: hs.played, away: as.played }
  };
}

// Format khối "nhận định" cho 1 trận
async function fmtPrediction(m) {
  const home = m.homeTeam?.shortName || m.homeTeam?.name || '?';
  const away = m.awayTeam?.shortName || m.awayTeam?.name || '?';
  const pred = await predictMatch(m);
  const pct  = x => (x * 100).toFixed(0);

  let note = '';
  if (pred.sample.home === 0 && pred.sample.away === 0) {
    note = '\n   <i>(Chưa có dữ liệu trận đã đấu tại WC2026, dự đoán theo mức trung bình giải)</i>';
  }

  return (
    `🔮 <b>Nhận định</b>\n` +
    `   Tỉ số dự đoán: <b>${pred.score.home} – ${pred.score.away}</b>\n` +
    `   ${flag(home)} ${home} thắng: <b>${pct(pred.prob.home)}%</b>` +
    `  |  Hòa: <b>${pct(pred.prob.draw)}%</b>` +
    `  |  ${away} thắng ${flag(away)}: <b>${pct(pred.prob.away)}%</b>` +
    note
  );
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
/dubao      – 🔮 Nhận định & dự đoán tỉ số trận sắp đấu
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

// Dự đoán tỉ số các trận sắp diễn ra (mặc định trong 48h tới, tối đa 8 trận)
bot.onText(/\/dubao(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const hours  = Math.min(Math.max(parseInt(match[1] || '48', 10) || 48, 1), 168);
  try {
    const sending = await bot.sendMessage(chatId, '🔮 Đang phân tích dữ liệu, chờ chút...');
    const list = await getUpcoming(hours);
    if (!list.length) {
      return await bot.editMessageText(`🔮 Không có trận nào trong ${hours}h tới để dự đoán.`, {
        chat_id: chatId, message_id: sending.message_id
      });
    }

    let text = `🔮 <b>Nhận định & dự đoán tỉ số</b>\n<i>(${list.length} trận trong ${hours}h tới)</i>\n`;
    for (const m of list.slice(0, 8)) {
      const home  = m.homeTeam?.shortName || m.homeTeam?.name || '?';
      const away  = m.awayTeam?.shortName || m.awayTeam?.name || '?';
      const stage = m.stage?.replace(/_/g, ' ') || m.group || '';
      const block = await fmtPrediction(m);
      text += `\n${flag(home)} <b>${home}</b> vs <b>${away}</b> ${flag(away)}` +
              `${stage ? `  <i>[${stage}]</i>` : ''}\n` +
              `🕐 ${vnTime(m.utcDate)} (giờ VN)\n` +
              `${block}\n`;
    }
    if (list.length > 8) text += `\n<i>… và ${list.length - 8} trận khác. Dùng /dubao ${hours} để lọc khoảng thời gian khác.</i>`;
    text += `\n<i>⚠ Chỉ mang tính tham khảo, dựa trên thống kê bàn thắng/thua các trận đã đấu tại WC2026.</i>`;

    await bot.editMessageText(text.trim(), {
      chat_id: chatId, message_id: sending.message_id, parse_mode: 'HTML'
    });
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
/dubao [giờ] 🔮 Nhận định & dự đoán tỉ số (mặc định 48h tới)

<b>Thông báo tự động:</b>
/subscribe   Đăng ký push notification
/unsubscribe Hủy đăng ký

<b>Thông tin kỹ thuật:</b>
• API: football-data.org (free)
• Tường thuật: cập nhật mỗi 2 phút
• Dự đoán: mô hình Poisson dựa trên thống kê bàn thắng/thua tại WC2026
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

// Job 1: Mỗi 30 phút – kiểm tra trận trong 60 phút tới → thông báo lịch + nhận định
schedule.scheduleJob('*/30 * * * *', async () => {
  if (!subscribers.schedule.length) return;
  try {
    const soon = await getUpcoming(1);
    for (const m of soon) {
      const home  = m.homeTeam?.shortName || m.homeTeam?.name || '?';
      const away  = m.awayTeam?.shortName || m.awayTeam?.name || '?';
      const stage = m.stage?.replace(/_/g,' ') || m.group || '';
      let predBlock = '';
      try { predBlock = `\n\n${await fmtPrediction(m)}`; } catch (_) {}
      broadcast('schedule',
        `⏰ <b>Trận sắp bắt đầu!</b>\n\n${flag(home)} ${home} vs ${away} ${flag(away)}\n🕐 ${vnTime(m.utcDate)} (giờ VN)${stage?`\n📌 ${stage}`:''}${predBlock}\n\n→ /live để theo dõi`
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
