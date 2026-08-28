# Nobita Media Bot

Telegram bot tải video TikTok, Facebook, YouTube và Instagram bằng MP4; hỗ trợ bài ảnh/slideshow và dashboard quản lý.

## Deploy Fly.io

1. Cài `flyctl`, đăng nhập bằng `fly auth login`, rồi clone repository.
2. Kiểm tra tên app trong `fly.toml`. Nếu tên `nobita-media-bot` đã thuộc tài khoản khác, đổi thành một tên duy nhất và sửa `PUBLIC_BASE_URL` theo dạng `https://TEN-APP.fly.dev`.
3. Tạo app (chỉ cần làm một lần):

   ```bash
   fly apps create nobita-media-bot
   ```

4. Đặt bí mật. Không commit token hoặc API key vào GitHub:

   ```bash
   fly secrets set TELEGRAM_BOT_TOKEN="TOKEN_BOT"
   fly secrets set DASHBOARD_KEY="MAT_KHAU_DASHBOARD"
   ```

   Nếu dùng TikWMAPI hoặc cookie TikTok:

   ```bash
   fly secrets set TIKWMAPI_KEY="API_KEY"
   fly secrets set TIKTOK_COOKIES_B64="NOI_DUNG_COOKIE_DA_MA_HOA_BASE64"
   ```

5. Deploy và kiểm tra:

   ```bash
   fly deploy
   fly status
   fly logs
   ```

   Health check: `https://nobita-media-bot.fly.dev/health`

   Dashboard: `https://nobita-media-bot.fly.dev/dashboard?key=DASHBOARD_KEY`

Bot dùng Telegram long polling. Cấu hình Fly giữ đúng một Machine chạy liên tục; không chạy đồng thời bot này trên Render, Railway, máy tính hoặc Fly app khác bằng cùng một token, nếu không Telegram sẽ trả lỗi `409 Conflict`.

## Deploy Render

1. Tạo Web Service từ repository và chọn Blueprint hoặc Docker.
2. Khai báo `TELEGRAM_BOT_TOKEN` lấy từ BotFather.
3. Deploy rồi mở `/health` để kiểm tra.
4. Dashboard nằm tại `/dashboard?key=DASHBOARD_KEY`.

Bot dùng polling nên không cần webhook. Cookie đăng nhập không được lưu trong repository.

## TikWMAPI

Đặt API key mới vào biến môi trường `TIKWMAPI_KEY`. Bot gọi `GET https://api.tikwmapi.com/`
với header `x-tikwmapi-key`, ưu tiên `data.hdplay` rồi `data.play`. Không lưu key
trong GitHub.

## Video TikTok yêu cầu đăng nhập

Một số video nhạy cảm/giới hạn tuổi bắt buộc dùng cookie TikTok. Xuất cookie dạng Netscape
`cookies.txt`, mã hóa toàn bộ file bằng Base64 rồi đặt vào biến môi trường
`TIKTOK_COOKIES_B64`. Không commit cookie vào GitHub.
