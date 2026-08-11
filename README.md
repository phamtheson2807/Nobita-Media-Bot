# Nobita Media Bot

Telegram bot tải video TikTok, Facebook, YouTube và Instagram bằng MP4; hỗ trợ bài ảnh/slideshow và dashboard quản lý.

## Deploy Render

1. Tạo Web Service từ repository và chọn Blueprint hoặc Docker.
2. Khai báo `TELEGRAM_BOT_TOKEN` lấy từ BotFather.
3. Deploy rồi mở `/health` để kiểm tra.
4. Dashboard nằm tại `/dashboard?key=DASHBOARD_KEY`.

Bot dùng polling nên không cần webhook. Cookie đăng nhập không được lưu trong repository.

## TikWMAPI

Đặt API key mới vào biến Render `TIKWMAPI_KEY`. Bot gọi `GET https://api.tikwmapi.com/`
với header `x-tikwmapi-key`, ưu tiên `data.hdplay` rồi `data.play`. Không lưu key
trong GitHub.

## Video TikTok yêu cầu đăng nhập

Một số video nhạy cảm/giới hạn tuổi bắt buộc dùng cookie TikTok. Xuất cookie dạng Netscape
`cookies.txt`, mã hóa toàn bộ file bằng Base64 rồi đặt vào biến Render
`TIKTOK_COOKIES_B64`. Không commit cookie vào GitHub.
