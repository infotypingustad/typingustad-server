// ═══════════════════════════════════════════════════════════
//  TYPINGUSTAD — COMPLETE BACKEND SERVER (Resend Email Version)
//  Handles: Paddle webhooks, token generation, token validation,
//           score saving, admin panel, Supabase database
// ═══════════════════════════════════════════════════════════

const express    = require('express');
const bodyParser = require('body-parser');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const app        = express();

// ── ENVIRONMENT VARIABLES ──
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const PADDLE_SECRET   = process.env.PADDLE_SECRET;
const PADDLE_PRO_ID   = process.env.PADDLE_PRO_ID;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const ADMIN_EMAIL     = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD;
const YOUR_SITE_URL   = process.env.YOUR_SITE_URL || 'https://typingustad.com';

// ── CLIENTS ──
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── MIDDLEWARE ──
app.use(bodyParser.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ══════════════════════════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status:  'TypingUstad server running ✅',
    time:    new Date().toISOString(),
    resend:  RESEND_API_KEY  ? '✅ configured' : '❌ missing RESEND_API_KEY',
    supabase:SUPABASE_URL    ? '✅ connected'  : '❌ missing SUPABASE_URL',
    admin:   ADMIN_PASSWORD  ? '✅ password set': '❌ missing ADMIN_PASSWORD'
  });
});

// ══════════════════════════════════════════════════════════
//  TOKEN GENERATOR HELPER
// ══════════════════════════════════════════════════════════
function generateCode(plan) {
  const prefix = plan === 'pro' ? 'TU-PRO' : 'TU-BSC';
  const num    = Math.floor(1000 + Math.random() * 9000);
  const alpha  = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const letter = alpha[Math.floor(Math.random() * alpha.length)];
  return `${prefix}-${num}${letter}`;
}

