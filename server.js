require('dotenv').config({ path: __dirname + '/.env' });

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const db = require('./database');

let stripe = null;
if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith('sk_')) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}
const { notifyOrder } = require('./notifications');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());

// Stripe webhook must receive raw body for signature verification (before express.json)
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payment not configured' });
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata?.order_id;
    if (orderId) {
      await db.query(
        `UPDATE orders SET payment_status = 'paid', status = 'confirmed', payment_method = 'stripe', updated_at = NOW()
         WHERE id = $1`,
        [orderId]
      );
      console.log(`Order #${orderId} marked as paid via Stripe.`);

      // Send SMS & WhatsApp notification
      try {
        const order = await db.get(
          `SELECT o.*, c.name as customer_name
           FROM orders o LEFT JOIN customers c ON o.customer_id = c.id
           WHERE o.id = $1`,
          [orderId]
        );
        if (order) {
          const items = await db.all(
            `SELECT oi.*, j.name as jersey_name
             FROM order_items oi JOIN jerseys j ON oi.jersey_id = j.id
             WHERE oi.order_id = $1`,
            [orderId]
          );
          notifyOrder(order.id, order.customer_name, order.total, items);
        }
      } catch (notifErr) {
        console.error('Order notification error:', notifErr.message);
      }
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Simple session middleware
app.use((req, res, next) => {
  let sessionId = req.headers['x-session-id'];
  if (!sessionId) {
    sessionId = crypto.randomUUID();
  }
  req.sessionId = sessionId;
  res.setHeader('X-Session-Id', sessionId);
  next();
});

// Auth middleware: verifies JWT from Authorization header
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Admin middleware: verifies JWT and is_admin flag
function adminRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    if (!decoded.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Optional auth: attaches user if token present, continues regardless
function authOptional(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice(7), JWT_SECRET);
    } catch { /* token invalid, continue without user */ }
  }
  next();
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await db.get('SELECT id FROM customers WHERE email = $1', [email]);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const hash = await bcrypt.hash(password, 10);
    const c = await db.query(
      'INSERT INTO customers (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, is_admin, created_at',
      [name, email, hash]
    );
    const user = c.rows[0];
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ success: true, user, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await db.get('SELECT * FROM customers WHERE email = $1', [email]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.password_hash) {
      return res.status(401).json({ error: 'This account uses a legacy login method. Please register again.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin, created_at: user.created_at }, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.json({ success: true });
});

app.get('/api/auth/me', authOptional, async (req, res) => {
  try {
    if (!req.user) {
      return res.json({ user: null, orders: [] });
    }

    const user = await db.get('SELECT id, name, email, is_admin, created_at FROM customers WHERE id = $1', [req.user.id]);
    if (!user) {
      return res.json({ user: null, orders: [] });
    }

    const orders = await db.all(
      `SELECT o.*, 
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
       FROM orders o 
       WHERE o.customer_id = $1 
       ORDER BY o.created_at DESC`,
      [user.id]
    );

    res.json({ user, orders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Auth query error' });
  }
});

// ─── STRIPE ──────────────────────────────────────────────────────────────────

// Return public Stripe key to frontend
app.get('/api/stripe-config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '', configured: !!stripe });
});

// Create Stripe Checkout Session for a new order
app.post('/api/create-checkout-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured. Use the legacy checkout endpoint /api/orders instead.' });
  try {
    const { customer_name, email, phone, address, notes, items } = req.body;
    if (!customer_name || !email || !address || !items || !items.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Resolve variants and compute totals
    let subtotal = 0;
    let namePrintingCount = 0;
    const lineItems = [];

    for (const item of items) {
      const variant = await db.get(
        'SELECT * FROM variants WHERE jersey_id = $1 AND version = $2 AND size = $3 AND active = 1',
        [item.jersey_id, item.version, item.size]
      );
      if (!variant) return res.status(400).json({ error: `Variant not found for jersey ${item.jersey_id}` });
      if (variant.stock < item.quantity) return res.status(400).json({ error: `Insufficient stock for ${item.version} - ${item.size}` });

      item.variant_id = variant.id;
      item.price = variant.price;
      subtotal += variant.price * item.quantity;
      if (item.name_text && item.name_text.trim()) namePrintingCount++;

      // Fetch jersey name for the product description
      const jersey = await db.get('SELECT name FROM jerseys WHERE id = $1', [item.jersey_id]);

      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: jersey ? jersey.name : 'Jersey',
            description: `${item.version} fit - Size ${item.size}${item.name_text ? ` (Print: ${item.name_text})` : ''}`,
          },
          unit_amount: Math.round((variant.price + (item.name_text ? 5 : 0)) * 100), // cents
        },
        quantity: item.quantity,
      });
    }

    const deliveryFee = 5;
    const namePrintFee = namePrintingCount * 5;
    const total = subtotal + deliveryFee + namePrintFee;

    // Add delivery as a line item
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: { name: 'Flat Delivery Fee' },
        unit_amount: deliveryFee * 100,
      },
      quantity: 1,
    });

    // Create or find customer
    let customer = await db.get('SELECT id FROM customers WHERE email = $1', [email]);
    if (!customer) {
      const c = await db.query(
        'INSERT INTO customers (name, email, phone) VALUES ($1, $2, $3) RETURNING id',
        [customer_name, email, phone || null]
      );
      customer = c.rows[0];
    }

    // Create address
    const addr = await db.query(
      `INSERT INTO addresses (customer_id, label, street, city, country, is_default)
       VALUES ($1, 'Shipping', $2, '', 'US', 1) RETURNING id`,
      [customer.id, address]
    );

    // Create order (status: pending, unpaid)
    const orderRes = await db.query(
      `INSERT INTO orders (customer_id, email, phone, shipping_address_id, notes, subtotal, delivery_fee, name_printing_fee, total, status, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 'unpaid') RETURNING id`,
      [customer.id, email, phone || null, addr.rows[0].id, notes || null, subtotal, deliveryFee, namePrintFee, total]
    );
    const orderId = orderRes.rows[0].id;

    // Insert order items and decrement stock
    for (const item of items) {
      await db.query(
        `INSERT INTO order_items (order_id, jersey_id, variant_id, size, version, name_text, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orderId, item.jersey_id, item.variant_id, item.size, item.version, item.name_text || null, item.quantity, item.price]
      );
      await db.query('UPDATE variants SET stock = stock - $1 WHERE id = $2', [item.quantity, item.variant_id]);
    }

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      metadata: { order_id: orderId },
      line_items: lineItems,
      success_url: `${BASE_URL}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?checkout=cancel`,
    });

    // Store Stripe session ID on the order
    await db.query('UPDATE orders SET stripe_session_id = $1 WHERE id = $2', [session.id, orderId]);

    res.json({ url: session.url, session_id: session.id, order_id: orderId });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ─── TEAMS ───────────────────────────────────────────────────────────────────

app.get('/api/teams', async (req, res) => {
  try {
    const teams = await db.all(
      `SELECT t.*, (SELECT COUNT(*) FROM jerseys WHERE team_id = t.id) as jersey_count
       FROM teams t ORDER BY t.name`
    );
    res.json(teams);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/teams/:slug', async (req, res) => {
  try {
    const team = await db.get(
      `SELECT t.*, (SELECT COUNT(*) FROM jerseys WHERE team_id = t.id) as jersey_count
       FROM teams t WHERE t.slug = $1 OR t.id = $2`,
      [req.params.slug, req.params.slug]
    );
    if (!team) return res.status(404).json({ error: 'Team not found' });
    res.json(team);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── JERSEYS ─────────────────────────────────────────────────────────────────

app.get('/api/jerseys', async (req, res) => {
  try {
    const { team_id, featured, type, search } = req.query;
    let sql = `
      SELECT j.*, t.name as team_name, t.slug as team_slug,
        (SELECT MIN(price) FROM variants WHERE jersey_id = j.id AND active = 1) as price_from,
        (SELECT MAX(price) FROM variants WHERE jersey_id = j.id AND active = 1) as price_to,
        (SELECT image_url FROM jersey_images WHERE jersey_id = j.id ORDER BY sort_order LIMIT 1) as image_url
      FROM jerseys j JOIN teams t ON j.team_id = t.id
    `;
    const params = [];
    const conditions = [];

    if (team_id) {
      conditions.push(`j.team_id = $${params.length + 1}`);
      params.push(team_id);
    }
    if (featured) {
      conditions.push('j.featured = 1');
    }
    if (type) {
      conditions.push(`j.type = $${params.length + 1}`);
      params.push(type);
    }
    if (search) {
      conditions.push(`(j.name ILIKE $${params.length + 1} OR t.name ILIKE $${params.length + 1})`);
      params.push(`%${search}%`);
    }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY j.featured DESC, t.name, j.name';

    const jerseys = await db.all(sql, params);

    const result = jerseys.map(j => ({
      ...j,
      version_fan: j.price_from || 20,
      version_player: 23,
      version_retro: 25,
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/jerseys/:id', async (req, res) => {
  try {
    const jersey = await db.get(
      `SELECT j.*, t.name as team_name, t.slug as team_slug,
        (SELECT MIN(price) FROM variants WHERE jersey_id = j.id AND active = 1) as price_from,
        (SELECT MAX(price) FROM variants WHERE jersey_id = j.id AND active = 1) as price_to
       FROM jerseys j JOIN teams t ON j.team_id = t.id
       WHERE j.id = $1`,
      [req.params.id]
    );
    if (!jersey) return res.status(404).json({ error: 'Jersey not found' });

    const images = await db.all(
      'SELECT * FROM jersey_images WHERE jersey_id = $1 ORDER BY sort_order',
      [jersey.id]
    );

    const variants = await db.all(
      'SELECT * FROM variants WHERE jersey_id = $1 AND active = 1 ORDER BY version, size',
      [jersey.id]
    );

    const versionPrices = {};
    const sizeMap = {};
    const sizeSet = new Set();
    for (const v of variants) {
      versionPrices[v.version] = v.price;
      sizeSet.add(v.size);
      if (!sizeMap[v.version]) sizeMap[v.version] = [];
      sizeMap[v.version].push(v.size);
    }

    res.json({
      ...jersey,
      version_fan: versionPrices.fan || 20,
      version_player: versionPrices.player || 23,
      version_retro: versionPrices.retro || 25,
      image_url: images.length ? images[0].image_url : null,
      images,
      variants,
      sizes: [...sizeSet].sort(),
      size_map: sizeMap,
      stock: variants.reduce((acc, v) => { acc[v.id] = v.stock; return acc; }, {})
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── VARIANTS ────────────────────────────────────────────────────────────────

app.get('/api/variants', async (req, res) => {
  try {
    const { jersey_id, version, size } = req.query;
    let sql = 'SELECT v.*, j.name as jersey_name FROM variants v JOIN jerseys j ON v.jersey_id = j.id WHERE v.active = 1';
    const params = [];

    if (jersey_id) { params.push(jersey_id); sql += ` AND v.jersey_id = $${params.length}`; }
    if (version) { params.push(version); sql += ` AND v.version = $${params.length}`; }
    if (size) { params.push(size); sql += ` AND v.size = $${params.length}`; }

    sql += ' ORDER BY v.jersey_id, v.version, v.size';
    const variants = await db.all(sql, params);
    res.json(variants);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── CART ────────────────────────────────────────────────────────────────────

app.get('/api/cart', async (req, res) => {
  try {
    const items = await db.all(
      `SELECT ci.*, v.version, v.size, v.price, v.stock,
        j.name as jersey_name, j.team_id, t.name as team_name, t.slug as team_slug,
        (SELECT image_url FROM jersey_images WHERE jersey_id = j.id ORDER BY sort_order LIMIT 1) as image_url
       FROM cart_items ci
       JOIN variants v ON ci.variant_id = v.id
       JOIN jerseys j ON v.jersey_id = j.id
       JOIN teams t ON j.team_id = t.id
       WHERE ci.session_id = $1
       ORDER BY ci.created_at`,
      [req.sessionId]
    );
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/cart', async (req, res) => {
  try {
    const { variant_id, name_text, quantity } = req.body;
    if (!variant_id) return res.status(400).json({ error: 'variant_id required' });

    const variant = await db.get('SELECT * FROM variants WHERE id = $1 AND active = 1', [variant_id]);
    if (!variant) return res.status(404).json({ error: 'Variant not found' });
    if (variant.stock < (quantity || 1)) return res.status(400).json({ error: 'Insufficient stock' });

    const existing = await db.get(
      'SELECT * FROM cart_items WHERE session_id = $1 AND variant_id = $2 AND COALESCE(name_text, \'\') = COALESCE($3, \'\')',
      [req.sessionId, variant_id, name_text || '']
    );

    if (existing) {
      await db.query('UPDATE cart_items SET quantity = quantity + $1 WHERE id = $2',
        [quantity || 1, existing.id]);
    } else {
      await db.query(
        'INSERT INTO cart_items (session_id, variant_id, name_text, quantity) VALUES ($1, $2, $3, $4)',
        [req.sessionId, variant_id, name_text || null, quantity || 1]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/cart/:id', async (req, res) => {
  try {
    const { quantity } = req.body;
    if (quantity < 1) {
      await db.query('DELETE FROM cart_items WHERE id = $1 AND session_id = $2',
        [req.params.id, req.sessionId]);
    } else {
      await db.query('UPDATE cart_items SET quantity = $1 WHERE id = $2 AND session_id = $3',
        [quantity, req.params.id, req.sessionId]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/cart/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM cart_items WHERE id = $1 AND session_id = $2',
      [req.params.id, req.sessionId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/cart/clear', async (req, res) => {
  try {
    await db.query('DELETE FROM cart_items WHERE session_id = $1', [req.sessionId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── CHECKOUT (convert cart → order) ─────────────────────────────────────────

app.post('/api/checkout', async (req, res) => {
  try {
    const { customer_name, email, phone, address, notes } = req.body;
    if (!customer_name || !email || !address) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const cartItems = await db.all(
      `SELECT ci.*, v.version, v.size, v.price, v.stock, v.jersey_id
       FROM cart_items ci JOIN variants v ON ci.variant_id = v.id
       WHERE ci.session_id = $1`,
      [req.sessionId]
    );

    if (!cartItems.length) return res.status(400).json({ error: 'Cart is empty' });

    // Validate stock
    for (const item of cartItems) {
      if (item.stock < item.quantity) {
        return res.status(400).json({
          error: `Insufficient stock for ${item.version} - size ${item.size}`
        });
      }
    }

    // Create or find customer
    let customer = await db.get('SELECT id FROM customers WHERE email = $1', [email]);
    if (!customer) {
      const c = await db.query(
        'INSERT INTO customers (name, email, phone) VALUES ($1, $2, $3) RETURNING id',
        [customer_name, email, phone || null]
      );
      customer = c.rows[0];
    }

    // Create address
    const addr = await db.query(
      `INSERT INTO addresses (customer_id, label, street, city, country, is_default)
       VALUES ($1, 'Shipping', $2, '', 'US', 1) RETURNING id`,
      [customer.id, address]
    );
    const addressId = addr.rows[0].id;

    // Calculate
    let subtotal = 0;
    let namePrintingCount = 0;
    for (const item of cartItems) {
      subtotal += item.price * item.quantity;
      if (item.name_text && item.name_text.trim()) namePrintingCount++;
    }
    const deliveryFee = 5;
    const namePrintFee = namePrintingCount * 5;
    const total = subtotal + deliveryFee + namePrintFee;

    // Create order
    const orderRes = await db.query(
      `INSERT INTO orders (customer_id, email, phone, shipping_address_id, notes, subtotal, delivery_fee, name_printing_fee, total, status, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed', 'unpaid') RETURNING id`,
      [customer.id, email, phone || null, addressId, notes || null, subtotal, deliveryFee, namePrintFee, total]
    );
    const orderId = orderRes.rows[0].id;

    // Create order items and decrement stock
    for (const item of cartItems) {
      await db.query(
        `INSERT INTO order_items (order_id, jersey_id, variant_id, size, version, name_text, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orderId, item.jersey_id, item.variant_id, item.size, item.version, item.name_text || null, item.quantity, item.price]
      );
      await db.query('UPDATE variants SET stock = stock - $1 WHERE id = $2', [item.quantity, item.variant_id]);
    }

    // Clear cart
    await db.query('DELETE FROM cart_items WHERE session_id = $1', [req.sessionId]);

    res.json({ order_id: orderId, total, delivery_fee: deliveryFee, name_printing_fee: namePrintFee });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── LEGACY ORDERS (frontend compatibility) ──────────────────────────────────

app.post('/api/orders', async (req, res) => {
  try {
    const { customer_name, email, phone, address, notes, items } = req.body;
    if (!customer_name || !email || !address || !items || !items.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let subtotal = 0;
    let namePrintingCount = 0;

    for (const item of items) {
      const variant = await db.get(
        'SELECT * FROM variants WHERE jersey_id = $1 AND version = $2 AND size = $3 AND active = 1',
        [item.jersey_id, item.version, item.size]
      );
      if (!variant) return res.status(400).json({ error: `Variant not found for jersey ${item.jersey_id}` });
      if (variant.stock < item.quantity) return res.status(400).json({ error: `Insufficient stock for ${item.version} - ${item.size}` });

      item.variant_id = variant.id;
      item.price = variant.price;
      subtotal += variant.price * item.quantity;
      if (item.name_text && item.name_text.trim()) namePrintingCount++;
    }

    const deliveryFee = 5;
    const namePrintFee = namePrintingCount * 5;
    const total = subtotal + deliveryFee + namePrintFee;

    let customer = await db.get('SELECT id FROM customers WHERE email = $1', [email]);
    if (!customer) {
      const c = await db.query(
        'INSERT INTO customers (name, email, phone) VALUES ($1, $2, $3) RETURNING id',
        [customer_name, email, phone || null]
      );
      customer = c.rows[0];
    }

    const addr = await db.query(
      `INSERT INTO addresses (customer_id, label, street, city, country, is_default)
       VALUES ($1, 'Shipping', $2, '', 'US', 1) RETURNING id`,
      [customer.id, address]
    );

    const orderRes = await db.query(
      `INSERT INTO orders (customer_id, email, phone, shipping_address_id, notes, subtotal, delivery_fee, name_printing_fee, total, status, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 'unpaid') RETURNING id`,
      [customer.id, email, phone || null, addr.rows[0].id, notes || null, subtotal, deliveryFee, namePrintFee, total]
    );
    const orderId = orderRes.rows[0].id;

    for (const item of items) {
      await db.query(
        `INSERT INTO order_items (order_id, jersey_id, variant_id, size, version, name_text, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orderId, item.jersey_id, item.variant_id, item.size, item.version, item.name_text || null, item.quantity, item.price]
      );
      await db.query('UPDATE variants SET stock = stock - $1 WHERE id = $2', [item.quantity, item.variant_id]);
    }

    res.json({ order_id: orderId, total, delivery_fee: deliveryFee, name_printing_fee: namePrintFee });

    // Non-blocking notification
    try {
      const notifItems = await db.all(
        `SELECT oi.*, j.name as jersey_name
         FROM order_items oi JOIN jerseys j ON oi.jersey_id = j.id
         WHERE oi.order_id = $1`,
        [orderId]
      );
      notifyOrder(orderId, customer_name, total, notifItems);
    } catch (_) {}
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    // Support lookup by numeric order ID or Stripe session ID (prefixed with cs_)
    const isStripeSession = req.params.id.startsWith('cs_');
    const order = await db.get(
      `SELECT o.*, c.name as customer_name, c.email as customer_email
       FROM orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       WHERE ${isStripeSession ? 'o.stripe_session_id' : 'o.id'} = $1`,
      [req.params.id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const items = await db.all(
      `SELECT oi.*, j.name as jersey_name, t.name as team_name, t.slug as team_slug
       FROM order_items oi
       JOIN jerseys j ON oi.jersey_id = j.id
       JOIN teams t ON j.team_id = t.id
       WHERE oi.order_id = $1`,
      [req.params.id]
    );

    res.json({ ...order, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN: ALL ORDERS ───────────────────────────────────────────────────────

app.get('/api/admin/orders', async (req, res) => {
  try {
    const orders = await db.all(
      `SELECT o.*, c.name as customer_name,
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
       FROM orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       ORDER BY o.created_at DESC LIMIT 50`
    );
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/admin/orders/:id/status', async (req, res) => {
  try {
    const { status, payment_status } = req.body;
    if (status) {
      await db.query('UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2', [status, req.params.id]);
    }
    if (payment_status) {
      await db.query('UPDATE orders SET payment_status = $1, updated_at = NOW() WHERE id = $2', [payment_status, req.params.id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN: JERSEY MANAGEMENT ──────────────────────────────────────────────

app.get('/api/admin/jerseys', adminRequired, async (req, res) => {
  try {
    const jerseys = await db.all(
      `SELECT j.*, t.name as team_name, t.slug as team_slug,
        (SELECT image_url FROM jersey_images WHERE jersey_id = j.id ORDER BY sort_order LIMIT 1) as image_url
       FROM jerseys j
       JOIN teams t ON j.team_id = t.id
       ORDER BY j.created_at DESC`
    );
    res.json(jerseys);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/jerseys', adminRequired, async (req, res) => {
  try {
    const { team_id, name, season, type, description, featured, image_urls } = req.body;
    if (!team_id || !name) {
      return res.status(400).json({ error: 'team_id and name are required' });
    }
    const result = await db.query(
      `INSERT INTO jerseys (team_id, name, season, type, description, featured)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [team_id, name, season || null, type || null, description || null, featured || 0]
    );
    const jersey = result.rows[0];

    // Add image URLs
    if (image_urls && image_urls.length) {
      for (let i = 0; i < image_urls.length; i++) {
        await db.query(
          'INSERT INTO jersey_images (jersey_id, image_url, sort_order) VALUES ($1, $2, $3)',
          [jersey.id, image_urls[i], i]
        );
      }
    }

    // Create default variants if none exist
    const existing = await db.get('SELECT id FROM variants WHERE jersey_id = $1 LIMIT 1', [jersey.id]);
    if (!existing) {
      const versions = ['fan', 'player', 'retro'];
      const sizes = ['S', 'M', 'L', 'XL', '2XL'];
      const prices = { fan: 20, player: 23, retro: 25 };
      for (const ver of versions) {
        for (const sz of sizes) {
          const sku = `${jersey.id}-${ver}-${sz}`;
          await db.query(
            'INSERT INTO variants (jersey_id, version, size, price, stock, sku) VALUES ($1, $2, $3, $4, 100, $5)',
            [jersey.id, ver, sz, prices[ver], sku]
          );
        }
      }
    }

    res.json({ success: true, jersey });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/jerseys/:id', adminRequired, async (req, res) => {
  try {
    await db.query('DELETE FROM jersey_images WHERE jersey_id = $1', [req.params.id]);
    await db.query('DELETE FROM variants WHERE jersey_id = $1', [req.params.id]);
    await db.query('DELETE FROM jerseys WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/teams', adminRequired, async (req, res) => {
  try {
    const teams = await db.all('SELECT * FROM teams ORDER BY name ASC');
    res.json(teams);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN: SALES & ANALYTICS ─────────────────────────────────────────────

app.get('/api/admin/sales', adminRequired, async (req, res) => {
  try {
    const period = req.query.period || 'month'; // day, week, month

    let interval;
    if (period === 'day') interval = '24 hours';
    else if (period === 'week') interval = '7 days';
    else interval = '30 days';

    const cutoffDate = new Date(Date.now() - (period === 'day' ? 24 : period === 'week' ? 7 : 30) * 3600000 * 24).toISOString();
    const dailySales = await db.all(
      `SELECT DATE(created_at) as date, COUNT(*) as order_count, COALESCE(SUM(total), 0) as revenue
       FROM orders
       WHERE payment_status = 'paid' AND created_at >= ?
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [cutoffDate]
    );

    const totalRevenue = await db.get(
      `SELECT COALESCE(SUM(total), 0) as total_revenue,
              COUNT(*) as total_orders,
              COALESCE(AVG(total), 0) as avg_order_value
       FROM orders WHERE payment_status = 'paid'`
    );

    const topSellers = await db.all(
      `SELECT j.id, j.name, t.name as team_name, COUNT(oi.id) as units_sold, COALESCE(SUM(oi.unit_price * oi.quantity), 0) as revenue
       FROM order_items oi
       JOIN jerseys j ON oi.jersey_id = j.id
       JOIN teams t ON j.team_id = t.id
       JOIN orders o ON oi.order_id = o.id
       WHERE o.payment_status = 'paid'
       GROUP BY j.id, t.name
       ORDER BY units_sold DESC
       LIMIT 10`
    );

    const statusBreakdown = await db.all(
      `SELECT status, COUNT(*) as count FROM orders GROUP BY status`
    );

    const recentOrders = await db.all(
      `SELECT o.id, o.total, o.status, o.payment_status, o.created_at, c.name as customer_name
       FROM orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       ORDER BY o.created_at DESC LIMIT 10`
    );

    res.json({ dailySales, totalRevenue, topSellers, statusBreakdown, recentOrders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/sales/summary', adminRequired, async (req, res) => {
  try {
    const today = await db.get(
      `SELECT COUNT(*) as orders_today, COALESCE(SUM(total), 0) as revenue_today
       FROM orders WHERE payment_status = 'paid' AND DATE(created_at) = CURRENT_DATE`
    );

    const thisMonth = await db.get(
      `SELECT COUNT(*) as orders_month, COALESCE(SUM(total), 0) as revenue_month
       FROM orders WHERE payment_status = 'paid'
       AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)`
    );

    const total = await db.get(
      `SELECT COUNT(*) as total_orders, COALESCE(SUM(total), 0) as total_revenue
       FROM orders WHERE payment_status = 'paid'`
    );

    const pendingOrders = await db.get(
      `SELECT COUNT(*) as count FROM orders WHERE status = 'pending'`
    );

    res.json({ today, thisMonth, total, pendingOrders: pendingOrders.count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── IMAGE PROXY (bypasses hotlink protection on Yupoo / external hosts) ─────

app.get('/api/img-proxy', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('url required');

  let target;
  try { target = new URL(url); } catch { return res.status(400).send('invalid url'); }

  // Only proxy known image hosts
  const allowed = ['photo.yupoo.com', 'images.footballfanatics.com', 'classicfootballshirts.co.uk', 'assets.adidas.com', 'upload.wikimedia.org'];
  if (!allowed.some(h => target.hostname === h || target.hostname.endsWith('.' + h))) {
    return res.status(403).send('host not allowed');
  }

  const mod = target.protocol === 'https:' ? https : http;
  const options = {
    hostname : target.hostname,
    path     : target.pathname + target.search,
    headers  : {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer'   : `https://${target.hostname}/`,
      'Accept'    : 'image/webp,image/apng,image/*,*/*;q=0.8',
    },
  };

  const proxy = mod.get(options, upstream => {
    // Follow one redirect
    if ((upstream.statusCode === 301 || upstream.statusCode === 302) && upstream.headers.location) {
      const loc = upstream.headers.location;
      upstream.destroy();
      return res.redirect('/api/img-proxy?url=' + encodeURIComponent(loc));
    }
    if (upstream.statusCode !== 200) {
      upstream.destroy();
      return res.status(upstream.statusCode).send('upstream error');
    }
    res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    upstream.pipe(res);
  });
  proxy.on('error', err => { console.error('img-proxy err:', err.message); res.status(502).send('proxy error'); });
});

// ─── SPA FALLBACK & ERROR HANDLER ─────────────────────────────────────────

// Serve index.html for any unmatched non-API route (SPA client-side routing)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── START ───────────────────────────────────────────────────────────────────

async function start() {
  try {
    await db.initialize();
  } catch (err) {
    console.error('Database connection failed:', err.message);
    console.error('Server will start but database features will be unavailable.');
  }
  app.listen(PORT, () => {
    console.log(`Kickoff Jerseys ecommerce running on http://localhost:${PORT}`);
  });
}

start().catch(err => { console.error(err); process.exit(1); });
