# ⚽ World Cup 2026 Telegram Bot

Bot Telegram tự động gửi lịch thi đấu, tường thuật live và kết quả World Cup 2026.

## Tính năng

| Chức năng | Mô tả |
|-----------|-------|
| 📅 Lịch thi đấu | Thông báo tự động trước 1 giờ + sáng hàng ngày lúc 8h VN |
| 🔴 Tường thuật Live | Cập nhật mỗi 2 phút: kick-off, bàn thắng, hết hiệp |
| 🏁 Kết quả | Tự động gửi khi trận kết thúc |
| 🔔 Subscribe | Người dùng tự chọn loại thông báo muốn nhận |

---

## Bước 1 – Tạo Bot Telegram

1. Mở Telegram, tìm **@BotFather**
2. Gõ `/newbot` → đặt tên bot (ví dụ: `WC2026 VN Bot`)
3. Đặt username (ví dụ: `wc2026vn_bot`)
4. Copy **Bot Token** (dạng `1234567890:ABCdef...`)

---

## Bước 2 – Cài đặt local (test trước)

```bash
git clone <your-repo>
cd wc2026-bot
npm install
cp .env.example .env
# Mở .env, paste BOT_TOKEN vào
npm start
```

---

## Bước 3 – Deploy miễn phí

### Option A: Railway.app ⭐ (Khuyến nghị)

1. Vào https://railway.app → Sign up bằng GitHub
2. **New Project** → **Deploy from GitHub repo**
3. Push code lên GitHub trước:
   ```bash
   git init && git add . && git commit -m "init"
   git remote add origin https://github.com/YOUR_USER/wc2026-bot.git
   git push -u origin main
   ```
4. Trong Railway: chọn repo → **Add Variables** → thêm `BOT_TOKEN=your_token`
5. Railway tự build và deploy, bot chạy 24/7

**Giới hạn miễn phí:** $5 credit/tháng (~500 giờ chạy) ✅

---

### Option B: Render.com

1. Vào https://render.com → New → **Web Service**
2. Connect GitHub repo
3. **Build Command:** `npm install`
4. **Start Command:** `node bot.js`
5. Environment Variables: thêm `BOT_TOKEN`
6. Plan: **Free** → Deploy

> ⚠️ Render free tier sleep sau 15 phút không có request. Dùng UptimeRobot ping `https://your-app.onrender.com` mỗi 10 phút để giữ alive.

---

### Option C: Fly.io

```bash
# Cài flyctl: https://fly.io/docs/hands-on/install-flyctl/
fly auth login
fly launch            # chọn region Singapore (sin) gần VN nhất
fly secrets set BOT_TOKEN=your_token_here
fly deploy
```

**Miễn phí:** 3 shared-CPU VMs/tháng ✅

---

### Option D: VPS Oracle Cloud Free Tier

Oracle cung cấp VPS miễn phí vĩnh viễn (2 VM AMD):

```bash
# SSH vào VPS, cài Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

git clone <your-repo> && cd wc2026-bot
npm install
echo "BOT_TOKEN=your_token" > .env

# Chạy nền với PM2
npm install -g pm2
pm2 start bot.js --name wc2026-bot
pm2 save && pm2 startup
```

---

## Cấu trúc file

```
wc2026-bot/
├── bot.js           # Code chính
├── package.json
├── Dockerfile       # Cho Railway/Fly.io
├── .env.example
├── .gitignore
└── subscribers.json # Tự tạo khi chạy (lưu danh sách sub)
```

---

## API dữ liệu

Sử dụng **worldcup26.ir** – miễn phí, không cần API key:

| Endpoint | Mô tả |
|----------|-------|
| `GET /get/games` | Tất cả trận đấu + kết quả |
| `GET /get/groups` | Bảng xếp hạng |

---

## Lịch job tự động

| Job | Tần suất | Chức năng |
|-----|----------|-----------|
| Schedule alert | 30 phút | Thông báo trận sắp đấu trong 1h |
| Morning digest | 8h sáng (VN) | Lịch thi đấu hôm nay |
| Live tracker | 2 phút | Theo dõi bàn thắng, kick-off |
| Result notifier | 5 phút | Gửi kết quả trận vừa kết thúc |
