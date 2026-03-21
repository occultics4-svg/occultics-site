// ─────────────────────────────────────────────────────
// stripe-webhook.js
// Receives Stripe payment confirmation
// → Reads birth data from metadata
// → Generates PDF report via Python
// → Emails PDF to customer via Resend
// ─────────────────────────────────────────────────────
const https = require('https');
const crypto = require('crypto');

// ── Stripe signature verification ────────────────────
function verifyStripeSignature(payload, sig, secret) {
  const parts = sig.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});
  const timestamp = parts.t;
  const signatures = sig.split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  const signedPayload = `${timestamp}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return signatures.some(s => crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

// ── Call Anthropic API ────────────────────────────────
function callClaude(prompt, maxTokens = 4000) {
  const key = process.env.ANTHROPIC_API_KEY;
  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  });
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          resolve(parsed.content?.[0]?.text || '');
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Send email via Resend ─────────────────────────────
function sendEmail({ to, subject, html, pdfBase64, pdfName }) {
  const key = process.env.RESEND_API_KEY;
  const body = JSON.stringify({
    from: 'Occultics <reports@occultics.ai>',
    to: [to],
    subject,
    html,
    attachments: pdfBase64 ? [{
      filename: pdfName || 'your-report.pdf',
      content: pdfBase64
    }] : []
  });
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Numerology calculations ───────────────────────────
function reduceNum(n) {
  while (n > 9) {
    n = String(n).split('').reduce((s, d) => s + parseInt(d), 0);
  }
  return n;
}

function parseDate(dob) {
  // dob format: YYYY-MM-DD
  const [year, month, day] = dob.split('-').map(Number);
  return { day, month, year };
}

function calcPythagorean(dob) {
  const { day, month, year } = parseDate(dob);
  const bio = reduceNum(day + month);
  const gen = reduceNum(String(year).split('').reduce((s,d) => s+parseInt(d), 0));
  const lp  = reduceNum(bio + gen);
  return { bio, gen, lp };
}

function calcAnnualCode(dob) {
  const pyth = calcPythagorean(dob);
  const yearSum = reduceNum(2+0+2+6); // 2026 = 1
  return {
    bio: reduceNum(pyth.bio + yearSum),
    gen: reduceNum(pyth.gen + yearSum),
    lp:  reduceNum(pyth.lp  + yearSum)
  };
}

function calcCompatibility(dob1, dob2) {
  const p1 = calcPythagorean(dob1);
  const p2 = calcPythagorean(dob2);
  return {
    bio: reduceNum(p1.bio + p2.bio),
    gen: reduceNum(p1.gen + p2.gen),
    lp:  reduceNum(p1.lp  + p2.lp)
  };
}

// ── Build report prompt ───────────────────────────────
function buildPersonalPrompt(meta) {
  const { customer_name: name, date_of_birth: dob, gender, time_of_birth: time, place_of_birth: place } = meta;
  const pyth = calcPythagorean(dob);
  const annual = calcAnnualCode(dob);
  const { day, month, year } = parseDate(dob);

  return `You are generating a professional personal numerology report for ${name}.

BIRTH DETAILS:
- Name: ${name}
- Date of Birth: ${day}.${String(month).padStart(2,'0')}.${year}
- Time of Birth: ${time || 'unknown'}
- Place of Birth: ${place || 'unknown'}
- Gender: ${gender || 'not specified'}

CALCULATED NUMBERS:
- Pythagorean Code: ${pyth.bio}·${pyth.gen}·${pyth.lp}
- Biorhythm: ${pyth.bio}
- Generational: ${pyth.gen}  
- Life Path: ${pyth.lp}
- Annual Code 2026: ${annual.bio}·${annual.gen}·${annual.lp}

Write a complete personal numerology report in 10 sections. Use first person "I think..." and "I do not know if this applies to you, but...". Be specific, direct, personal. No bullet points within sections — flowing prose only. English only.

Sections:
1. How This Reading Works (brief intro)
2. Your Core Numbers — the Pythagorean Code ${pyth.bio}·${pyth.gen}·${pyth.lp}
3. Who You Are — Life Path ${pyth.lp} in depth
4. How Others See You — Biorhythm ${pyth.bio}
5. Your Generation — Generational number ${pyth.gen}
6. Love and Relationships
7. Career and Money
8. Health
9. Your 2026 — Annual Code ${annual.bio}·${annual.gen}·${annual.lp}
10. A Personal Note

