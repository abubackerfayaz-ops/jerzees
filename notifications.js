const https = require('https');
const http = require('http');

// Telegram config (free)
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

console.log(`[Telegram] Bot token: ${TG_BOT_TOKEN ? '✓ SET' : '✗ NOT SET'}`);
console.log(`[Telegram] Chat IDs: ${TG_CHAT_IDS.length ? TG_CHAT_IDS.join(', ') : 'NONE'}`);

// Twilio config (paid fallback)
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_SMS = process.env.TWILIO_PHONE_NUMBER;
const FROM_WHATSAPP = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
const TO_NUMBERS = [
  process.env.NOTIFY_PHONE || '+8613418092985',
  '+919987199973',
];

let client = null;
if (ACCOUNT_SID && AUTH_TOKEN && !ACCOUNT_SID.includes('XXXXX')) {
  try {
    client = require('twilio')(ACCOUNT_SID, AUTH_TOKEN);
  } catch (err) {
    console.error('Twilio initialization failed:', err.message);
  }
}

const notifiedOrders = new Set();

const SEPARATOR = '━━━━━━━━━━━━━━━━━━━━';

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(createdTime) {
  return createdTime ? new Date(createdTime).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC' : new Date().toISOString();
}

function versionLabel(v) {
  if (v === 'player') return 'Player';
  if (v === 'retro') return 'Retro';
  return 'Fan';
}

function categoryLabel(item) {
  if (item.category) return item.category;
  if (item.version === 'retro') return 'Retro';
  if (item.club || item.team_name) return 'Club';
  return 'National';
}

function itemFields(item, currencySymbol) {
  const price = `${currencySymbol}${Number(item.unit_price || item.price || 0).toFixed(2)}`;
  return {
    name: item.jersey_name || 'Jersey',
    version: versionLabel(item.version),
    size: item.size || 'N/A',
    category: categoryLabel(item),
    season: item.season || 'N/A',
    qty: item.quantity || 1,
    price,
    player: item.name_text || item.player_name || null,
  };
}

function formatNotificationMessage(orderData) {
  const {
    orderId,
    customerName,
    phone,
    email,
    address,
    country,
    total,
    currencySymbol = '€',
    paymentStatus = 'Paid',
    paymentMethod = 'Online',
    createdTime,
    items = []
  } = orderData;

  const productBlocks = items.map((item, idx) => {
    const f = itemFields(item, currencySymbol);
    const header = items.length > 1 ? `📦 Product #${idx + 1}` : '📦 Product';
    let block = `${header}

• Jersey:
${f.name}

• Version:
${f.version}

• Size:
${f.size}

• Category:
${f.category}

• Season:
${f.season}

• Quantity:
${f.qty}

• Price:
${f.price}`;
    if (f.player) block += `

• Player Name:
${f.player}`;
    return block;
  }).join(`\n\n${SEPARATOR}\n\n`);

  return `🛒 NEW ORDER RECEIVED

${SEPARATOR}

${productBlocks}

${SEPARATOR}

👤 Customer

Name:
${customerName || 'N/A'}

Phone:
${phone || 'N/A'}

Email:
${email || 'N/A'}

${SEPARATOR}

📍 Shipping Address

${customerName || 'N/A'}

${address || 'N/A'}

${country || 'N/A'}

${SEPARATOR}

💳 Payment

Method:
${paymentMethod || 'Online'}

Status:
${paymentStatus || 'Paid'}

Order Total:
${currencySymbol}${typeof total === 'number' ? total.toFixed(2) : total}

Order ID:
${orderId}

Date:
${formatTime(createdTime)}

${SEPARATOR}`;
}

