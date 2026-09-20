const https = require('https');
const http = require('http');

// Resend config (free — 100 emails/day)
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'JRZEES <orders@jrzees.com>';
let resend = null;
if (RESEND_API_KEY && RESEND_API_KEY.startsWith('re_')) {
  try {
    const { Resend } = require('resend');
    resend = new Resend(RESEND_API_KEY);
    console.log('[Email] Resend initialized ✓');
  } catch (err) {
    console.error('[Email] Resend init failed:', err.message);
  }
} else {
  console.log('[Email] RESEND_API_KEY not set — customer emails disabled');
}

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

function shortPhotoCaption(item, currencySymbol, index, total) {
  const f = itemFields(item, currencySymbol);
  const label = total > 1 ? ` (${index + 1}/${total})` : '';
  return `🛒 NEW ORDER RECEIVED${label}\n${f.name}\n${f.version} • ${f.size} • Qty ${f.qty}\n${f.price}`;
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

async function tgCall(action) {
  const attempt = async () => {
    try {
      return await action();
    } catch (err) {
      return { ok: false, networkError: true, description: err.message };
    }
  };
  const first = await attempt();
  if (first.ok) return first;
  if (first.networkError || isRetryable(first)) {
    console.warn(`[Notification] Telegram request failed (${first.description || first.error_code}), retrying once...`);
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

function tgUploadPhoto(chatId, imageBuffer, mimeType, caption) {
  return new Promise((resolve, reject) => {
    const boundary = '----KickoffJerseys' + Math.random().toString(16).slice(2);
    const CRLF = '\r\n';
    const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/gif' ? 'gif' : 'jpg';
    const parts = [
      `--${boundary}${CRLF}`,
      `Content-Disposition: form-data; name="chat_id"${CRLF}${CRLF}`,
      `${chatId}${CRLF}`,
      `--${boundary}${CRLF}`,
      `Content-Disposition: form-data; name="caption"${CRLF}${CRLF}`,
      `${caption}${CRLF}`,
      `--${boundary}${CRLF}`,
      `Content-Disposition: form-data; name="photo"; filename="jersey.${extension}"${CRLF}`,
      `Content-Type: ${mimeType}${CRLF}${CRLF}`,
    ];
    const header = Buffer.from(parts.join(''), 'utf8');
    const footer = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');
    const body = Buffer.concat([header, imageBuffer, footer]);

    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 30000
    };
    const req = https.request(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, opts, res => {
      let r = '';
      res.on('data', c => r += c);
      res.on('end', () => { try { resolve(JSON.parse(r)); } catch { resolve({ ok: false }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Telegram upload timed out')); });
    req.write(body);
    req.end();
  });
}

async function sendTelegram(orderData) {
  if (!TG_BOT_TOKEN || !TG_CHAT_IDS.length) return false;

  const message = formatNotificationMessage(orderData);
  const items = orderData.items || [];
  const imageItems = items.filter(item => item.image_url);

  console.log(`[Notification] Images to send: ${imageItems.length} of ${items.length} items`);

  let anySuccess = false;

  for (const chatId of TG_CHAT_IDS) {
    try {
      // 1) Send the full details as plain-text FIRST so the owner is notified instantly.
      //    No parse_mode → can never fail due to entity/HTML parsing.
      const msgResult = await tgCall(() => tgPost('sendMessage', { chat_id: chatId, text: message }));
      if (msgResult.ok) {
        console.log(`[Notification] Telegram details sent to ${chatId}`);
        anySuccess = true;
      } else {
        console.warn(`[Notification] sendMessage to ${chatId} failed:`, msgResult.description || msgResult.error_code || 'unknown');
      }

      // 2) Then attach an image for EVERY ordered jersey via multipart upload.
      //    NOTE: Telegram does NOT accept data: URIs — must upload raw bytes.
      for (let i = 0; i < imageItems.length; i++) {
        const item = imageItems[i];
        try {
          console.log(`[Notification] Downloading image for ${item.jersey_name}...`);
          const imgBuffer = await downloadImage(item.image_url);
          const mime = detectMime(imgBuffer);
          const caption = shortPhotoCaption(item, orderData.currencySymbol || '€', i, imageItems.length);
          const photoResult = await tgCall(() => tgUploadPhoto(chatId, imgBuffer, mime, caption));
          if (photoResult.ok) {
            console.log(`[Notification] Telegram image sent to ${chatId} for ${item.jersey_name}`);
          } else {
            console.warn(`[Notification] sendPhoto to ${chatId} failed for ${item.jersey_name}:`, photoResult.description || photoResult.error_code || 'unknown');
          }
        } catch (imgErr) {
          console.warn(`[Notification] Image processing error for ${item.jersey_name}:`, imgErr.message);
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

const customerEmailedOrders = new Set();

function customerOrderEmailHtml(orderData) {
  const {
    orderId,
    customerName,
    items = [],
    subtotal,
    deliveryFee = 5,
    namePrintingFee = 0,
    total,
    currencySymbol = '€',
    paymentMethod = 'Online',
    paymentStatus = 'Paid',
    address,
    country,
    createdTime,
  } = orderData;

  const itemRows = items.map((item, idx) => {
    const f = itemFields(item, currencySymbol);
    return `
      <tr>
        <td style="padding:14px 16px;border-bottom:1px solid #1f1f1f;font-size:14px;color:#e0e0e0;vertical-align:top;">
          <strong style="color:#ffffff;font-size:15px;">${f.name}</strong><br>
          <span style="color:#9ca3af;font-size:12px;line-height:1.6;">${f.version} · Size: <span style="color:#ffffff;font-weight:600;">${f.size}</span> · Qty: ${f.qty}</span>
          ${f.player ? `<br><span style="color:#b3f000;font-size:12px;font-weight:600;">Custom Print: ${f.player}</span>` : ''}
        </td>
        <td style="padding:14px 16px;border-bottom:1px solid #1f1f1f;text-align:right;font-family:'Courier New',monospace;font-size:14px;color:#ffffff;white-space:nowrap;vertical-align:top;">
          ${f.price}
        </td>
      </tr>`;
  }).join('');

  const formattedDate = createdTime ? new Date(createdTime).toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC' : new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const subtotalVal = typeof subtotal === 'number' ? subtotal : (Number(total) - Number(deliveryFee || 0) - Number(namePrintingFee || 0));

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Receipt ORD-${orderId} - JRZEES</title>
</head>
<body style="margin:0;padding:0;background-color:#050505;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#f3f4f6;">
  <div style="max-width:620px;margin:30px auto;background-color:#0d0d0d;border:1px solid rgba(255,255,255,0.08);border-radius:14px;overflow:hidden;box-shadow:0 20px 40px rgba(0,0,0,0.6);">

    <!-- Branded Header -->
    <div style="background:linear-gradient(135deg,#0a0a0a,#161616);padding:36px 28px;text-align:center;border-bottom:2px solid #b3f000;">
      <h1 style="margin:0;font-size:30px;font-weight:900;color:#ffffff;letter-spacing:3px;text-transform:uppercase;">JRZEES</h1>
      <p style="margin:8px 0 0;color:#b3f000;font-size:13px;letter-spacing:3px;font-weight:700;text-transform:uppercase;">Official Order Receipt</p>
    </div>

    <!-- Thank You & Intro -->
    <div style="padding:32px 28px;">
      <div style="background:rgba(179,240,0,0.06);border:1px solid rgba(179,240,0,0.25);border-radius:10px;padding:18px 20px;margin-bottom:28px;">
        <h2 style="margin:0 0 6px;font-size:18px;color:#b3f000;font-weight:700;">Thank You for Shopping with Us!</h2>
        <p style="margin:0;color:#d1d5db;font-size:14px;line-height:1.5;">
          Hey <strong style="color:#ffffff;">${customerName || 'Valued Customer'}</strong>, your order has been received and verified. Below is your official itemized receipt.
        </p>
      </div>

      <!-- Receipt Metadata Grid -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;background:#141414;border-radius:8px;overflow:hidden;">
        <tr>
          <td style="padding:14px 16px;border-bottom:1px solid #222;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;">Order Reference</td>
          <td style="padding:14px 16px;border-bottom:1px solid #222;text-align:right;font-family:'Courier New',monospace;font-size:15px;color:#b3f000;font-weight:bold;">ORD-${orderId}</td>
        </tr>
        <tr>
          <td style="padding:14px 16px;border-bottom:1px solid #222;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;">Date & Time</td>
          <td style="padding:14px 16px;border-bottom:1px solid #222;text-align:right;font-size:13px;color:#ffffff;">${formattedDate}</td>
        </tr>
        <tr>
          <td style="padding:14px 16px;border-bottom:1px solid #222;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;">Payment Method</td>
          <td style="padding:14px 16px;border-bottom:1px solid #222;text-align:right;font-size:13px;color:#ffffff;">${paymentMethod === 'COD' ? 'Cash on Delivery (COD)' : (paymentMethod || 'Online Payment')}</td>
        </tr>
        <tr>
          <td style="padding:14px 16px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;">Payment Status</td>
          <td style="padding:14px 16px;text-align:right;font-size:13px;color:#10b981;font-weight:bold;text-transform:uppercase;">${paymentStatus}</td>
        </tr>
      </table>

      <!-- Itemized Items Table -->
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:2px;color:#9ca3af;font-weight:700;margin-bottom:10px;">Purchased Items</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;background:#121212;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#1a1a1a;">
            <th style="padding:10px 16px;text-align:left;color:#9ca3af;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Item Description</th>
            <th style="padding:10px 16px;text-align:right;color:#9ca3af;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Price</th>
          </tr>
        </thead>
        <tbody>
          ${itemRows}
        </tbody>
      </table>

      <!-- Financial Breakdown -->
      <div style="background:#141414;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="color:#9ca3af;font-size:13px;padding:6px 0;">Subtotal</td>
            <td style="text-align:right;color:#ffffff;font-size:13px;padding:6px 0;font-family:'Courier New',monospace;">${currencySymbol}${Number(subtotalVal > 0 ? subtotalVal : 0).toFixed(2)}</td>
          </tr>
          <tr>
            <td style="color:#9ca3af;font-size:13px;padding:6px 0;">Delivery / Shipping Fee</td>
            <td style="text-align:right;color:#ffffff;font-size:13px;padding:6px 0;font-family:'Courier New',monospace;">${currencySymbol}${Number(deliveryFee).toFixed(2)}</td>
          </tr>
          ${Number(namePrintingFee) > 0 ? `
          <tr>
            <td style="color:#9ca3af;font-size:13px;padding:6px 0;">Custom Player Name Printing</td>
            <td style="text-align:right;color:#ffffff;font-size:13px;padding:6px 0;font-family:'Courier New',monospace;">${currencySymbol}${Number(namePrintingFee).toFixed(2)}</td>
          </tr>` : ''}
          <tr style="border-top:1px solid #282828;">
            <td style="color:#ffffff;font-size:18px;font-weight:bold;padding:14px 0 4px;">Grand Total Paid</td>
            <td style="text-align:right;color:#b3f000;font-size:20px;font-weight:900;padding:14px 0 4px;font-family:'Courier New',monospace;">${currencySymbol}${typeof total === 'number' ? total.toFixed(2) : total}</td>
          </tr>
        </table>
      </div>

      <!-- Shipping Address -->
      <div style="background:#141414;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
        <span style="color:#9ca3af;font-size:11px;text-transform:uppercase;letter-spacing:2px;font-weight:bold;">Delivery Address</span>
        <p style="color:#e5e7eb;font-size:14px;margin:8px 0 0;line-height:1.6;">
          <strong style="color:#ffffff;">${customerName || 'Customer'}</strong><br>
          ${address || 'Address provided on file'}<br>
          ${country || ''}
        </p>
      </div>

      <p style="color:#9ca3af;font-size:13px;line-height:1.6;margin:0;text-align:center;">
        Questions about your order? Simply reply directly to this email for customer support.
      </p>
    </div>

    <!-- Footer -->
    <div style="padding:22px 28px;border-top:1px solid #1a1a1a;text-align:center;background:#0a0a0a;">
      <p style="color:#6b7280;font-size:11px;margin:0;letter-spacing:1.5px;text-transform:uppercase;">
        JRZEES Football Kits — Verified Premium Quality
      </p>
    </div>
  </div>
</body>
</html>`;
}

async function sendCustomerEmail(orderData) {
  if (!resend || !orderData.email) return false;

  const orderIdKey = String(orderData.orderId);
  if (customerEmailedOrders.has(orderIdKey)) {
    console.log(`[Email] Receipt already sent to customer for order #${orderIdKey}. Skipping duplicate.`);
    return true;
  }

  const html = customerOrderEmailHtml(orderData);
  const subject = `Order Confirmed & Receipt — ORD-${orderData.orderId} | JRZEES`;

  const isDomainError = (result) => {
    if (!result) return false;
    const err = result.error;
    if (!err) return false;
    return err.statusCode === 403 || err.name === 'validation_error' ||
      (err.message && (err.message.toLowerCase().includes('domain') || err.message.toLowerCase().includes('not verified')));
  };

  let primaryResult = null;
  try {
    primaryResult = await resend.emails.send({
      from: EMAIL_FROM,
      to: orderData.email,
      subject,
      html,
    });
  } catch (err) {
    console.warn(`[Email] Primary send exception: ${err.message}`);
    primaryResult = { error: { message: err.message, name: 'send_exception', statusCode: 500 } };
  }

  if (primaryResult && primaryResult.data && primaryResult.data.id) {
    customerEmailedOrders.add(orderIdKey);
    console.log(`[Email] Customer receipt sent to ${orderData.email} (id: ${primaryResult.data.id})`);
    return true;
  }

  // Attempt fallback if it's a domain/validation problem
  if (isDomainError(primaryResult)) {
    console.warn(`[Email] Domain not verified for "${EMAIL_FROM}" — trying fallback sender onboarding@resend.dev...`);
    try {
      const fallbackResult = await resend.emails.send({
        from: 'JRZEES <onboarding@resend.dev>',
        to: orderData.email,
        subject,
        html,
      });
      if (fallbackResult && fallbackResult.data && fallbackResult.data.id) {
        customerEmailedOrders.add(orderIdKey);
        console.log(`[Email] Customer receipt sent via fallback to ${orderData.email} (id: ${fallbackResult.data.id})`);
        return true;
      }
      console.warn('[Email] Fallback also returned no id:', JSON.stringify(fallbackResult));
    } catch (fbErr) {
      console.error('[Email] Fallback send exception:', fbErr.message);
    }

    // Always send a copy of the receipt to store owner so it is never missed
    try {
      await resend.emails.send({
        from: 'JRZEES <onboarding@resend.dev>',
        to: 'kickoffjersey4@gmail.com',
        subject: `[Admin Receipt] ORD-${orderData.orderId} - ${orderData.customerName || 'Customer'} (${orderData.email})`,
        html: `<div style="background:#fef3c7;color:#92400e;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-family:sans-serif;font-size:14px;"><strong>Notice:</strong> To send receipts directly to customer addresses, verify <strong>jrzees.com</strong> at <a href="https://resend.com/domains">resend.com/domains</a>.</div>` + html,
      });
      console.log(`[Email] Backup receipt sent to store owner (kickoffjersey4@gmail.com) for order #${orderIdKey}`);
    } catch (adminErr) {
      console.warn('[Email] Could not send backup to store owner:', adminErr.message);
    }
  } else {
    console.warn('[Email] Resend returned error (non-domain):', JSON.stringify(primaryResult));
  }
  return false;
}

module.exports = { notifyOrder, formatNotificationMessage, sendCustomerEmail };