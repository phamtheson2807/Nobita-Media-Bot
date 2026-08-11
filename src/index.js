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
app.get('/dashboard-old', (req, res) => {
  if (req.query.key !== dashboardKey) return res.status(401).send('Unauthorized');
  const rows = jobs.map(j => `<tr><td><span class="status ${j.status}">${escapeHtml(j.status)}</span></td><td>${escapeHtml(j.platform)}</td><td>${escapeHtml(j.user)}</td><td><div class="progress"><i style="width:${j.progress}%"></i></div>${j.progress.toFixed(1)}%</td><td>${escapeHtml(j.speed || '—')}</td><td>${escapeHtml(j.eta || '—')}</td><td title="${escapeHtml(j.url)}">${escapeHtml(j.url.slice(0,45))}</td><td class="err">${escapeHtml(j.error || '—')}</td><td>${new Date(j.startedAt).toLocaleString('vi-VN')}</td></tr>`).join('');
  res.send(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="4"><title>Nobita Admin</title><style>body{margin:0;font-family:Inter,system-ui;background:#07101e;color:#eaf2ff}.wrap{max-width:1400px;margin:auto;padding:30px}.top{display:flex;justify-content:space-between;align-items:center}.live{color:#6ee7a8}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin:22px 0}.card{padding:20px;border:1px solid #263b59;border-radius:16px;background:#101d30}.n{font-size:34px;font-weight:800;color:#6ee7ff}.muted{color:#91a4be}.table{overflow:auto;border:1px solid #263b59;border-radius:16px}table{border-collapse:collapse;width:100%;min-width:1100px;background:#0d192a}th,td{text-align:left;padding:12px;border-bottom:1px solid #1e3049;font-size:13px}th{color:#91a4be;background:#111f33}.status{padding:4px 8px;border-radius:99px;background:#263b59}.status.success{background:#123c2b;color:#6ee7a8}.status.failed{background:#49202a;color:#ff9aaa}.status.downloading,.status.sending{background:#173956;color:#6ee7ff}.progress{width:110px;height:7px;background:#203149;border-radius:9px;overflow:hidden;display:inline-block;margin-right:7px}.progress i{display:block;height:100%;background:#45c9ec}.err{max-width:260px;color:#ffabb7}</style></head><body><div class="wrap"><div class="top"><div><h1>🚀 Nobita Admin</h1><div class="muted">Khởi động: ${escapeHtml(stats.startedAt)}</div></div><b class="live">● LIVE · tự tải lại 4 giây</b></div><div class="grid"><div class="card"><div class="n">${stats.total}</div>Tổng yêu cầu</div><div class="card"><div class="n">${stats.success}</div>Thành công</div><div class="card"><div class="n">${stats.failed}</div>Thất bại</div><div class="card"><div class="n">${stats.active}</div>Đang xử lý</div>${Object.entries(stats.platforms).map(([k,v])=>`<div class="card"><div class="n">${v}</div>${escapeHtml(k)}</div>`).join('')}</div><h2>Yêu cầu gần đây</h2><div class="table"><table><thead><tr><th>Trạng thái</th><th>Nền tảng</th><th>Người dùng</th><th>Tiến độ</th><th>Tốc độ</th><th>ETA</th><th>URL</th><th>Lỗi</th><th>Bắt đầu</th></tr></thead><tbody>${rows || '<tr><td colspan="9">Chưa có yêu cầu</td></tr>'}</tbody></table></div></div></body></html>`);
});
app.get('/api/admin/state', (req, res) => {
  if (req.query.key !== dashboardKey) return res.status(401).json({ error: 'Unauthorized' });
  res.set('Cache-Control', 'no-store');
  res.json({
    stats: { ...stats, uptime: process.uptime(), successRate: stats.total ? Math.round(stats.success / stats.total * 1000) / 10 : 0 },
    system: { cookieStatus, tikwmapi: Boolean(process.env.TIKWMAPI_KEY), memoryMB: Math.round(process.memoryUsage().rss / 1048576) },
    jobs
  });
});
app.post('/api/admin/jobs/clear', (req, res) => {
  if (req.query.key !== dashboardKey) return res.status(401).json({ error: 'Unauthorized' });
  jobs.splice(0, jobs.length);
  res.json({ ok: true });
});
app.get(['/dashboard', '/admin'], (req, res) => {
  if (req.query.key !== dashboardKey) return res.status(401).send('Unauthorized');
  res.send(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nobita Control Center</title><style>
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:Inter,ui-sans-serif,system-ui;background:#07111f;color:#eaf2ff;transition:.25s}body:before{content:"";position:fixed;inset:0;background:radial-gradient(circle at 10% 0,#12345d66,transparent 35%),radial-gradient(circle at 90% 10%,#13504444,transparent 30%);pointer-events:none}.layout{display:grid;grid-template-columns:245px 1fr;min-height:100vh}.side{position:sticky;top:0;height:100vh;padding:28px 20px;border-right:1px solid #20334b;background:#091523dd;backdrop-filter:blur(18px)}.brand{font-size:20px;font-weight:800}.brand b{color:#5ee7ff}.nav{margin-top:32px}.nav button{display:block;width:100%;padding:12px 14px;margin:7px 0;border:0;border-radius:11px;background:transparent;color:#8fa5bf;text-align:left;font:inherit;cursor:pointer;transition:.18s}.nav button:hover,.nav .on{background:#15314b;color:#fff;transform:translateX(3px)}.side-foot{position:absolute;bottom:25px;color:#7188a4;font-size:12px}.main{min-width:0;padding:28px 32px 60px}.header{display:flex;justify-content:space-between;gap:20px;align-items:center}.header h1{margin:0;font-size:28px}.header-actions{display:flex;gap:9px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.sub{color:#88a0bb;margin-top:5px}.live{padding:8px 12px;border:1px solid #23523f;border-radius:99px;color:#65e6a5;background:#0e2b22}.btn{border:1px solid #2a4563;background:#10243a;color:#ddecff;border-radius:11px;padding:10px 13px;font-weight:700;cursor:pointer;transition:.18s;white-space:nowrap}.btn:hover{border-color:#58d8f7;background:#17344f;transform:translateY(-1px)}.btn:active{transform:translateY(1px)}.btn:focus-visible,.nav button:focus-visible,.input:focus,.select:focus{outline:2px solid #5ee7ff;outline-offset:2px}.btn.primary{background:linear-gradient(135deg,#159bc4,#27c5a0);border-color:transparent;color:#04131c}.btn.danger{color:#ffacb8;border-color:#663040;background:#321a24}.btn.small{padding:6px 9px;font-size:12px}.btn.busy{opacity:.65;pointer-events:none}.cards{display:grid;grid-template-columns:repeat(5,minmax(145px,1fr));gap:14px;margin:24px 0;scroll-margin-top:20px}.card,.panel{border:1px solid #203650;background:linear-gradient(145deg,#0e1d30dd,#0a1727dd);box-shadow:0 14px 35px #0003;border-radius:16px}.card{padding:18px;transition:.2s}.card:hover{transform:translateY(-3px);border-color:#315473}.label{font-size:12px;color:#8299b4}.value{font-size:30px;font-weight:800;margin:6px 0}.delta{font-size:12px;color:#5fe5a0}.overview{display:grid;grid-template-columns:1.4fr .8fr;gap:14px;scroll-margin-top:20px}.panel{padding:20px}.panel h3{margin:0 0 17px}.platforms{display:grid;gap:13px}.p-row{display:grid;grid-template-columns:95px 1fr 38px;align-items:center;gap:10px}.track,.mini-track{height:8px;background:#1d3047;border-radius:9px;overflow:hidden}.track i,.mini-track i{display:block;height:100%;border-radius:9px;background:linear-gradient(90deg,#33b9e8,#6be5ff)}.health{display:flex;align-items:center;gap:22px}.ring{width:120px;height:120px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(#5fe5a0 var(--rate),#203149 0);position:relative}.ring:after{content:"";position:absolute;inset:10px;border-radius:50%;background:#0c1a2b}.ring b{position:relative;z-index:1;font-size:25px}.health-list{display:grid;gap:9px;color:#9bb0c8}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#5fe5a0;margin-right:7px}.tools{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0 12px}.input,.select{background:#0d1c2e;border:1px solid #28405d;color:#eaf2ff;border-radius:11px;padding:11px 13px}.input{min-width:260px;flex:1}.select{min-width:150px}.table-wrap{overflow:auto;border:1px solid #203650;border-radius:16px;background:#0b1829;scroll-margin-top:20px}table{width:100%;border-collapse:collapse;min-width:1100px}th,td{text-align:left;padding:13px 14px;border-bottom:1px solid #192c43;font-size:13px}th{position:sticky;top:0;background:#102036;color:#839ab5;z-index:1}.badge{padding:5px 9px;border-radius:99px;background:#26364c}.badge.success{color:#6ce7aa;background:#123b2c}.badge.failed{color:#ffa3b2;background:#48212b}.badge.downloading,.badge.sending{color:#67dfff;background:#143b53}.url{max-width:260px;color:#9cb3ce}.url-line{display:flex;align-items:center;gap:7px}.url-text{max-width:185px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.error{max-width:230px;color:#ffafba}.empty{text-align:center;padding:45px;color:#7890aa}.mobile-nav{display:none}.toast{position:fixed;right:24px;bottom:24px;padding:13px 17px;border-radius:12px;background:#153b33;color:#8ff0bd;border:1px solid #2b6a57;box-shadow:0 16px 40px #0007;opacity:0;transform:translateY(12px);pointer-events:none;transition:.22s;z-index:20}.toast.show{opacity:1;transform:none}.toast.error{background:#44202a;color:#ffc0c9;border-color:#7b3545}body.light{background:#edf4fa;color:#102237}body.light:before{background:radial-gradient(circle at 10% 0,#8bdfff55,transparent 35%),radial-gradient(circle at 90% 10%,#91f4cf55,transparent 30%)}body.light .side{background:#f7fbffdd;border-color:#cbdbe8}body.light .card,body.light .panel,body.light .table-wrap{background:#fffdf0;border-color:#cadbe8;box-shadow:0 12px 30px #28516b18}body.light .input,body.light .select,body.light .btn{background:#fff;color:#173047;border-color:#bdd0df}body.light th{background:#e9f2f8;color:#47627b}body.light td{border-color:#dbe7ef}body.light .ring:after{background:#fffdf0}body.light .sub,body.light .health-list,body.light .label{color:#617890}@media(max-width:1050px){.layout{grid-template-columns:1fr}.side{display:none}.main{padding:20px}.cards{grid-template-columns:repeat(2,1fr)}.overview{grid-template-columns:1fr}.mobile-nav{display:block;color:#5ee7ff}.header h1{font-size:23px}}@media(max-width:680px){.header{align-items:flex-start;flex-direction:column}.header-actions{justify-content:flex-start}.live{display:none}.tools .btn{flex:1}.toast{left:16px;right:16px;text-align:center}}@media(max-width:520px){.cards{grid-template-columns:1fr 1fr}.card:last-child{grid-column:1/-1}.input{min-width:100%}}
</style></head><body><div class="layout"><aside class="side"><div class="brand">NOBITA <b>CONTROL</b></div><div class="nav"><button type="button" class="on nav-btn" data-target="overviewSection">◈ Tổng quan</button><button type="button" class="nav-btn" data-target="jobsSection">⇩ Tác vụ tải</button><button type="button" class="nav-btn" data-target="jobsSection">◎ Người dùng</button><button type="button" class="nav-btn" data-target="systemSection">⚙ Hệ thống</button></div><div class="side-foot">Media Bot · Render</div></aside><main class="main"><header class="header"><div><div class="mobile-nav">NOBITA CONTROL</div><h1>Trung tâm điều hành</h1><div class="sub" id="updated">Đang kết nối dữ liệu...</div></div><div class="header-actions"><div class="live">● Hệ thống hoạt động</div><button type="button" class="btn" id="themeBtn">☀ Giao diện</button><button type="button" class="btn primary" id="refreshBtn">↻ Làm mới</button></div></header><section class="cards" id="overviewSection"><div class="card"><div class="label">TỔNG YÊU CẦU</div><div class="value" id="total">0</div><div class="delta">Tất cả nền tảng</div></div><div class="card"><div class="label">THÀNH CÔNG</div><div class="value" id="success">0</div><div class="delta" id="rateText">0% tỷ lệ</div></div><div class="card"><div class="label">THẤT BẠI</div><div class="value" id="failed">0</div><div class="delta" style="color:#ff9baa">Cần kiểm tra</div></div><div class="card"><div class="label">ĐANG XỬ LÝ</div><div class="value" id="active">0</div><div class="delta">Theo thời gian thực</div></div><div class="card"><div class="label">BỘ NHỚ</div><div class="value" id="memory">0</div><div class="delta">MB đang dùng</div></div></section><section class="overview" id="systemSection"><div class="panel"><h3>Phân bổ nền tảng</h3><div class="platforms" id="platforms"></div></div><div class="panel"><h3>Sức khỏe hệ thống</h3><div class="health"><div class="ring" id="ring" style="--rate:0%"><b id="ringValue">0%</b></div><div class="health-list"><span><i class="dot"></i>Telegram Polling</span><span><i class="dot"></i>TikWMAPI: <b id="apiState">—</b></span><span><i class="dot"></i>Uptime: <b id="uptime">—</b></span></div></div></div></section><div class="tools"><input class="input" id="search" placeholder="Tìm theo người dùng, URL hoặc lỗi..."><select class="select" id="status"><option value="">Mọi trạng thái</option><option value="downloading">Đang tải</option><option value="sending">Đang gửi</option><option value="success">Thành công</option><option value="failed">Thất bại</option></select><select class="select" id="platform"><option value="">Mọi nền tảng</option><option>TikTok</option><option>Facebook</option><option>YouTube</option><option>Instagram</option></select><button type="button" class="btn" id="resetBtn">Đặt lại</button><button type="button" class="btn" id="exportBtn">Xuất CSV</button><button type="button" class="btn danger" id="clearBtn">Xóa lịch sử</button></div><div class="table-wrap" id="jobsSection"><table><thead><tr><th>Trạng thái</th><th>Nền tảng</th><th>Người dùng</th><th>Tiến độ</th><th>Tốc độ</th><th>ETA</th><th>URL</th><th>Lỗi</th><th>Thời gian</th></tr></thead><tbody id="rows"></tbody></table><div class="empty" id="empty">Chưa có yêu cầu phù hợp</div></div></main></div><div class="toast" id="toast"></div><script>
const key=new URLSearchParams(location.search).get('key'),q=document.getElementById('search'),sf=document.getElementById('status'),pf=document.getElementById('platform');let state={jobs:[]},toastTimer;const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const duration=s=>{s=Math.floor(s);const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return(d?d+'d ':'')+(h?h+'h ':'')+m+'m'};const filteredJobs=()=>{const term=q.value.toLowerCase(),status=sf.value,platform=pf.value;return(state.jobs||[]).filter(j=>(!status||j.status===status)&&(!platform||j.platform===platform)&&(!term||JSON.stringify(j).toLowerCase().includes(term)))};function notify(message,isError){toast.textContent=message;toast.className='toast show'+(isError?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.className='toast',2400)}function render(){const s=state.stats||{},sys=state.system||{};total.textContent=s.total||0;success.textContent=s.success||0;failed.textContent=s.failed||0;active.textContent=s.active||0;memory.textContent=sys.memoryMB||0;rateText.textContent=(s.successRate||0)+'% tỷ lệ';ringValue.textContent=(s.successRate||0)+'%';ring.style.setProperty('--rate',(s.successRate||0)+'%');apiState.textContent=sys.tikwmapi?'Đã kết nối':'Chưa cấu hình';uptime.textContent=duration(s.uptime||0);const max=Math.max(1,...Object.values(s.platforms||{}));platforms.innerHTML=Object.entries(s.platforms||{}).map(([k,v])=>'<div class="p-row"><b>'+esc(k)+'</b><div class="track"><i style="width:'+(v/max*100)+'%"></i></div><span>'+v+'</span></div>').join('')||'<div class="sub">Chưa có dữ liệu</div>';const list=filteredJobs();rows.innerHTML=list.map(j=>'<tr><td><span class="badge '+esc(j.status)+'">'+esc(j.status)+'</span></td><td>'+esc(j.platform)+'</td><td>'+esc(j.user)+'</td><td><div class="mini-track"><i style="width:'+Number(j.progress||0)+'%"></i></div> '+Number(j.progress||0).toFixed(1)+'%</td><td>'+esc(j.speed||'—')+'</td><td>'+esc(j.eta||'—')+'</td><td class="url"><div class="url-line"><span class="url-text" title="'+esc(j.url)+'">'+esc(j.url)+'</span><button type="button" class="btn small copy-btn" data-url="'+esc(j.url)+'">Sao chép</button></div></td><td class="error">'+esc(j.error||'—')+'</td><td>'+new Date(j.startedAt).toLocaleString('vi-VN')+'</td></tr>').join('');empty.style.display=list.length?'none':'block';updated.textContent='Cập nhật '+new Date().toLocaleTimeString('vi-VN')+' · tự động mỗi 2 giây'}async function load(manual){if(manual){refreshBtn.classList.add('busy');refreshBtn.textContent='Đang tải...'}try{const r=await fetch('/api/admin/state?key='+encodeURIComponent(key),{cache:'no-store'});if(!r.ok)throw 0;state=await r.json();render();if(manual)notify('Đã cập nhật dữ liệu')}catch{updated.textContent='Mất kết nối dữ liệu';if(manual)notify('Không thể kết nối máy chủ',true)}finally{refreshBtn.classList.remove('busy');refreshBtn.textContent='↻ Làm mới'}}[q,sf,pf].forEach(e=>e.addEventListener('input',render));document.querySelectorAll('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.nav-btn').forEach(x=>x.classList.remove('on'));btn.classList.add('on');document.getElementById(btn.dataset.target).scrollIntoView({behavior:'smooth',block:'start'})}));refreshBtn.addEventListener('click',()=>load(true));resetBtn.addEventListener('click',()=>{q.value='';sf.value='';pf.value='';render();notify('Đã đặt lại bộ lọc')});themeBtn.addEventListener('click',()=>{document.body.classList.toggle('light');localStorage.setItem('nobita-theme',document.body.classList.contains('light')?'light':'dark');notify('Đã đổi giao diện')});if(localStorage.getItem('nobita-theme')==='light')document.body.classList.add('light');rows.addEventListener('click',async e=>{const btn=e.target.closest('.copy-btn');if(!btn)return;try{await navigator.clipboard.writeText(btn.dataset.url);notify('Đã sao chép URL')}catch{notify('Trình duyệt không cho phép sao chép',true)}});exportBtn.addEventListener('click',()=>{const list=filteredJobs();if(!list.length)return notify('Không có dữ liệu để xuất',true);const fields=['status','platform','user','progress','speed','eta','url','error','startedAt'];const quote=v=>'"'+String(v??'').replace(/"/g,'""')+'"';const csv='\uFEFF'+fields.join(',')+'\\n'+list.map(j=>fields.map(f=>quote(j[f])).join(',')).join('\\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.download='nobita-jobs-'+new Date().toISOString().slice(0,10)+'.csv';a.click();URL.revokeObjectURL(a.href);notify('Đã xuất '+list.length+' tác vụ')});clearBtn.addEventListener('click',async()=>{if(!confirm('Xóa toàn bộ lịch sử tác vụ? Thao tác này không thể hoàn tác.'))return;clearBtn.classList.add('busy');try{const r=await fetch('/api/admin/jobs/clear?key='+encodeURIComponent(key),{method:'POST'});if(!r.ok)throw 0;await load();notify('Đã xóa lịch sử')}catch{notify('Không thể xóa lịch sử',true)}finally{clearBtn.classList.remove('busy')}});load();setInterval(load,2000);
</script></body></html>`);
});
app.listen(port, () => console.log(`Web listening on ${port}`));

process.on('SIGTERM', () => { bot.stopPolling(); process.exit(0); });