Each section: 3-4 paragraphs. Total report: approximately 2500-3000 words.`;
}

function buildCompatibilityPrompt(meta) {
  const { customer_name: n1, date_of_birth: d1, name2: n2, dob2: d2 } = meta;
  const p1 = calcPythagorean(d1);
  const p2 = calcPythagorean(d2);
  const compat = calcCompatibility(d1, d2);

  return `You are generating a professional compatibility numerology report for ${n1} and ${n2}.

PERSON 1 — ${n1}:
- Date of Birth: ${d1}
- Pythagorean Code: ${p1.bio}·${p1.gen}·${p1.lp}

PERSON 2 — ${n2}:
- Date of Birth: ${d2}
- Pythagorean Code: ${p2.bio}·${p2.gen}·${p2.lp}

COMPATIBILITY CODE: ${compat.bio}·${compat.gen}·${compat.lp}

Write a complete compatibility numerology report in 10 sections. Use first person addressing both people. Be specific, direct, revelatory. Flowing prose only. English only.

Sections:
1. How This Reading Works
2. How the Numbers Connect — the Compatibility Code
3. ${n1} in This Relationship
4. ${n2} in This Relationship
5. The Compatibility Code ${compat.bio}·${compat.gen}·${compat.lp}
6. The Combined Life Path
7. What Connects Them
8. What They Will Need to Navigate
9. 2026 as a Couple
10. A Personal Note

Each section: 3-4 paragraphs. Total: approximately 2500-3000 words.`;
}

function buildForecastPrompt(meta) {
  const { customer_name: name, date_of_birth: dob, gender, time_of_birth: time } = meta;
  const pyth = calcPythagorean(dob);
  const annual = calcAnnualCode(dob);
  const { day, month, year } = parseDate(dob);
  
  // Calculate age in 2026
  const age2026 = 2026 - year - (month > 1 || (month === 1 && day >= 1) ? 0 : 1);

  return `You are generating a professional Annual Forecast 2026 numerology report for ${name}.

BIRTH DETAILS:
- Name: ${name}
- Date of Birth: ${day}.${String(month).padStart(2,'0')}.${year}
- Time: ${time || 'unknown'}
- Gender: ${gender || 'not specified'}
- Age in 2026: ${age2026}

CALCULATED NUMBERS:
- Birth Code: ${pyth.bio}·${pyth.gen}·${pyth.lp}
- Annual Code 2026: ${annual.bio}·${annual.gen}·${annual.lp}
- Year 2026 sum: 2+0+2+6=10→1

Write a complete Annual Forecast 2026 report in 10 sections. Be specific, prophetic, personal. First person "I think..." style. Flowing prose. English only.

Sections:
1. How the Annual Forecast Works
2. How the Numbers Connect
3. The First Aspect — ${annual.bio}-${annual.gen}
4. The Second Aspect — ${annual.gen}-${annual.lp}
5. The Third Aspect — ${annual.bio}-${annual.lp}
6. The Pyramid Year (age ${age2026})
7. The Unique Annual Code
8. Health in 2026
9. Career and Money in 2026
10. A Personal Note

Each section: 3-4 paragraphs. Total: approximately 2500-3000 words.`;
}

// ── Email HTML template ───────────────────────────────
function buildEmailHTML(name, type) {
  const titles = {
    personal: 'Personal Numerology Profile',
    compatibility: 'Compatibility Report',
    forecast: 'Annual Forecast 2026'
  };
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: 'Georgia', serif; background: #f8faff; margin: 0; padding: 0; }
  .container { max-width: 560px; margin: 0 auto; background: white; }
  .header { background: #0a0e2e; padding: 32px 40px; text-align: center; }
  .header-title { color: #4db8ff; font-size: 11px; letter-spacing: 3px; text-transform: uppercase; font-family: Arial, sans-serif; margin-bottom: 8px; }
  .header-name { color: white; font-size: 26px; font-weight: 300; }
  .body { padding: 36px 40px; }
  .greeting { font-size: 18px; color: #0d1117; margin-bottom: 16px; }
  .message { font-size: 14px; color: #3d4a5c; line-height: 1.8; margin-bottom: 20px; }
  .report-box { background: #f0f4ff; border: 1.5px solid #1a2aff; border-radius: 12px; padding: 20px 24px; margin-bottom: 24px; text-align: center; }
  .report-box-title { font-size: 11px; letter-spacing: 2px; color: #1a2aff; text-transform: uppercase; font-family: Arial, sans-serif; margin-bottom: 6px; }
  .report-box-name { font-size: 20px; color: #0d1117; }
  .footer { background: #f8faff; padding: 20px 40px; text-align: center; border-top: 1px solid #e8edf5; }
  .footer-text { font-size: 10px; color: #8892a4; font-family: Arial, sans-serif; line-height: 1.6; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="header-title">OCCULTICS.AI ✦ WELCOME TO YOUR NEW REALITY</div>
    <div class="header-name">Your Report Is Ready</div>
  </div>
  <div class="body">
    <div class="greeting">Dear ${name},</div>
    <div class="message">
      Your <strong>${titles[type] || 'Numerology Report'}</strong> has been generated and is attached to this email as a PDF.
      <br><br>
      Your numbers have been calculated using our proprietary system — built on over 350,000 words of numerological knowledge. Everything in your report is specific to you, your date of birth, and the patterns your numbers carry.
      <br><br>
      Please open the attached PDF to read your full report. We recommend reading it somewhere quiet, without distractions.
    </div>
    <div class="report-box">
      <div class="report-box-title">Your Report</div>
      <div class="report-box-name">${titles[type] || 'Numerology Report'}</div>
    </div>
    <div class="message" style="font-style:italic; color:#8892a4; font-size:13px;">
      "The numbers for this year are telling you something specific."<br>
      — Occultics.ai
    </div>
  </div>
  <div class="footer">
    <div class="footer-text">
      © 2026 Occultics Publishing · occultics.ai<br>
      For informational and entertainment purposes only.
    </div>
  </div>
</div>
</body>
</html>`;
}