function formatNotificationHtml(orderData) {
  const {
    orderId,
    customerName,
    phone,
    email,
    address,
    country,
    total,
    currencySymbol = '€',
    paymentStatus = 'Paid',
    paymentMethod = 'Online',
    createdTime,
    items = []
  } = orderData;

  const productBlocks = items.map((item, idx) => {
    const f = itemFields(item, currencySymbol);
    const header = items.length > 1 ? `📦 Product #${idx + 1}` : '📦 Product';
    let block = `<b>${header}</b>

• Jersey:
${escapeHtml(f.name)}

• Version:
${escapeHtml(f.version)}

• Size:
${escapeHtml(f.size)}

• Category:
${escapeHtml(f.category)}

• Season:
${escapeHtml(f.season)}

• Quantity:
${f.qty}

• Price:
${escapeHtml(f.price)}`;
    if (f.player) block += `

• Player Name:
${escapeHtml(f.player)}`;
    return block;
  }).join(`\n\n${SEPARATOR}\n\n`);

  return `🛒 <b>NEW ORDER RECEIVED</b>

${SEPARATOR}

${productBlocks}

${SEPARATOR}

<b>👤 Customer</b>

Name:
${escapeHtml(customerName || 'N/A')}

Phone:
${escapeHtml(phone || 'N/A')}

Email:
${escapeHtml(email || 'N/A')}

${SEPARATOR}

<b>📍 Shipping Address</b>

${escapeHtml(customerName || 'N/A')}

${escapeHtml(address || 'N/A')}

${escapeHtml(country || 'N/A')}

${SEPARATOR}

<b>💳 Payment</b>

Method:
${escapeHtml(paymentMethod || 'Online')}

Status:
${escapeHtml(paymentStatus || 'Paid')}

Order Total:
${escapeHtml(currencySymbol)}${typeof total === 'number' ? total.toFixed(2) : escapeHtml(total)}

Order ID:
${escapeHtml(orderId)}

Date:
${escapeHtml(formatTime(createdTime))}

${SEPARATOR}`;
}

function shortPhotoCaption(item, currencySymbol) {
  const f = itemFields(item, currencySymbol);
  return `🛒 <b>NEW ORDER RECEIVED</b>\n${escapeHtml(f.name)}\n${escapeHtml(f.version)} • ${escapeHtml(f.size)} • Qty ${f.qty}\n<b>${escapeHtml(f.price)}</b>`;
}

function tgPost(method, body) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/${method}`;
    const data = JSON.stringify(body);
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 20000
    };
    const req = https.request(url, opts, res => {
      let r = '';
      res.on('data', c => r += c);
      res.on('end', () => { try { resolve(JSON.parse(r)); } catch { resolve({ ok: false }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Telegram request timed out')); });
    req.write(data);
    req.end();
  });
}

function isRetryable(result) {
  if (!result.ok) {
    const code = result.error_code;
    if (code === 429 || (code >= 500 && code < 600)) return true;
  }
  return false;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tgCall(method, body) {
  const attempt = async () => {
    try {
      return await tgPost(method, body);
    } catch (err) {
      return { ok: false, networkError: true, description: err.message };
    }
  };
  const first = await attempt();
  if (first.ok) return first;
  if (first.networkError || isRetryable(first)) {
    console.warn(`[Notification] ${method} failed (${first.description || first.error_code}), retrying once...`);
    await sleep(2000);
    return attempt();
  }
  return first;
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    const mod = target.protocol === 'https:' ? https : http;
    const opts = {
      hostname: target.hostname,
      path: target.pathname + target.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': `https://${target.hostname}/`,
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
      timeout: 20000
    };
    const chunks = [];
    const req = mod.get(opts, res => {
      if (res.statusCode !== 200) {
        res.destroy();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Image download timed out')); });
  });
}

function detectMime(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  return 'image/jpeg';
}

