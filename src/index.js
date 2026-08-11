const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN');
const port = Number(process.env.PORT || 3000);
const maxBytes = Number(process.env.MAX_FILE_MB || 49) * 1024 * 1024;
const dashboardKey = process.env.DASHBOARD_KEY || crypto.randomBytes(18).toString('hex');
const root = path.resolve(__dirname, '..');
const downloadDir = path.join(root, 'downloads');
fs.mkdirSync(downloadDir, { recursive: true });

const stats = { startedAt: new Date().toISOString(), total: 0, success: 0, failed: 0, active: 0, platforms: {} };
const bot = new TelegramBot(token, { polling: true });
const app = express();

function platformOf(url) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  if (/tiktok\.com$/.test(host)) return 'TikTok';
  if (/(facebook\.com|fb\.watch)$/.test(host)) return 'Facebook';
  if (/(youtube\.com|youtu\.be)$/.test(host)) return 'YouTube';
  if (/instagram\.com$/.test(host)) return 'Instagram';
  return null;
}

function run(args, timeout = 150000) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { cwd: root });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve(out.trim()) : reject(new Error(err.trim().slice(-1500) || `yt-dlp exited ${code}`));
    });
  });
}

async function saveRemote(url, file) {
  const response = await require('axios').get(url, {
    responseType: 'stream', timeout: 20000, maxRedirects: 5,
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tiktok.com/' }
  });
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(file);
    response.data.pipe(output);
    output.on('finish', resolve); output.on('error', reject);
  });
}

async function downloadTikTokApi(url, dir) {
  const axios = require('axios');
  const body = new URLSearchParams({ url, hd: '1' }).toString();
  const response = await axios.post('https://www.tikwm.com/api/', body, {
    timeout: 12000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }
  });
  const data = response.data?.data;
  if (response.data?.code !== 0 || !data) throw new Error('TikTok API unavailable');
  if (Array.isArray(data.images) && data.images.length) {
    const images = [];
    for (let i = 0; i < Math.min(data.images.length, 35); i++) {
      const file = path.join(dir, `slide-${String(i + 1).padStart(2, '0')}.jpg`);
      await saveRemote(data.images[i], file); images.push(file);
    }
    return { dir, videos: [], images };
  }
  const videoUrl = data.hdplay || data.play;
  if (!videoUrl) throw new Error('TikTok API returned no media');
  const file = path.join(dir, 'tiktok.mp4');
  await saveRemote(videoUrl, file);
  return { dir, videos: [file], images: [] };
}

async function download(url) {
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(downloadDir, id);
  await fsp.mkdir(dir, { recursive: true });
  if (platformOf(url) === 'TikTok') {
    try { return await downloadTikTokApi(url, dir); }
    catch (error) { console.log('[TikTok API fallback]', error.message); }
  }
  const output = path.join(dir, '%(playlist_index|0)03d-%(id)s.%(ext)s');
  await run([
    '--no-warnings', '--no-check-certificates', '--playlist-end', '20',
    '--socket-timeout', '12', '--retries', '1', '--fragment-retries', '1',
    '-f', 'best[ext=mp4][vcodec!=none]/best[vcodec!=none]',
    '--merge-output-format', 'mp4', '--write-thumbnail', '--convert-thumbnails', 'jpg',
    '-o', output, url
  ]);
  const names = await fsp.readdir(dir);
  const videos = names.filter(n => /\.(mp4|mov|mkv|webm)$/i.test(n)).map(n => path.join(dir, n));
  const images = names.filter(n => /\.(jpg|jpeg|png|webp)$/i.test(n)).map(n => path.join(dir, n));
  if (!videos.length && !images.length) throw new Error('Không tìm thấy video hoặc hình ảnh');
  return { dir, videos, images };
}

async function sendResult(chatId, result, caption) {
  for (const file of result.videos) {
    const size = (await fsp.stat(file)).size;
    if (size > maxBytes) throw new Error(`Video quá lớn: ${(size / 1048576).toFixed(1)} MB`);
    await bot.sendVideo(chatId, file, { caption, supports_streaming: true }, { filename: 'video.mp4', contentType: 'video/mp4' });
  }
  for (let i = 0; i < result.images.length; i += 10) {
    const group = result.images.slice(i, i + 10).map((file, index) => ({ type: 'photo', media: file, caption: i === 0 && index === 0 ? caption : undefined }));
    await bot.sendMediaGroup(chatId, group);
  }
}

bot.onText(/\/start/, msg => bot.sendMessage(msg.chat.id, 'Gửi link TikTok, Facebook, YouTube hoặc Instagram để tải MP4/ảnh.'));
bot.on('message', async msg => {
  const text = msg.text || '';
  if (text.startsWith('/')) return;
  const url = text.match(/https?:\/\/\S+/)?.[0];
  if (!url) return bot.sendMessage(msg.chat.id, 'Vui lòng gửi một đường link hợp lệ.');
  let platform;
  try { platform = platformOf(url); } catch (_) {}
  if (!platform) return bot.sendMessage(msg.chat.id, 'Link này chưa được hỗ trợ.');
  stats.total++; stats.active++; stats.platforms[platform] = (stats.platforms[platform] || 0) + 1;
  const wait = await bot.sendMessage(msg.chat.id, `⏳ Đang xử lý ${platform}...`);
  let result;
  try {
    result = await download(url);
    await sendResult(msg.chat.id, result, `✅ ${platform}`);
    stats.success++;
    await bot.deleteMessage(msg.chat.id, wait.message_id).catch(() => {});
  } catch (error) {
    stats.failed++;
    console.error(`[${platform}]`, error.message);
    await bot.editMessageText(`❌ Không tải được: ${error.message.slice(0, 350)}`, { chat_id: msg.chat.id, message_id: wait.message_id });
  } finally {
    stats.active--;
    if (result?.dir) await fsp.rm(result.dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime(), active: stats.active }));
app.get('/dashboard', (req, res) => {
  if (req.query.key !== dashboardKey) return res.status(401).send('Unauthorized');
  res.send(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Nobita Dashboard</title><style>body{margin:0;font-family:system-ui;background:#08111f;color:#eaf2ff}.wrap{max-width:1050px;margin:auto;padding:40px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:18px}.card{padding:24px;border:1px solid #263b59;border-radius:18px;background:linear-gradient(145deg,#111f33,#0b1727);box-shadow:0 15px 40px #0005}.n{font-size:38px;font-weight:800;color:#6ee7ff}.muted{color:#91a4be}h1{font-size:34px}</style><div class="wrap"><h1>🚀 Nobita Media Bot</h1><p class="muted">Hoạt động từ ${stats.startedAt}</p><div class="grid"><div class="card"><div class="n">${stats.total}</div>Tổng yêu cầu</div><div class="card"><div class="n">${stats.success}</div>Thành công</div><div class="card"><div class="n">${stats.failed}</div>Thất bại</div><div class="card"><div class="n">${stats.active}</div>Đang xử lý</div></div><h2>Nền tảng</h2><div class="grid">${Object.entries(stats.platforms).map(([k,v])=>`<div class="card"><div class="n">${v}</div>${k}</div>`).join('')}</div></div></html>`);
});
app.listen(port, () => console.log(`Web listening on ${port}`));

process.on('SIGTERM', () => { bot.stopPolling(); process.exit(0); });