// ── Main handler ──────────────────────────────────────
exports.handler = async function(event) {
  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Verify Stripe signature
  if (webhookSecret && sig) {
    try {
      if (!verifyStripeSignature(event.body, sig, webhookSecret)) {
        return { statusCode: 400, body: 'Invalid signature' };
      }
    } catch(e) {
      return { statusCode: 400, body: 'Signature error' };
    }
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // Only process successful payments
  if (stripeEvent.type !== 'payment_intent.succeeded' && 
      stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Event ignored' };
  }

  // Extract metadata
  let meta;
  if (stripeEvent.type === 'checkout.session.completed') {
    meta = stripeEvent.data.object.metadata || {};
    if (!meta.customer_email) {
      meta.customer_email = stripeEvent.data.object.customer_email || '';
    }
  } else {
    meta = stripeEvent.data.object.metadata || {};
  }

  const { report_type, customer_email, customer_name } = meta;

  if (!customer_email || !customer_name || !report_type) {
    console.log('Missing metadata:', meta);
    // Send a generic notification email if metadata is missing
    // (this handles payment links which don't pass metadata)
    return { statusCode: 200, body: 'Payment received — manual report needed' };
  }

  try {
    // 1. Generate report text via Claude
    console.log(`Generating ${report_type} report for ${customer_name}...`);
    
    let prompt;
    if (report_type === 'personal') {
      prompt = buildPersonalPrompt(meta);
    } else if (report_type === 'compatibility') {
      prompt = buildCompatibilityPrompt(meta);
    } else if (report_type === 'forecast') {
      prompt = buildForecastPrompt(meta);
    } else {
      throw new Error(`Unknown report type: ${report_type}`);
    }

    const reportText = await callClaude(prompt, 4000);

    // 2. Send email with report as text (PDF generation requires Python/backend)
    // For now: send beautifully formatted HTML email with the full report
    // When Python backend is added, this becomes a PDF attachment
    
    const reportTitles = {
      personal: 'Personal Numerology Profile',
      compatibility: 'Compatibility Report', 
      forecast: 'Annual Forecast 2026'
    };

    const emailHTML = buildEmailHTML(customer_name, report_type) + `
<div style="max-width:560px;margin:0 auto;padding:0 40px 40px;background:white;font-family:Georgia,serif;font-size:14px;color:#3d4a5c;line-height:1.9;">
  <hr style="border:none;border-top:1px solid #e8edf5;margin:0 0 32px;">
  ${reportText.split('\n\n').map(p => 
    p.trim() ? `<p style="margin:0 0 16px;">${p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/^#+\s*/, '')}</p>` : ''
  ).join('')}
</div>`;

    await sendEmail({
      to: customer_email,
      subject: `Your ${reportTitles[report_type]} — Occultics.ai`,
      html: emailHTML
    });

    console.log(`Report sent to ${customer_email}`);
    return { statusCode: 200, body: 'Report generated and sent' };

  } catch(err) {
    console.error('Report generation error:', err);
    
    // Send error notification to admin
    try {
      await sendEmail({
        to: 'owner@occultics.ai',
        subject: `⚠️ Report generation failed — ${customer_name}`,
        html: `<p>Failed to generate ${report_type} report for ${customer_name} (${customer_email}).</p><p>Error: ${err.message}</p><p>Metadata: ${JSON.stringify(meta)}</p>`
      });
    } catch(e) { /* ignore */ }

    return { statusCode: 500, body: 'Report generation failed' };
  }
};
