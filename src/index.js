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

const cookieFile = path.join(root, 'data', 'tiktok-cookies.txt');
let cookieStatus = 'missing';
if (process.env.TIKTOK_COOKIES_B64) {
  try {
    const decoded = Buffer.from(process.env.TIKTOK_COOKIES_B64.trim(), 'base64').toString('utf8');
    const validLines = decoded.split(/\r?\n/).filter(line =>
      line && !line.startsWith('#') && line.split('\t').length >= 7
    );
    const valid = /# Netscape HTTP Cookie File/i.test(decoded)
      && validLines.length > 0
      && validLines.some(line => /(?:^|\.)tiktok\.com\t/i.test(line));
    if (!valid) throw new Error('not a Netscape TikTok cookies.txt file');
    fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
    fs.writeFileSync(cookieFile, decoded);
    fs.chmodSync(cookieFile, 0o600);
    cookieStatus = 'valid';
  } catch (error) {
    cookieStatus = 'invalid';
    console.error('[Cookies] TIKTOK_COOKIES_B64 is invalid:', error.message);
  }
}

const stats = { startedAt: new Date().toISOString(), total: 0, success: 0, failed: 0, active: 0, platforms: {} };
const jobs = [];
const bot = new TelegramBot(token, { polling: true });
const app = express();

function rememberJob(job) {
  jobs.unshift(job);
  if (jobs.length > 100) jobs.length = 100;
}

function platformOf(url) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  if (/tiktok\.com$/.test(host)) return 'TikTok';
  if (/(facebook\.com|fb\.watch)$/.test(host)) return 'Facebook';
  if (/(youtube\.com|youtu\.be)$/.test(host)) return 'YouTube';
  if (/instagram\.com$/.test(host)) return 'Instagram';
  return null;
}

function run(args, timeout = 150000, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { cwd: root });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', d => {
      out += d;
      for (const line of String(d).split(/\r?\n/)) {
        const match = line.match(/PROGRESS:\s*([\d.]+)%\|([^|]*)\|([^|]*)/);
        if (match) onProgress({ percent: Number(match[1]), speed: match[2].trim(), eta: match[3].trim() });
      }
    });
    child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve(out.trim()) : reject(new Error(err.trim().slice(-1500) || `yt-dlp exited ${code}`));
    });
  });
}

async function saveRemote(url, file, onProgress = () => {}) {
  const response = await require('axios').get(url, {
    responseType: 'stream', timeout: 20000, maxRedirects: 5,
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tiktok.com/' }
  });
  const total = Number(response.headers['content-length'] || 0);
  let loaded = 0;
  response.data.on('data', chunk => {
    loaded += chunk.length;
    if (total) onProgress({ percent: loaded / total * 100, speed: '', eta: '' });
  });
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(file);
    response.data.pipe(output);
    output.on('finish', resolve); output.on('error', reject);
  });
}

async function downloadTikTokApi(url, dir, onProgress) {
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
      await saveRemote(data.images[i], file, p => onProgress({ ...p, percent: ((i + p.percent / 100) / data.images.length) * 100 })); images.push(file);
    }
    return { dir, videos: [], images };
  }
  const videoUrl = data.hdplay || data.play;
  if (!videoUrl) throw new Error('TikTok API returned no media');
  const file = path.join(dir, 'tiktok.mp4');
  await saveRemote(videoUrl, file, onProgress);
  return { dir, videos: [file], images: [] };
}

async function downloadTikWmApiPro(url, dir, onProgress) {
  const apiKey = process.env.TIKWMAPI_KEY?.trim();
  if (!apiKey) throw new Error('TIKWMAPI_KEY is not configured');
  const axios = require('axios');
  const response = await axios.get('https://api.tikwmapi.com/', {
    params: { url, hd: 1 }, timeout: 15000,
    headers: { 'x-tikwmapi-key': apiKey, Accept: 'application/json' }
  });
  const body = response.data;
  if (body?.code !== 0 || !body?.data) {
    throw new Error(`TikWMAPI: ${body?.msg || `code ${body?.code ?? 'unknown'}`}`);
  }
  const data = body.data;
  const apiImages = data.images || data.image_post?.images;
  if (Array.isArray(apiImages) && apiImages.length) {
    const images = [];
    for (let i = 0; i < Math.min(apiImages.length, 35); i++) {
      const imageUrl = typeof apiImages[i] === 'string' ? apiImages[i] : apiImages[i]?.url_list?.[0] || apiImages[i]?.display_image?.url_list?.[0];
      if (!imageUrl) continue;
      const file = path.join(dir, `tikwmapi-slide-${String(i + 1).padStart(2, '0')}.jpg`);
      await saveRemote(imageUrl, file, p => onProgress({ ...p, percent: ((i + p.percent / 100) / apiImages.length) * 100 })); images.push(file);
    }
    if (images.length) return { dir, videos: [], images };
  }
  const videoUrl = data.hdplay || data.play;
  if (!videoUrl) throw new Error('TikWMAPI returned no MP4 video');
  const file = path.join(dir, 'tikwmapi.mp4');
  await saveRemote(videoUrl, file, onProgress);
  return { dir, videos: [file], images: [] };
}

