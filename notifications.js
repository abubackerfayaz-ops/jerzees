const twilio = require('twilio');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_SMS = process.env.TWILIO_PHONE_NUMBER;
const FROM_WHATSAPP = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
const TO_NUMBER = process.env.NOTIFY_PHONE || '+8613418092985';

let client = null;
if (ACCOUNT_SID && AUTH_TOKEN) {
  client = twilio(ACCOUNT_SID, AUTH_TOKEN);
}

function formatItems(items) {
  return items.map(i =>
    `  • ${i.quantity}x ${i.jersey_name || 'Jersey'} (${i.version}, ${i.size})${i.name_text ? ` - Print: ${i.name_text}` : ''}`
  ).join('\n');
}

async function sendSMS(orderId, customerName, total, items) {
  if (!client || !FROM_SMS) return;
  try {
    await client.messages.create({
      body: `[KICKOFF JERSEYS] New Order #${orderId}\nCustomer: ${customerName}\nTotal: $${total.toFixed(2)}\nItems:\n${formatItems(items)}`,
      from: FROM_SMS,
      to: TO_NUMBER,
    });
    console.log(`SMS notification sent for order #${orderId}`);
  } catch (err) {
    console.error('SMS notification failed:', err.message);
  }
}

async function sendWhatsApp(orderId, customerName, total, items) {
  if (!client) return;
  try {
    await client.messages.create({
      body: `⚽ *New Order Received* – KICKOFF JERSEYS\n\n*Order #${orderId}*\n*Customer:* ${customerName}\n*Total:* $${total.toFixed(2)}\n\n*Items:*\n${formatItems(items)}\n\nCheck admin panel for details.`,
      from: FROM_WHATSAPP,
      to: `whatsapp:${TO_NUMBER}`,
    });
    console.log(`WhatsApp notification sent for order #${orderId}`);
  } catch (err) {
    console.error('WhatsApp notification failed:', err.message);
  }
}

async function notifyOrder(orderId, customerName, total, items) {
  await Promise.allSettled([
    sendSMS(orderId, customerName, total, items),
    sendWhatsApp(orderId, customerName, total, items),
  ]);
}

module.exports = { notifyOrder };