// ══════════════════════════════════════════════════════════
//  1. VALIDATE TOKEN
//     Called by your website when user enters a code
//     POST /validate-token
// ══════════════════════════════════════════════════════════
app.post('/validate-token', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.json({ valid: false, message: 'No code provided.' });

    const cleanCode = code.toUpperCase().trim();

    const { data: token, error } = await supabase
      .from('tokens')
      .select('*')
      .eq('code', cleanCode)
      .single();

    if (error || !token) {
      return res.json({ valid: false, message: 'Invalid code. Please check and try again.' });
    }

    if (token.uses_remaining <= 0) {
      return res.json({ valid: false, message: 'This code has no uses remaining. Please purchase a new plan.' });
    }

    if (token.expires_at && new Date() > new Date(token.expires_at)) {
      return res.json({ valid: false, message: 'This code has expired. Please purchase a new plan.' });
    }

    // Valid — deduct 1 use
    const newUsesRemaining = token.uses_remaining - 1;
    await supabase
      .from('tokens')
      .update({
        uses_remaining: newUsesRemaining,
        last_used_at:   new Date().toISOString(),
        status:         newUsesRemaining <= 0 ? 'used' : 'active'
      })
      .eq('code', cleanCode);

    return res.json({
      valid:         true,
      message:       'Code verified successfully.',
      usesRemaining: newUsesRemaining,
      plan:          token.plan
    });

  } catch (err) {
    console.error('validate-token error:', err);
    res.status(500).json({ valid: false, message: 'Server error. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════
//  2. SAVE SCORE
//     POST /save-score
// ══════════════════════════════════════════════════════════
app.post('/save-score', async (req, res) => {
  try {
    const { user, wpm, accuracy, errors, chars, time, level } = req.body;

    const { error } = await supabase
      .from('scores')
      .insert([{
        username:   user     || 'Guest',
        wpm:        wpm      || 0,
        accuracy:   accuracy || 0,
        errors:     errors   || 0,
        chars:      chars    || 0,
        time_taken: time     || 60,
        level:      level    || 'easy',
        created_at: new Date().toISOString()
      }]);

    if (error) throw error;
    res.json({ success: true });

  } catch (err) {
    console.error('save-score error:', err);
    res.status(500).json({ success: false });
  }
});

// ══════════════════════════════════════════════════════════
//  3. GET SCORES
//     GET /get-scores?user=Ahmed
// ══════════════════════════════════════════════════════════
app.get('/get-scores', async (req, res) => {
  try {
    const { user } = req.query;
    let query = supabase
      .from('scores')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (user && user !== 'Guest') query = query.eq('username', user);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, scores: data || [] });

  } catch (err) {
    console.error('get-scores error:', err);
    res.status(500).json({ success: false, scores: [] });
  }
});

// ══════════════════════════════════════════════════════════
//  4. PADDLE WEBHOOK
//     Paddle calls this automatically after a payment
//     POST /paddle-webhook
// ══════════════════════════════════════════════════════════
app.post('/paddle-webhook', async (req, res) => {
  try {
    const event = req.body;

    // Only handle completed payments
    if (event.event_type !== 'transaction.completed') {
      return res.status(200).json({ received: true });
    }

    const transaction   = event.data;
    const customerEmail = transaction.customer?.email || '';
    const customerName  = transaction.customer?.name  || 'Typist';
    const priceId       = transaction.items?.[0]?.price?.id || '';
    const isPro         = priceId === PADDLE_PRO_ID;
    const plan          = isPro ? 'pro' : 'basic';
    const uses          = isPro ? 5 : 1;
    const expiryDays    = isPro ? 30 : 7;

    // Generate code
    const code      = generateCode(plan);
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString();

    // Save to Supabase
    const { error: insertError } = await supabase
      .from('tokens')
      .insert([{
        code,
        plan,
        uses_total:     uses,
        uses_remaining: uses,
        expires_at:     expiresAt,
        user_email:     customerEmail,
        user_name:      customerName,
        source:         'paddle',
        status:         'active',
        note:           `Paddle auto — ${customerEmail}`,
        created_at:     new Date().toISOString()
      }]);

    if (insertError) throw insertError;

    // Send email to user via Resend
    await sendCodeEmail(customerEmail, customerName, code, plan, uses, expiryDays);

    // Notify admin
    await notifyAdmin(customerEmail, customerName, code, plan);

    console.log(`✅ Paddle payment processed — code: ${code} → ${customerEmail}`);
    res.status(200).json({ received: true });

  } catch (err) {
    console.error('paddle-webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ══════════════════════════════════════════════════════════
//  5. ADMIN — GENERATE TOKEN MANUALLY (for Pakistani users)
//     POST /admin/generate-token
// ══════════════════════════════════════════════════════════
app.post('/admin/generate-token', async (req, res) => {
  try {
    const { adminPassword, plan, note, expiryDays, userEmail, userName } = req.body;

    if (adminPassword !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: 'Wrong admin password.' });
    }

    const uses      = plan === 'pro' ? 5 : 1;
    const days      = parseInt(expiryDays) || 30;
    const code      = generateCode(plan);
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    const { error } = await supabase
      .from('tokens')
      .insert([{
        code,
        plan,
        uses_total:     uses,
        uses_remaining: uses,
        expires_at:     expiresAt,
        user_email:     userEmail || '',
        user_name:      userName  || '',
        source:         'manual',
        status:         'active',
        note:           note || '',
        created_at:     new Date().toISOString()
      }]);

    if (error) throw error;

    // Email user if email provided
    if (userEmail) {
      await sendCodeEmail(userEmail, userName || 'Student', code, plan, uses, days);
    }

    console.log(`✅ Manual token: ${code} for ${userEmail || 'no email'}`);
    res.json({ success: true, code, plan, uses, expiresAt });

  } catch (err) {
    console.error('generate-token error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ══════════════════════════════════════════════════════════
//  6. ADMIN — GET ALL TOKENS
//     GET /admin/tokens?adminPassword=xxxx
// ══════════════════════════════════════════════════════════
app.get('/admin/tokens', async (req, res) => {
  try {
    const { adminPassword } = req.query;
    if (adminPassword !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: 'Wrong admin password.' });
    }

    const { data, error } = await supabase
      .from('tokens')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;
    res.json({ success: true, tokens: data || [] });

  } catch (err) {
    console.error('get-tokens error:', err);
    res.status(500).json({ success: false, tokens: [] });
  }
});

// ══════════════════════════════════════════════════════════
//  7. ADMIN — GET ALL SCORES
//     GET /admin/scores?adminPassword=xxxx
// ══════════════════════════════════════════════════════════
app.get('/admin/scores', async (req, res) => {
  try {
    const { adminPassword } = req.query;
    if (adminPassword !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: 'Wrong admin password.' });
    }

    const { data, error } = await supabase
      .from('scores')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) throw error;
    res.json({ success: true, scores: data || [] });

  } catch (err) {
    console.error('admin-scores error:', err);
    res.status(500).json({ success: false, scores: [] });
  }
});

// ══════════════════════════════════════════════════════════
//  8. ADMIN — DELETE TOKEN
//     DELETE /admin/tokens/:code?adminPassword=xxxx
// ══════════════════════════════════════════════════════════
app.delete('/admin/tokens/:code', async (req, res) => {
  try {
    const { adminPassword } = req.query;
    if (adminPassword !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: 'Wrong admin password.' });
    }

    const { error } = await supabase
      .from('tokens')
      .delete()
      .eq('code', req.params.code);

    if (error) throw error;
    res.json({ success: true });

  } catch (err) {
    console.error('delete-token error:', err);
    res.status(500).json({ success: false });
  }
});

