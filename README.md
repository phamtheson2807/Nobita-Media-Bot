# Nobita Media Bot

Telegram bot tải video TikTok, Facebook, YouTube và Instagram bằng MP4; hỗ trợ bài ảnh/slideshow và dashboard quản lý.

## Deploy Render

1. Tạo Web Service từ repository và chọn Blueprint hoặc Docker.
2. Khai báo `TELEGRAM_BOT_TOKEN` lấy từ BotFather.
3. Deploy rồi mở `/health` để kiểm tra.
4. Dashboard nằm tại `/dashboard?key=DASHBOARD_KEY`.

Bot dùng polling nên không cần webhook. Cookie đăng nhập không được lưu trong repository.
