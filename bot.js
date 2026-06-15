/**
 * ⚽ World Cup 2026 Telegram Bot
 * 
 * Nguồn dữ liệu:
 *   - football-data.org (free tier) – lịch, kết quả, bảng xếp hạng, live (delayed)
 *     → Đăng ký free tại: https://www.football-data.org/client/register
 *     → Sau khi đăng ký nhận API key qua email (~1 phút)
 *   - worldcup26.ir (free, không cần key) – nguồn live phụ để giảm độ trễ tỉ số
 * 
 * Chức năng:
 *   1. Lịch thi đấu hôm nay / sắp tới
 *   2. Tường thuật live (poll ~30s/lần, có vá độ trễ từ worldcup26.ir)
 *   3. Kết quả sau trận
 *   4. Bảng xếp hạng các bảng
 *   5. Đội hình ra sân 2 đội (/doihinh)
 *   6. Subscribe / Unsubscribe thông báo tự động
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

// Tần suất poll trận live (cron 6-field: giây phút giờ ngày tháng thứ).
// football-data.org free tier giới hạn 10 req/phút; với getLiveMatches() đã
// gộp về 1 call/lần (xem dưới), 30s/lần ≈ 2 call/phút → vẫn an toàn.
const LIVE_POLL_CRON = process.env.LIVE_POLL_CRON || '*/30 * * * * *';