async function normalizeTikTokUrl(url) {
  try {
    const axios = require('axios');
    const response = await axios.get(url, {
      maxRedirects: 5, timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: status => status >= 200 && status < 400
    });
    return response.request?.res?.responseUrl || response.request?._redirectable?._currentUrl || url;
  } catch (_) { return url; }
}

async function downloadTikTokMobile(url, dir, onProgress) {
  const axios = require('axios');
  const normalized = await normalizeTikTokUrl(url);
  const id = normalized.match(/\/(?:video|v)\/(\d+)/)?.[1] || normalized.match(/[?&](?:item_id|modal_id)=(\d+)/)?.[1];
  if (!id) throw new Error('TikTok video ID not found');
  const hosts = [
    'https://api16-normal-c-useast1a.tiktokv.com',
    'https://api16-normal-useast5.us.tiktokv.com',
    'https://api22-normal-c-useast1a.tiktokv.com'
  ];
  let lastError;
  for (const host of hosts) {
    try {
      const response = await axios.get(`${host}/aweme/v1/feed/`, {
        params: { aweme_id: id }, timeout: 7000,
        headers: { 'User-Agent': 'com.zhiliaoapp.musically/2022600030 (Linux; Android 13; en_US)', Accept: 'application/json' }
      });
      const item = response.data?.aweme_list?.[0] || response.data?.item_list?.[0];
      const video = item?.video;
      const media = video?.play_addr_h264?.url_list?.[0] || video?.play_addr?.url_list?.[0] || video?.download_addr?.url_list?.[0];
      if (!media) throw new Error('Mobile API returned no video');
      const file = path.join(dir, 'tiktok-mobile.mp4');
      await saveRemote(media, file, onProgress);
      return { dir, videos: [file], images: [] };
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('TikTok mobile API unavailable');
}

async function download(url, onProgress = () => {}) {
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(downloadDir, id);
  await fsp.mkdir(dir, { recursive: true });
  if (platformOf(url) === 'TikTok') {
    try { return await downloadTikWmApiPro(url, dir, onProgress); }
    catch (error) { console.log('[TikWMAPI]', error.message); }
    try { return await downloadTikTokApi(url, dir, onProgress); }
    catch (error) { console.log('[TikTok API fallback]', error.message); }
    try { return await downloadTikTokMobile(url, dir, onProgress); }
    catch (error) { console.log('[TikTok mobile fallback]', error.message); }
  }
  const output = path.join(dir, '%(playlist_index|0)03d-%(id)s.%(ext)s');
  const commonArgs = [
    '--no-warnings', '--no-check-certificates', '--playlist-end', '20',
    '--socket-timeout', '12', '--retries', '1', '--fragment-retries', '1',
    '--newline', '--progress-template', 'download:PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--merge-output-format', 'mp4', '--write-thumbnail', '--convert-thumbnails', 'jpg',
    '-o', output
  ];
  const platform = platformOf(url);
  const formatSelectors = platform === 'Facebook'
    ? [
        'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
        'bestvideo+bestaudio/best',
        null
      ]
    : ['bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best[height<=720]/best'];
  let downloadError;
  for (const selector of formatSelectors) {
    const args = [...commonArgs];
    if (selector) args.push('-f', selector);
    if (platform === 'TikTok' && cookieStatus === 'valid') args.push('--cookies', cookieFile);
    args.push(url);
    try {
      await run(args, 150000, onProgress);
      downloadError = null;
      break;
    } catch (error) {
      downloadError = error;
      console.log(`[${platform}] Format ${selector || 'default'} failed: ${error.message.slice(-350)}`);
      for (const name of await fsp.readdir(dir)) {
        await fsp.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  if (downloadError) {
    if (platform === 'TikTok' && /log in|cookies/i.test(downloadError.message) && cookieStatus !== 'valid') {
      const reason = cookieStatus === 'invalid' ? 'TIKTOK_COOKIES_B64 đang sai định dạng' : 'chưa có TIKTOK_COOKIES_B64';
      throw new Error(`Video này bắt buộc đăng nhập TikTok nhưng ${reason}. Cần dùng cookies.txt định dạng Netscape.`);
    }
    throw downloadError;
  }
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
  const job = {
    id: crypto.randomBytes(5).toString('hex'), platform, url,
    user: msg.from?.username ? `@${msg.from.username}` : [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || String(msg.from?.id || ''),
    userId: msg.from?.id, status: 'downloading', progress: 0,
    speed: '', eta: '', startedAt: new Date().toISOString(), finishedAt: null, error: ''
  };
  rememberJob(job);
  let lastProgressUpdate = 0;
  const updateProgress = async progress => {
    job.progress = Math.max(job.progress, Math.min(100, Number(progress.percent || 0)));
    job.speed = progress.speed || job.speed; job.eta = progress.eta || job.eta;
    const now = Date.now();
    if (now - lastProgressUpdate < 1800 && job.progress < 100) return;
    lastProgressUpdate = now;
    const filled = Math.round(job.progress / 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const details = [job.speed && `⚡ ${job.speed}`, job.eta && `⏱ ${job.eta}`].filter(Boolean).join(' · ');
    await bot.editMessageText(`⬇️ Đang tải ${platform}\n${bar} ${job.progress.toFixed(1)}%${details ? `\n${details}` : ''}`, {
      chat_id: msg.chat.id, message_id: wait.message_id
    }).catch(() => {});
  };
  let result;
  try {
    result = await download(url, updateProgress);
    job.status = 'sending'; job.progress = 100;
    await bot.editMessageText(`📤 Đã tải xong, đang gửi ${platform}...`, { chat_id: msg.chat.id, message_id: wait.message_id }).catch(() => {});
    await sendResult(msg.chat.id, result, `✅ ${platform}`);
    stats.success++;
    job.status = 'success'; job.finishedAt = new Date().toISOString();
    await bot.deleteMessage(msg.chat.id, wait.message_id).catch(() => {});
  } catch (error) {
    stats.failed++;
    job.status = 'failed'; job.error = error.message.slice(0, 500); job.finishedAt = new Date().toISOString();
    console.error(`[${platform}]`, error.message);
    await bot.editMessageText(`❌ Không tải được: ${error.message.slice(0, 350)}`, { chat_id: msg.chat.id, message_id: wait.message_id });
  } finally {
    stats.active--;
    if (result?.dir) await fsp.rm(result.dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime(), active: stats.active, tiktokCookies: cookieStatus }));
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
app.get(['/dashboard', '/admin'], (req, res) => {
  if (req.query.key !== dashboardKey) return res.status(401).send('Unauthorized');
  const rows = jobs.map(j => `<tr><td><span class="status ${j.status}">${escapeHtml(j.status)}</span></td><td>${escapeHtml(j.platform)}</td><td>${escapeHtml(j.user)}</td><td><div class="progress"><i style="width:${j.progress}%"></i></div>${j.progress.toFixed(1)}%</td><td>${escapeHtml(j.speed || '—')}</td><td>${escapeHtml(j.eta || '—')}</td><td title="${escapeHtml(j.url)}">${escapeHtml(j.url.slice(0,45))}</td><td class="err">${escapeHtml(j.error || '—')}</td><td>${new Date(j.startedAt).toLocaleString('vi-VN')}</td></tr>`).join('');
  res.send(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="4"><title>Nobita Admin</title><style>body{margin:0;font-family:Inter,system-ui;background:#07101e;color:#eaf2ff}.wrap{max-width:1400px;margin:auto;padding:30px}.top{display:flex;justify-content:space-between;align-items:center}.live{color:#6ee7a8}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin:22px 0}.card{padding:20px;border:1px solid #263b59;border-radius:16px;background:#101d30}.n{font-size:34px;font-weight:800;color:#6ee7ff}.muted{color:#91a4be}.table{overflow:auto;border:1px solid #263b59;border-radius:16px}table{border-collapse:collapse;width:100%;min-width:1100px;background:#0d192a}th,td{text-align:left;padding:12px;border-bottom:1px solid #1e3049;font-size:13px}th{color:#91a4be;background:#111f33}.status{padding:4px 8px;border-radius:99px;background:#263b59}.status.success{background:#123c2b;color:#6ee7a8}.status.failed{background:#49202a;color:#ff9aaa}.status.downloading,.status.sending{background:#173956;color:#6ee7ff}.progress{width:110px;height:7px;background:#203149;border-radius:9px;overflow:hidden;display:inline-block;margin-right:7px}.progress i{display:block;height:100%;background:#45c9ec}.err{max-width:260px;color:#ffabb7}</style></head><body><div class="wrap"><div class="top"><div><h1>🚀 Nobita Admin</h1><div class="muted">Khởi động: ${escapeHtml(stats.startedAt)}</div></div><b class="live">● LIVE · tự tải lại 4 giây</b></div><div class="grid"><div class="card"><div class="n">${stats.total}</div>Tổng yêu cầu</div><div class="card"><div class="n">${stats.success}</div>Thành công</div><div class="card"><div class="n">${stats.failed}</div>Thất bại</div><div class="card"><div class="n">${stats.active}</div>Đang xử lý</div>${Object.entries(stats.platforms).map(([k,v])=>`<div class="card"><div class="n">${v}</div>${escapeHtml(k)}</div>`).join('')}</div><h2>Yêu cầu gần đây</h2><div class="table"><table><thead><tr><th>Trạng thái</th><th>Nền tảng</th><th>Người dùng</th><th>Tiến độ</th><th>Tốc độ</th><th>ETA</th><th>URL</th><th>Lỗi</th><th>Bắt đầu</th></tr></thead><tbody>${rows || '<tr><td colspan="9">Chưa có yêu cầu</td></tr>'}</tbody></table></div></div></body></html>`);
});
app.listen(port, () => console.log(`Web listening on ${port}`));

process.on('SIGTERM', () => { bot.stopPolling(); process.exit(0); });
