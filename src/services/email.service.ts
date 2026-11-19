import { config } from '../config/env.js'

export interface SendEmailOptions {
  to: string
  subject: string
  html: string
  text?: string
  from?: string
}

/**
 * Dispatches an email via Mailgun HTTP REST API using standard fetch
 */
export async function sendEmail(options: SendEmailOptions): Promise<{ success: boolean; id?: string; error?: string }> {
  try {
    const apiKey = config.mailgun?.apiKey
    const domain = config.mailgun?.domain || 'pgxgateway.com'
    const from = options.from || config.mailgun?.from || 'PGX Gateway <support@pgxgateway.com>'

    if (!apiKey) {
      console.warn('[Email Service] Mailgun API key is not configured. Email not sent.')
      return { success: false, error: 'Mailgun API key not configured' }
    }

    const auth = Buffer.from(`api:${apiKey}`).toString('base64')
    const form = new URLSearchParams()
    form.append('from', from)
    form.append('to', options.to)
    form.append('subject', options.subject)
    form.append('html', options.html)
    if (options.text) {
      form.append('text', options.text)
    }

    const endpoint = `https://api.mailgun.net/v3/${domain}/messages`
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error(`[Email Service] Mailgun dispatch failed (${res.status}): ${errText}`)
      return { success: false, error: errText }
    }

    const data = (await res.json()) as any
    console.log(`[Email Service] Dispatched email to ${options.to} (ID: ${data.id})`)
    return { success: true, id: data.id }
  } catch (err: any) {
    console.error(`[Email Service] Error sending email to ${options.to}: ${err.message}`)
    return { success: false, error: err.message }
  }
}

/**
 * Sends a password reset email with secure 1-hour expiration link
 */