async function sendTelegram(orderData) {
  if (!TG_BOT_TOKEN || !TG_CHAT_IDS.length) return false;

  const message = formatNotificationMessage(orderData);
  const html = formatNotificationHtml(orderData);
  const items = orderData.items || [];
  const firstItem = items[0] || {};
  const imgUrl = firstItem.image_url;

  console.log(`[Notification] Image URL: ${imgUrl ? imgUrl.substring(0, 80) + '...' : 'NONE (will send text only)'}`);
  console.log(`[Notification] Caption length: ${html.length} chars`);

  let anySuccess = false;

  for (const chatId of TG_CHAT_IDS) {
    try {
      if (imgUrl) {
        let photoSent = false;
        try {
          console.log(`[Notification] Downloading image for ${firstItem.jersey_name}...`);
          const imgBuffer = await downloadImage(imgUrl);
          const dataUri = `data:${detectMime(imgBuffer)};base64,${imgBuffer.toString('base64')}`;

          // Caption must fit Telegram's 1024-char sendPhoto limit
          const caption = html.length <= 1000 ? html : shortPhotoCaption(firstItem, orderData.currencySymbol || '€');
          const photoResult = await tgCall('sendPhoto', {
            chat_id: chatId,
            photo: dataUri,
            caption,
            parse_mode: 'HTML'
          });
          if (photoResult.ok) {
            console.log(`[Notification] Telegram photo sent to ${chatId}`);
            anySuccess = true;
            photoSent = true;
          } else {
            console.warn(`[Notification] sendPhoto to ${chatId} failed:`, photoResult.description || photoResult.error_code || 'unknown');
          }
        } catch (imgErr) {
          console.warn(`[Notification] Image processing error for ${firstItem.jersey_name}:`, imgErr.message);
        }

        // If the full details didn't fit in the photo caption, send them separately
        if (html.length > 1000 || !photoSent) {
          const msgResult = await tgCall('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML' });
          if (msgResult.ok) {
            console.log(`[Notification] Telegram full details sent to ${chatId}`);
            anySuccess = true;
          } else {
            console.warn(`[Notification] sendMessage to ${chatId} failed:`, msgResult.description || msgResult.error_code || 'unknown');
          }
        }
      } else {
        // No image URL → fallback to sendMessage
        const msgResult = await tgCall('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML' });
        if (msgResult.ok) {
          console.log(`[Notification] Telegram message sent to ${chatId} (no image)`);
          anySuccess = true;
        } else {
          console.warn(`[Notification] sendMessage to ${chatId} failed:`, msgResult.description || msgResult.error_code || 'unknown');
        }
      }
    } catch (err) {
      console.warn(`[Notification] Telegram to ${chatId} error:`, err.message);
    }
  }
  return anySuccess;
}

async function sendWhatsApp(message) {
  if (!client || !FROM_WHATSAPP) return false;
  let anySuccess = false;
  for (const num of TO_NUMBERS) {
    try {
      const target = num.startsWith('whatsapp:') ? num : `whatsapp:${num}`;
      await client.messages.create({
        body: message,
        from: FROM_WHATSAPP,
        to: target,
      });
      console.log(`[Notification] WhatsApp sent to ${target}`);
      anySuccess = true;
    } catch (err) {
      console.warn(`[Notification] WhatsApp to ${num} failed:`, err.message);
    }
  }
  return anySuccess;
}

async function sendSMS(message) {
  if (!client || !FROM_SMS) return false;
  let anySuccess = false;
  for (const num of TO_NUMBERS) {
    try {
      await client.messages.create({
        body: message,
        from: FROM_SMS,
        to: num,
      });
      console.log(`[Notification] SMS sent to ${num}`);
      anySuccess = true;
    } catch (err) {
      console.warn(`[Notification] SMS to ${num} failed:`, err.message);
    }
  }
  return anySuccess;
}

async function notifyOrder(orderData) {
  if (!orderData || !orderData.orderId) {
    console.warn('[Notification] Invalid orderData:', orderData);
    return;
  }

  const orderIdKey = String(orderData.orderId);
  if (notifiedOrders.has(orderIdKey)) {
    console.log(`[Notification] Order #${orderIdKey} already notified. Skipping.`);
    return;
  }
  notifiedOrders.add(orderIdKey);

  const message = formatNotificationMessage(orderData);
  console.log(`\n--- [ORDER NOTIFICATION - ORD-${orderIdKey}] ---`);
  console.log(message);
  console.log('-----------------------------------------------\n');

  // Priority 1: Telegram (free) — sendPhoto with image + full caption
  const tgSuccess = await sendTelegram(orderData);
  console.log(`[Notification] Telegram result for ORD-${orderIdKey}: ${tgSuccess ? 'SENT' : 'FAILED (no channel configured or all failed)'}`);
  if (tgSuccess) return;

  // Priority 2: WhatsApp (paid)
  console.log('[Notification] Falling back to WhatsApp...');
  const waSuccess = await sendWhatsApp(message);
  console.log(`[Notification] WhatsApp result: ${waSuccess ? 'SENT' : 'FAILED'}`);
  if (waSuccess) return;

  // Priority 3: SMS (paid)
  console.log('[Notification] Falling back to SMS...');
  await sendSMS(message);
  console.log('[Notification] SMS attempted');
}

module.exports = { notifyOrder, formatNotificationMessage };