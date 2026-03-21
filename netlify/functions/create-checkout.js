// ─────────────────────────────────────────────────────
// create-checkout.js
// Creates a Stripe Checkout Session with birth data
// as metadata so the webhook can generate the report
// ─────────────────────────────────────────────────────
const https = require('https');

function stripeRequest(path, method, body) {
  const key = process.env.STRIPE_SECRET_KEY;
  const payload = new URLSearchParams(body).toString();
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.stripe.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Price IDs from Stripe dashboard
// These need to be set as env vars in Netlify
const PRICES = {
  personal:      process.env.STRIPE_PRICE_PERSONAL      || '',
  compatibility: process.env.STRIPE_PRICE_COMPATIBILITY || '',
  forecast:      process.env.STRIPE_PRICE_FORECAST      || '',
};

// Fallback to payment links if price IDs not set
const PAYMENT_LINKS = {
  personal:      'https://buy.stripe.com/9B6cMX2Tp7CS1Lz3nz0co00',
  compatibility: 'https://buy.stripe.com/4gM6oz0Lh4qGduh0bn0co01',
  forecast:      'https://buy.stripe.com/eVq3cnctZ5uK0Hvgal0co02',
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const data = JSON.parse(event.body);
    const { type, email, name, dob, time, place, gender, name2, dob2 } = data;

    // If no Stripe secret key or price IDs, fall back to payment links
    if (!process.env.STRIPE_SECRET_KEY || !PRICES[type]) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ 
          fallback: true, 
          url: PAYMENT_LINKS[type] 
        })
      };
    }

    const origin = event.headers.origin || 'https://occultics.ai';

    // Build metadata — pass all birth data through Stripe
    const metadata = {
      report_type: type,
      customer_email: email,
      customer_name: name,
      date_of_birth: dob,
      time_of_birth: time || '',
      place_of_birth: place || '',
      gender: gender || '',
    };

    // For compatibility reports, add second person
    if (type === 'compatibility') {
      metadata.name2 = name2 || '';
      metadata.dob2 = dob2 || '';
    }

    // Create Stripe Checkout Session
    const body = {
      'mode': 'payment',
      'customer_email': email,
      'line_items[0][price]': PRICES[type],
      'line_items[0][quantity]': '1',
      'success_url': `${origin}/success?type=${type}&name=${encodeURIComponent(name)}`,
      'cancel_url': `${origin}`,
      'payment_intent_data[metadata][report_type]': type,
      'payment_intent_data[metadata][customer_email]': email,
      'payment_intent_data[metadata][customer_name]': name,
      'payment_intent_data[metadata][date_of_birth]': dob,
      'payment_intent_data[metadata][time_of_birth]': time || '',
      'payment_intent_data[metadata][place_of_birth]': place || '',
      'payment_intent_data[metadata][gender]': gender || '',
    };

    if (type === 'compatibility') {
      body['payment_intent_data[metadata][name2]'] = name2 || '';
      body['payment_intent_data[metadata][dob2]'] = dob2 || '';
    }

    const session = await stripeRequest('/v1/checkout/sessions', 'POST', body);

    if (session.error) {
      throw new Error(session.error.message);
    }

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ url: session.url })
    };

  } catch(err) {
    console.error('Checkout error:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
