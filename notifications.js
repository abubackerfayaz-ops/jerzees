const twilio = require('twilio');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_SMS = process.env.TWILIO_PHONE_NUMBER;
const FROM_WHATSAPP = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
const TO_NUMBER = process.env.NOTIFY_PHONE || '+8613418092985';

let client = null;
if (ACCOUNT_SID && AUTH_TOKEN && !ACCOUNT_SID.includes('XXXXX')) {
  try {
    client = twilio(ACCOUNT_SID, AUTH_TOKEN);
  } catch (err) {
    console.error('Twilio initialization failed:', err.message);
  }
}

// Track sent order IDs to prevent duplicate notifications
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
Quantity: ${item.quantity}
Player Name: ${playerName}`;
  }).join('\n\n');

  const formattedTime = createdTime ? new Date(createdTime).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC' : new Date().toISOString();

  return `NEW ORDER RECEIVED

Order ID: ORD-${orderId}
Order Time: ${formattedTime}

Customer:
${customerName || 'N/A'}

Phone:
${phone || 'N/A'}

Email:
${email || 'N/A'}

Country:
${country || 'N/A'}

Address:
${address || 'N/A'}

${itemDetails}

Total:
${currencySymbol}${typeof total === 'number' ? total.toFixed(2) : total}

Payment:
${paymentStatus || 'Paid'}`;
}

async function sendWhatsApp(message) {
  if (!client || !FROM_WHATSAPP) return false;
  try {
    const target = TO_NUMBER.startsWith('whatsapp:') ? TO_NUMBER : `whatsapp:${TO_NUMBER}`;
    await client.messages.create({
      body: message,
      from: FROM_WHATSAPP,
      to: target,
    });
    console.log(`[Notification] WhatsApp notification sent to ${target}`);
    return true;
  } catch (err) {
    console.warn('[Notification] WhatsApp sending standard check (credentials/opt-in needed):', err.message);
    return false;
  }
}

async function sendSMS(message) {
  if (!client || !FROM_SMS) return false;
  try {
    await client.messages.create({
      body: message,
      from: FROM_SMS,
      to: TO_NUMBER,
    });
    console.log(`[Notification] SMS notification sent to ${TO_NUMBER}`);
    return true;
  } catch (err) {
    console.warn('[Notification] SMS sending standard check (credentials needed):', err.message);
    return false;
  }
}

async function notifyOrder(orderData) {
  if (!orderData || !orderData.orderId) return;

  const orderIdKey = String(orderData.orderId);
  if (notifiedOrders.has(orderIdKey)) {
    console.log(`[Notification] Order #${orderIdKey} notification already sent. Skipping duplicate.`);
    return;
  }
  notifiedOrders.add(orderIdKey);

  const message = formatNotificationMessage(orderData);
  console.log('\n--- [ORDER NOTIFICATION PAYLOAD SENT TO +86 134 1809 2985] ---');
  console.log(message);
  console.log('-------------------------------------------------------------------\n');

  // Priority 1: WhatsApp Business API / Twilio WhatsApp
  const waSuccess = await sendWhatsApp(message);
  if (!waSuccess) {
    // Priority 2: SMS API
    await sendSMS(message);
  }
}

module.exports = { notifyOrder, formatNotificationMessage };
