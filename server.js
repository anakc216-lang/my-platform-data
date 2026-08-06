const express = require('express');
const Razorpay = require('razorpay');
const dotenv = require('dotenv');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

const {
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.error('Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET in .env');
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

function verifyRazorpaySignature({ order_id, payment_id, signature }) {
  const payload = `${order_id}|${payment_id}`;
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(payload)
    .digest('hex');
  return expectedSignature === signature;
}

async function upsertPremiumUser(userId, paymentId) {
  if (!userId || !paymentId) {
    throw new Error('Missing userId or paymentId for premium update');
  }

  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/premium_users`;
  let response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation,resolution=merge-duplicates'
      },
      body: JSON.stringify([{ user_id: userId, premium_status: true, payment_id: paymentId }])
    });
  } catch (err) {
    console.error('upsertPremiumUser fetch failed', err);
    throw new Error('Unable to connect to Supabase for premium update');
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error('upsertPremiumUser invalid JSON response', err);
    throw new Error('Invalid response from Supabase premium endpoint');
  }

  if (!response.ok) {
    throw new Error(`Supabase update failed: ${JSON.stringify(data)}`);
  }
  return data;
}

app.post('/create-order', async (req, res) => {
  try {
    const receipt = `order_rcptid_${crypto.randomBytes(8).toString('hex')}`;
    const options = {
      amount: 3500,
      currency: 'MYR',
      receipt,
      payment_capture: 1,
    };

    const order = await razorpay.orders.create(options);
    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error('create-order error', error);
    return res.status(500).json({ error: 'Unable to create Razorpay order' });
  }
});

app.post('/verify-payment', async (req, res) => {
  console.log('[premium] /verify-payment body', req.body);
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, currentUserId } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !currentUserId) {
    console.error('[premium] /verify-payment missing fields', { razorpay_order_id, razorpay_payment_id, razorpay_signature, currentUserId });
    return res.status(400).json({ error: 'Missing required fields' });
  }

  console.log('[premium] /verify-payment values', {
    order_id: razorpay_order_id,
    payment_id: razorpay_payment_id,
    signature_present: Boolean(razorpay_signature)
  });

  const isValid = verifyRazorpaySignature({
    order_id: razorpay_order_id,
    payment_id: razorpay_payment_id,
    signature: razorpay_signature
  });

  if (!isValid) {
    console.warn('verify-payment failed signature check', { razorpay_order_id, razorpay_payment_id, razorpay_signature });
    return res.status(400).json({ verified: false, error: 'Invalid signature' });
  }

  try {
    const upsertResult = await upsertPremiumUser(currentUserId, razorpay_payment_id);
    return res.json({ verified: true, premiumUpdated: true, upsertResult });
  } catch (error) {
    console.error('verify-payment supabase update failed', error);
    return res.status(500).json({ verified: false, error: 'Premium update failed' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[server] unexpected error', err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: 'Internal server error' });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[server] unhandledRejection', { reason, promise });
});

process.on('uncaughtException', (error) => {
  console.error('[server] uncaughtException', error);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Razorpay backend running on http://localhost:${port}`);
});
