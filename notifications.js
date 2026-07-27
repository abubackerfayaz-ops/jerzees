const https = require('https');
const twilio = require('twilio');

// Telegram config (free)
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

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
    client = twilio(ACCOUNT_SID, AUTH_TOKEN);
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

function tgRequest(path) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}${path}`;
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); }
      });
    }).on('error', reject);
  });
}

async function sendTelegram(message) {
  if (!TG_BOT_TOKEN || !TG_CHAT_IDS.length) return false;
  let anySuccess = false;
  for (const chatId of TG_CHAT_IDS) {
    try {
      const text = encodeURIComponent(message);
      const result = await tgRequest(`/sendMessage?chat_id=${chatId}&text=${text}`);
      if (result.ok) {
        console.log(`[Notification] Telegram sent to chat ${chatId}`);
        anySuccess = true;
      } else {
        console.warn(`[Notification] Telegram to ${chatId} failed:`, result.description || 'unknown');
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
  if (!orderData || !orderData.orderId) return;

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

  // Priority 1: Telegram (free)
  const tgSuccess = await sendTelegram(message);
  if (tgSuccess) return;

  // Priority 2: WhatsApp (paid)
  const waSuccess = await sendWhatsApp(message);
  if (waSuccess) return;

  // Priority 3: SMS (paid)
  await sendSMS(message);
}

module.exports = { notifyOrder, formatNotificationMessage };