export async function sendPasswordResetEmail(email: string, resetUrl: string, name?: string): Promise<boolean> {
  const greeting = name ? `Hello ${name},` : 'Hello,'
  const subject = 'Reset Your PGX Gateway Password'

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Reset Your Password - PGX Gateway</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #040714; color: #e2e8f0; margin: 0; padding: 24px 0; }
    .container { max-width: 560px; margin: 0 auto; background: #070d24; border: 1px solid rgba(0, 240, 255, 0.25); border-radius: 16px; padding: 36px 32px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5); }
    .logo { font-size: 24px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; margin-bottom: 24px; }
    .logo span { color: #00f0ff; }
    h1 { font-size: 20px; font-weight: 700; color: #ffffff; margin-top: 0; margin-bottom: 16px; }
    p { font-size: 14px; line-height: 1.6; color: #94a3b8; margin: 0 0 18px 0; }
    .btn-container { text-align: center; margin: 32px 0; }
    .btn { display: inline-block; background: linear-gradient(135deg, #00f0ff 0%, #a855f7 100%); color: #ffffff !important; text-decoration: none; font-weight: 700; font-size: 14px; padding: 14px 32px; border-radius: 10px; box-shadow: 0 0 20px rgba(0, 240, 255, 0.4); }
    .footer { font-size: 12px; color: #64748b; margin-top: 32px; padding-top: 20px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
    .fallback-link { word-break: break-all; color: #00f0ff; font-size: 12px; }
    .note { background: rgba(0, 240, 255, 0.05); border-left: 3px solid #00f0ff; padding: 12px; border-radius: 4px; font-size: 13px; color: #cbd5e1; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">PGX <span>GATEWAY</span></div>
    <h1>Password Reset Request</h1>
    <p>${greeting}</p>
    <p>We received a request to reset your PGX Gateway account password. Click the button below to choose a new secure password:</p>
    <div class="btn-container">
      <a href="${resetUrl}" class="btn" target="_blank">Reset Password</a>
    </div>
    <div class="note">
      This password reset link is valid for <strong>60 minutes</strong>. If you did not make this request, you can safely ignore this email; your account remains secure.
    </div>
    <p style="font-size: 12px; color: #64748b;">If the button above does not work, copy and paste this link into your browser:</p>
    <p class="fallback-link">${resetUrl}</p>
    <div class="footer">
      &copy; ${new Date().getFullYear()} PGX Gateway &bull; High-Velocity Fintech & Global Acquirer Rails.<br>
      Automated System Message &bull; Please do not reply directly to this email.
    </div>
  </div>
</body>
</html>`

  const text = `${greeting}\n\nWe received a request to reset your PGX Gateway password.\n\nPlease reset your password using the link below:\n${resetUrl}\n\nThis link will expire in 60 minutes.\n\nIf you did not request this, please ignore this email.`

  const result = await sendEmail({ to: email, subject, html, text })
  return result.success
}

/**
 * Sends a welcome email upon new merchant registration
 */
export async function sendWelcomeEmail(email: string, name: string, refId: string): Promise<boolean> {
  const subject = 'Welcome to PGX Gateway - Account Provisioned'
  const dashboardUrl = 'https://pgxgateway.com/login'

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Welcome to PGX Gateway</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #040714; color: #e2e8f0; margin: 0; padding: 24px 0; }
    .container { max-width: 560px; margin: 0 auto; background: #070d24; border: 1px solid rgba(0, 240, 255, 0.25); border-radius: 16px; padding: 36px 32px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5); }
    .logo { font-size: 24px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; margin-bottom: 24px; }
    .logo span { color: #00f0ff; }
    h1 { font-size: 20px; font-weight: 700; color: #ffffff; margin-top: 0; margin-bottom: 16px; }
    p { font-size: 14px; line-height: 1.6; color: #94a3b8; margin: 0 0 18px 0; }
    .badge { display: inline-block; background: rgba(0, 240, 255, 0.1); border: 1px solid rgba(0, 240, 255, 0.4); color: #00f0ff; font-family: monospace; font-size: 15px; font-weight: 700; padding: 6px 14px; border-radius: 6px; margin: 12px 0; }
    .btn-container { text-align: center; margin: 28px 0; }
    .btn { display: inline-block; background: linear-gradient(135deg, #00f0ff 0%, #a855f7 100%); color: #ffffff !important; text-decoration: none; font-weight: 700; font-size: 14px; padding: 14px 32px; border-radius: 10px; box-shadow: 0 0 20px rgba(0, 240, 255, 0.4); }
    .footer { font-size: 12px; color: #64748b; margin-top: 32px; padding-top: 20px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">PGX <span>GATEWAY</span></div>
    <h1>Welcome to PGX Gateway</h1>
    <p>Hello ${name},</p>
    <p>Your merchant portal account has been provisioned. Your unique account reference identifier is:</p>
    <div style="text-align: center;">
      <div class="badge">${refId}</div>
    </div>
    <p>You can now sign in to your merchant dashboard to configure integrations, review transactions, and access acquiring rails:</p>
    <div class="btn-container">
      <a href="${dashboardUrl}" class="btn" target="_blank">Access Merchant Dashboard</a>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} PGX Gateway &bull; High-Velocity Fintech & Global Acquirer Rails.<br>
      Dedicated Underwriting Desk &bull; support@pgxgateway.com
    </div>
  </div>
</body>
</html>`

  const text = `Hello ${name},\n\nWelcome to PGX Gateway!\nYour account reference ID is: ${refId}\n\nSign in to your merchant dashboard at: ${dashboardUrl}\n\nBest regards,\nPGX Gateway Team`

  const result = await sendEmail({ to: email, subject, html, text })
  return result.success
}

/**
 * Sends a payment confirmation notification email to merchant upon checkout completion
 */
export async function sendPaymentSuccessEmail(email: string, name: string, txn: {
  transactionId: string
  orderId?: string
  grossAmount: number
  currency: string
  merchantNetAmount?: number
}): Promise<boolean> {
  const subject = `Payment Confirmed: ${txn.currency} ${txn.grossAmount.toFixed(2)} (Order #${txn.orderId || txn.transactionId})`

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Payment Received - PGX Gateway</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #040714; color: #e2e8f0; margin: 0; padding: 24px 0; }
    .container { max-width: 560px; margin: 0 auto; background: #070d24; border: 1px solid rgba(0, 240, 255, 0.25); border-radius: 16px; padding: 36px 32px; }
    .logo { font-size: 22px; font-weight: 800; color: #ffffff; margin-bottom: 20px; }
    .logo span { color: #00f0ff; }
    .amount-box { background: rgba(0, 240, 255, 0.08); border: 1px solid rgba(0, 240, 255, 0.3); border-radius: 12px; padding: 20px; text-align: center; margin: 20px 0; }
    .amount { font-size: 32px; font-weight: 800; color: #00f0ff; }
    .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.06); font-size: 13px; }
    .detail-label { color: #94a3b8; }
    .detail-val { color: #ffffff; font-weight: 600; }
    .footer { font-size: 12px; color: #64748b; margin-top: 24px; padding-top: 16px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">PGX <span>GATEWAY</span></div>
    <h2 style="color: #ffffff; margin: 0 0 12px 0; font-size: 18px;">Payment Settlement Confirmed</h2>
    <p style="color: #94a3b8; font-size: 14px; margin: 0;">Hello ${name}, a card payment has been successfully verified through your PGX checkout integration:</p>
    
    <div class="amount-box">
      <div style="font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px;">Gross Amount</div>
      <div class="amount">${txn.currency} ${txn.grossAmount.toFixed(2)}</div>
    </div>

    <table style="width: 100%; border-collapse: collapse; font-size: 13px; color: #e2e8f0;">
      <tr style="border-bottom: 1px solid rgba(255,255,255,0.06);">
        <td style="padding: 8px 0; color: #94a3b8;">Transaction ID</td>
        <td style="padding: 8px 0; text-align: right; font-family: monospace; font-weight: 600;">${txn.transactionId}</td>
      </tr>
      <tr style="border-bottom: 1px solid rgba(255,255,255,0.06);">
        <td style="padding: 8px 0; color: #94a3b8;">Order Reference</td>
        <td style="padding: 8px 0; text-align: right; font-weight: 600;">${txn.orderId || 'N/A'}</td>
      </tr>
      ${txn.merchantNetAmount !== undefined ? `
      <tr style="border-bottom: 1px solid rgba(255,255,255,0.06);">
        <td style="padding: 8px 0; color: #94a3b8;">Net Credited to Balance</td>
        <td style="padding: 8px 0; text-align: right; font-weight: 600; color: #34d399;">${txn.currency} ${txn.merchantNetAmount.toFixed(2)}</td>
      </tr>` : ''}
    </table>

    <div style="text-align: center; margin-top: 24px;">
      <a href="https://pgxgateway.com/login" style="color: #00f0ff; font-size: 13px; text-decoration: none; font-weight: 600;">View In Merchant Dashboard &rarr;</a>
    </div>

    <div class="footer">
      &copy; ${new Date().getFullYear()} PGX Gateway &bull; Automated Settlement Engine
    </div>
  </div>
</body>
</html>`

  const result = await sendEmail({ to: email, subject, html })
  return result.success
}