// ══════════════════════════════════════════════════════════
//  EMAIL HELPERS — USING RESEND
// ══════════════════════════════════════════════════════════
async function sendCodeEmail(to, name, code, plan, uses, expiryDays) {
  try {
    const resend = new Resend(RESEND_API_KEY);
    const planLabel = plan === 'pro'
      ? 'Pro Plan (5 certificates)'
      : 'Basic Plan (1 certificate)';

    // Use onboarding@resend.dev until domain is verified
    // After domain verified change to: certificates@typingustad.com
    const fromAddress = 'TypingUstad <onboarding@resend.dev>';

    await resend.emails.send({
      from:    fromAddress,
      to:      to,
      subject: '🏆 Your TypeMaster Certificate Code is Ready!',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#0d0f1a;color:#e2e8f0;padding:40px 32px;border-radius:16px;">
          <h2 style="color:#a78bfa;margin-bottom:6px;">🏆 Your Certificate Code</h2>
          <p style="color:#94a3b8;margin-top:0;">Hi <b style="color:#e2e8f0;">${name}</b>,</p>
          <p style="color:#94a3b8;">Thank you for purchasing the <b style="color:#e2e8f0;">${planLabel}</b> on TypingUstad.com. Here is your certificate code:</p>

          <div style="background:rgba(108,99,255,.15);border:2px solid rgba(108,99,255,.4);border-radius:14px;padding:28px;text-align:center;margin:24px 0;">
            <div style="font-size:11px;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">Your Certificate Code</div>
            <div style="font-size:2.2rem;font-weight:900;color:#a78bfa;letter-spacing:0.18em;font-family:monospace;">${code}</div>
            <div style="font-size:13px;color:#64748b;margin-top:10px;">${uses} certificate download${uses > 1 ? 's' : ''} &nbsp;·&nbsp; Valid for ${expiryDays} days</div>
          </div>

          <p style="color:#94a3b8;font-size:14px;font-weight:bold;margin-bottom:8px;">How to use your code:</p>
          <div style="background:rgba(255,255,255,.04);border-radius:12px;padding:20px;">
            <div style="color:#94a3b8;font-size:14px;line-height:2.2;">
              <span style="color:#6c63ff;font-weight:bold;">1.</span> Go to <a href="https://typingustad.com/typing-test/" style="color:#6c63ff;">https://typingustad.com/typing-test/</a><br/>
              <span style="color:#6c63ff;font-weight:bold;">2.</span> Complete your typing test<br/>
              <span style="color:#6c63ff;font-weight:bold;">3.</span> Click <b style="color:#e2e8f0;">📄 Download Certificate</b><br/>
              <span style="color:#6c63ff;font-weight:bold;">4.</span> Enter the code above and click <b style="color:#e2e8f0;">Verify</b><br/>
              <span style="color:#22c55e;font-weight:bold;">5.</span> <b style="color:#22c55e;">Your PDF downloads instantly ✅</b>
            </div>
          </div>

          <p style="color:#64748b;font-size:13px;margin-top:20px;">
            You can also use this code on your
            <a href="https://typingustad.com/my-dashboard/" style="color:#6c63ff;">Dashboard page</a>.
            Need help? Reply to this email.
          </p>

          <div style="margin-top:28px;padding-top:20px;border-top:1px solid rgba(255,255,255,.08);font-size:12px;color:#475569;">
            <a href="https://typingustad.com/" style="color:#6c63ff;">https://typingustad.com/</a>
          </div>
        </div>
      `
    });

    console.log(`📧 Email sent successfully to ${to}`);

  } catch (err) {
    console.error('sendCodeEmail error:', err.message);
  }
}

async function notifyAdmin(customerEmail, customerName, code, plan) {
  try {
    if (!ADMIN_EMAIL || !RESEND_API_KEY) return;
    const resend = new Resend(RESEND_API_KEY);

    await resend.emails.send({
      from:    'TypingUstad Server <onboarding@resend.dev>',
      to:      ADMIN_EMAIL,
      subject: `💰 New ${plan.toUpperCase()} sale — ${customerEmail}`,
      text:    `New payment received!\n\nName: ${customerName}\nEmail: ${customerEmail}\nPlan: ${plan.toUpperCase()}\nCode sent: ${code}\nTime: ${new Date().toLocaleString()}`
    });

    console.log(`📧 Admin notified for ${customerEmail}`);

  } catch (err) {
    console.error('notifyAdmin error:', err.message);
  }
}

// ── START SERVER ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TypingUstad server running on port ${PORT}`);
  console.log(`Resend:   ${RESEND_API_KEY  ? '✅ configured' : '❌ missing RESEND_API_KEY'}`);
  console.log(`Supabase: ${SUPABASE_URL    ? '✅ connected'  : '❌ missing SUPABASE_URL'}`);
  console.log(`Admin:    ${ADMIN_PASSWORD  ? '✅ password set': '❌ missing ADMIN_PASSWORD'}`);
});
