const https = require('https');

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
    createdTime,
    items = []
  } = orderData;

  const itemDetails = items.map((item, idx) => {
    const versionLabel = item.version === 'player' ? 'Player Version' : (item.version === 'retro' ? 'Retro Version' : 'Fan Version');
    const club = item.club || item.team_name || 'N/A';
    const season = item.season || 'N/A';
    const playerName = item.name_text || item.player_name || 'None';
    return `Product${items.length > 1 ? ` #${idx + 1}` : ''}:
${item.jersey_name || 'Jersey'}
Club: ${club}
Season: ${season}
Type: ${versionLabel}
Size: ${item.size}
Qty: ${item.quantity}
Player Name: ${playerName}`;
  }).join('\n\n');

  const formattedTime = createdTime ? new Date(createdTime).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC' : new Date().toISOString();

  return `NEW ORDER RECEIVED

Order ID: ORD-${orderId}
Order Time: ${formattedTime}

Customer: ${customerName || 'N/A'}
Phone: ${phone || 'N/A'}
Email: ${email || 'N/A'}
Country: ${country || 'N/A'}
Address: ${address || 'N/A'}

${itemDetails}

Total: ${currencySymbol}${typeof total === 'number' ? total.toFixed(2) : total}
Payment: ${paymentStatus || 'Paid'}`;
}

function tgPost(method, body) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/${method}`;
    const data = JSON.stringify(body);
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000
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

async function sendTelegram(message, items = []) {
  if (!TG_BOT_TOKEN || !TG_CHAT_IDS.length) return false;
  let anySuccess = false;
  for (const chatId of TG_CHAT_IDS) {
    try {
      // Send text message first
      const msgResult = await tgPost('sendMessage', { chat_id: chatId, text: message });
      if (msgResult.ok) {
        console.log(`[Notification] Telegram message sent to ${chatId}`);
        anySuccess = true;
      } else {
        console.warn(`[Notification] Telegram message to ${chatId} failed:`, msgResult.description || 'unknown');
      }

      // Then try sending each jersey image (independent, best-effort)
      for (const item of items) {
        const imgUrl = item.image_url;
        if (!imgUrl) continue;
        try {
          const caption = `${item.jersey_name || 'Jersey'} — ${item.club || ''} ${item.season || ''} (${item.size}, Qty: ${item.quantity})`.substring(0, 1024);
          const photoResult = await tgPost('sendPhoto', {
            chat_id: chatId,
            photo: imgUrl,
            caption
          });
          if (photoResult.ok) {
            console.log(`[Notification] Telegram image sent to ${chatId} for ${item.jersey_name}`);
          } else {
            console.warn(`[Notification] Telegram photo to ${chatId} failed:`, photoResult.description || 'unknown');
          }
        } catch (imgErr) {
          console.warn(`[Notification] Telegram photo error for ${chatId}:`, imgErr.message);
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

  // Priority 1: Telegram (free) — send images + message
  const items = orderData.items || [];
  const tgSuccess = await sendTelegram(message, items);
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