// Nguồn live phụ worldcup26.ir (free, không cần key cho route /get/*) để bù
// độ trễ tỉ số của football-data.org free tier. Set WC26_LIVE=false để tắt.
const WC26_ENABLED = process.env.WC26_LIVE !== 'false';

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
// FIX: 'HALF_TIME' KHÔNG phải là giá trị status hợp lệ trong football-data.org
// API v4 (enum chỉ gồm SCHEDULED, IN_PLAY, PAUSED, FINISHED, SUSPENDED,
// POSTPONED, CANCELLED, AWARDED) → gửi 'IN_PLAY,PAUSED,HALF_TIME' khiến API
// trả 400 Bad Request, làm /live luôn báo lỗi. v4 đã hỗ trợ sẵn pseudo-status
// 'LIVE' mà backend tự hiểu là IN_PLAY + PAUSED (đã bao gồm cả half-time, vì
// half-time ở v4 được biểu diễn bằng status PAUSED) → dùng trực tiếp giá trị
// này, gọn và đúng chuẩn hơn.
async function getLiveMatches() {
  const data = await fdGet(`/competitions/${WC_CODE}/matches`, {
    season: WC_SEASON, status: 'LIVE'
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

// Chi tiết 1 trận (bao gồm lineup/bench/formation/coach nếu nguồn dữ liệu hỗ trợ)
async function getMatchDetail(id) {
  return await fdGet(`/matches/${id}`);
}

// ─── NGUỒN LIVE PHỤ: worldcup26.ir ─────────────────────────────────────────
// API mã nguồn mở cho WC2026 (https://github.com/rezarahiminia/worldcup2026),
// route /get/games không cần API key, claim cập nhật tỉ số real-time trong
// giải. Dùng để "vá" độ trễ tỉ số của football-data.org free tier (tài liệu
// chính chủ ghi rõ free tier "scores are delayed").
//
// ⚠ EXPERIMENTAL: chưa kiểm thử được trực tiếp trong môi trường này. Nếu
// trong lúc có trận live mà thấy /live không khớp tỉ số thực tế, kiểm tra
// `curl https://worldcup26.ir/get/games` để xem field thực tế trả về và
// chỉnh lại WC26_NAME_ALIASES / nameMatches() cho phù hợp. Toàn bộ phần này
// được bọc try/catch — lỗi ở đây KHÔNG làm hỏng luồng football-data.org.
const WC26_BASE   = 'https://worldcup26.ir';
const wc26Client  = axios.create({ baseURL: WC26_BASE, timeout: 8000 });

// Bỏ dấu, hạ chữ thường, bỏ ký tự đặc biệt → để so khớp tên đội giữa 2 nguồn
function normName(s) {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Alias cho các đội có tên khác nhau giữa football-data.org và worldcup26.ir
// (key/value ở dạng đã normName(); chỉnh thêm nếu phát hiện cặp nào không khớp)
const WC26_NAME_ALIASES = {
  'korearepublic':        'southkorea',   // FD: "Korea Republic"
  'cotedivoire':          'ivorycoast',   // FD: "Côte d'Ivoire"
  'iriran':               'iran',         // FD: "IR Iran"
  'drcongo':              'congodr',      // FD: "DR Congo"
  'congodemocraticrepublic': 'congodr',
  'cabaoverde':           'capeverde',
  'capverde':             'capeverde',    // FD: "Cabo Verde" → normName = "caboverde", thêm phòng hờ
  'caboverde':            'capeverde',
  'unitedstates':         'usa',
  'unitedstatesofamerica':'usa',
};

function nameMatches(fdName, wc26Name) {
  const a = normName(fdName), b = normName(wc26Name);
  if (!a || !b) return false;
  if (a === b) return true;
  if (WC26_NAME_ALIASES[a] === b || WC26_NAME_ALIASES[b] === a) return true;
  // fallback: một tên chứa tên còn lại (đủ dài để tránh khớp nhầm)
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  return false;
}

// Lấy toàn bộ games từ worldcup26.ir (không cache để giữ tính realtime)
async function getWc26Games() {
  const { data } = await wc26Client.get('/get/games');
  return data?.games || data?.data?.games || [];
}

// Với mỗi trận live từ football-data, thử tìm trận tương ứng trên worldcup26.ir
// và "vá" lại tỉ số / số phút nếu tìm được + chưa kết thúc.
async function enrichWithWc26(fdMatches) {
  if (!WC26_ENABLED || !fdMatches.length) return fdMatches;
  try {
    const games = await getWc26Games();
    if (!games.length) return fdMatches;

    return fdMatches.map(m => {
      const home = m.homeTeam?.shortName || m.homeTeam?.name;
      const away = m.awayTeam?.shortName || m.awayTeam?.name;
      const g = games.find(g =>
        String(g.finished).toUpperCase() !== 'TRUE' &&
        nameMatches(home, g.home_team_name_en) &&
        nameMatches(away, g.away_team_name_en)
      );
      if (!g) return m;

      const hg = Number(g.home_score), ag = Number(g.away_score);
      if (Number.isNaN(hg) || Number.isNaN(ag)) return m;

      const clone = { ...m, score: { ...m.score, fullTime: { home: hg, away: ag } } };
      // time_elapsed dạng số phút (ví dụ "37" hoặc "45+2") → dùng làm số phút hiển thị
      if (typeof g.time_elapsed === 'string' && /^\d+(\+\d+)?$/.test(g.time_elapsed)) {
        clone.minute = g.time_elapsed;
      }
      return clone;
    });
  } catch (_) {
    return fdMatches; // worldcup26.ir lỗi/đổi schema → giữ nguyên dữ liệu football-data
  }
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
  // v4 không có status 'HALF_TIME' riêng — hết hiệp 1 cũng trả về 'PAUSED'.
  const label  = status === 'PAUSED' ? '⏸ Hết hiệp/Tạm dừng' : `⏱ ${min}'`;
  return `🔴 <b>LIVE</b>  ${flag(home)} ${home} <b>${hg}–${ag}</b> ${away} ${flag(away)}  ${label}`;
}

// ─── ĐỘI HÌNH RA SÂN (Lineup) ───────────────────────────────────────────────
// Dữ liệu lineup lấy từ football-data.org /v4/matches/{id} (field
// homeTeam.lineup / awayTeam.lineup / bench / formation / coach).
// ⚠ LƯU Ý: theo tài liệu football-data.org, dữ liệu cầu thủ (lineup/bench/
// squad) thuộc gói "deep data" trả phí — ở free tier các field này có thể
// trống. Ngoài ra lineup thật của 1 trận thường chỉ được công bố ~60 phút
// trước giờ bóng lăn. Nếu trống, bot sẽ báo rõ lý do thay vì im lặng.
function fmtLineupSide(team, label) {
  const lineup = team?.lineup || [];
  let s = `\n${label}`;
  if (team?.formation) s += `  <i>(Sơ đồ ${team.formation})</i>`;
  s += '\n';
  if (team?.coach?.name) s += `HLV: ${team.coach.name}\n`;

  if (!lineup.length) {
    s += `<i>Chưa có thông tin đội hình ra sân.</i>\n`;
    return s;
  }

  s += lineup
    .map(p => `${p.shirtNumber ? `${p.shirtNumber}. ` : ''}${p.name}${p.position ? ` (${p.position})` : ''}`)
    .join('\n') + '\n';

  const bench = team?.bench || [];
  if (bench.length) {
    s += `<i>Dự bị:</i> ${bench.map(p => p.name).join(', ')}\n`;
  }
  return s;
}

function fmtLineup(m) {
  const home  = m.homeTeam || {};
  const away  = m.awayTeam || {};
  const hName = home.shortName || home.name || '?';
  const aName = away.shortName || away.name || '?';
  const stage = m.stage?.replace(/_/g, ' ') || m.group || '';

  let text = `📋 <b>Đội hình ra sân</b>\n`;
  text += `${flag(hName)} <b>${hName}</b> vs <b>${aName}</b> ${flag(aName)}`;
  text += `${stage ? `  <i>[${stage}]</i>` : ''}\n`;
  text += `🕐 ${vnTime(m.utcDate)} (giờ VN)\n`;

  text += fmtLineupSide(home, `${flag(hName)} <b>${hName}</b>`);
  text += fmtLineupSide(away, `${flag(aName)} <b>${aName}</b>`);

  if (!(home.lineup?.length) && !(away.lineup?.length)) {
    text += `\n<i>⚠ Đội hình thường được công bố ~60 phút trước giờ bóng lăn, và dữ liệu cầu thủ chi tiết có thể không nằm trong gói miễn phí của football-data.org. Hãy thử lại gần giờ thi đấu hoặc khi trận đã bắt đầu.</i>`;
  }
  return text;
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
/doihinh    – 📋 Đội hình ra sân 2 đội
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

// Đội hình ra sân: ưu tiên trận đang live; nếu không có trận live thì lấy
// trong danh sách trận sắp diễn ra (72h tới). /doihinh <số> để chọn trận thứ N.
bot.onText(/\/doihinh(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const idx = Math.max(parseInt(match[1] || '1', 10) || 1, 1);
  try {
    let list  = await getLiveMatches();
    let label = '🔴 <i>Trận đang diễn ra</i>';
    if (!list.length) {
      list  = await getUpcoming(72);
      label = '⏰ <i>Trận sắp diễn ra (trong 72h)</i>';
    }
    if (!list.length) {
      return bot.sendMessage(chatId, '⚽ Không có trận live hoặc sắp diễn ra để xem đội hình.', { parse_mode: 'HTML' });
    }

    const target = list[Math.min(idx, list.length) - 1];
    const detail = await getMatchDetail(target.id);

    let text = `${label}\n` + fmtLineup(detail);
    if (list.length > 1) {
      text += `\n\n<i>Có ${list.length} trận phù hợp — dùng /doihinh &lt;số&gt; (1-${list.length}) để xem trận khác.</i>`;
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
/doihinh [số] 📋 Đội hình ra sân (trận live, hoặc sắp tới nếu không có live)

<b>Thông báo tự động:</b>
/subscribe   Đăng ký push notification
/unsubscribe Hủy đăng ký

<b>Thông tin kỹ thuật:</b>
• API: football-data.org (free) + worldcup26.ir (live phụ)
• Tường thuật: poll mỗi 30 giây
• Đội hình: phụ thuộc dữ liệu nguồn, có thể trống nếu chưa công bố
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
        `⏰ <b>Trận sắp bắt đầu!</b>\n\n${flag(home)} ${home} vs ${away} ${flag(away)}\n🕐 ${vnTime(m.utcDate)} (giờ VN)${stage?`\n📌 ${stage}`:''}\n\n→ /live để theo dõi · /doihinh để xem đội hình`
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

// Job 3: Poll trận live (mặc định mỗi 30s, xem LIVE_POLL_CRON) → gửi bàn
// thắng, kick-off, hết hiệp. Tỉ số/số phút được "vá" bằng worldcup26.ir
// (xem enrichWithWc26) để giảm độ trễ so với football-data.org free tier.
schedule.scheduleJob(LIVE_POLL_CRON, async () => {
  if (!subscribers.live.length) return;
  try {
    let lives = await getLiveMatches();
    lives = await enrichWithWc26(lives);
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
