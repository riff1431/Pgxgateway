import crypto from 'node:crypto'
import { SystemConfig } from '../models/SystemConfig.js'

const ONEPAY_API_BASE = 'https://api.1pay.cx'
const DEFAULT_WEBHOOK_WINDOW_SEC = 300

export interface OnePayPaymentResponse {
  id: string
  amount: number
  currency: string
  status: 'pending' | 'paid' | 'underpaid' | 'expired' | 'failed' | string
  reference?: string | null
  livemode?: boolean
  email?: string | null
  paidAt?: string | null
  url?: string
  checkoutUrl?: string
  txidOut?: string | null
  asset?: string | null
}

/**
 * Loads 1pay.cx DB credentials from SystemConfig. Credentials live solely in MongoDB.
 */
export async function getOnePayDbConfig() {
  const sysConfig = await SystemConfig.findOne()
  const onePay = sysConfig?.onePay
  return { sysConfig, onePay }
}

function getApiKeyForMode(
  onePay: NonNullable<Awaited<ReturnType<typeof getOnePayDbConfig>>['onePay']>,
  mode: 'test' | 'live'
): string {
  return mode === 'live' ? (onePay.liveApiKey || '').trim() : (onePay.testApiKey || '').trim()
}

function isSameHostIgnoreWww(a?: string, b?: string): boolean {
  if (!a || !b) return false
  try {
    const hostA = new URL(a).hostname.replace(/^www\./i, '').toLowerCase()
    const hostB = new URL(b).hostname.replace(/^www\./i, '').toLowerCase()
    return Boolean(hostA && hostA === hostB)
  } catch {
    return false
  }
}

function isValidHttpUrl(url?: string, httpsOnly = false): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return httpsOnly ? parsed.protocol === 'https:' : parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Creates a hosted Card-to-Crypto payment session via 1pay.cx POST /v1/payments.
 */
export async function createOnePayPayment(params: {
  amount: number
  currency?: string
  email?: string
  productName?: string
  reference?: string
  redirectUrl?: string
  cancelUrl?: string
  mode: 'test' | 'live'
  idempotencyKey?: string
}): Promise<{ id: string; checkoutUrl: string; livemode: boolean }> {
  const { onePay } = await getOnePayDbConfig()
  if (!onePay || !onePay.enabled) {
    throw new Error('1pay.cx processor is disabled or not configured in Platform Settings.')
  }

  const apiKey = getApiKeyForMode(onePay, params.mode)
  if (!apiKey) {
    throw new Error(
      `1pay.cx ${params.mode.toUpperCase()} API key is not configured in database Platform Settings.`
    )
  }

  const payload: Record<string, unknown> = {
    amount: Math.round(params.amount * 100) / 100,
    currency: (params.currency || 'USD').toUpperCase().slice(0, 3),
  }

  if (params.email?.trim()) {
    payload.email = params.email.trim().slice(0, 200)
  }
  if (params.productName?.trim()) {
    payload.productName = params.productName.trim().slice(0, 200)
  }
  if (params.reference?.trim()) {
    payload.reference = params.reference.trim().slice(0, 128)
  }

  const cleanRedirect = params.redirectUrl?.trim()
  const cleanCancel = params.cancelUrl?.trim()
  const cleanNotify = onePay.webhookUrl?.trim()

  if (isValidHttpUrl(cleanRedirect)) {
    payload.redirectUrl = cleanRedirect
  }

  // Per 1pay.cx OpenAPI: notifyUrl must be HTTPS (even in test mode).
  if (isValidHttpUrl(cleanNotify, true)) {
    payload.notifyUrl = cleanNotify
  }

  // Per 1pay.cx OpenAPI: cancelUrl must share host with redirectUrl or notifyUrl.
  if (
    isValidHttpUrl(cleanCancel) &&
    (isSameHostIgnoreWww(cleanCancel, cleanRedirect) || isSameHostIgnoreWww(cleanCancel, cleanNotify))
  ) {
    payload.cancelUrl = cleanCancel
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
  if (params.idempotencyKey?.trim()) {
    headers['Idempotency-Key'] = params.idempotencyKey.trim().slice(0, 128)
  }

  const resp = await fetch(`${ONEPAY_API_BASE}/v1/payments`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`1pay.cx API error (${resp.status}): ${errText || resp.statusText}`)
  }

  const data = (await resp.json()) as { id?: string; checkoutUrl?: string; url?: string }
  let checkoutUrl = data.url || data.checkoutUrl
  if (!data.id || !checkoutUrl) {
    throw new Error('1pay.cx API returned an invalid payment response without payment ID or checkout URL.')
  }

  // When White-Label Custom Checkout is enabled, always route buyers to PGX's custom /checkout/:id page
  if (onePay.customCheckoutEnabled) {
    const frontendBase = (onePay.customCheckoutFrontendBase || 'https://pgxgateway.com').trim().replace(/\/+$/, '')
    checkoutUrl = `${frontendBase}/checkout/${encodeURIComponent(data.id)}`
  }

  return {
    id: data.id,
    checkoutUrl,
    livemode: params.mode === 'live',
  }
}

/**
 * Fetches payment status from 1pay.cx GET /v1/payments/{id}, trying the hinted mode first
 * and falling back to the alternate key when mode isn't stored yet.
 */
export async function getOnePayPayment(
  paymentId: string,
  hintedMode?: 'test' | 'live'
): Promise<OnePayPaymentResponse | null> {
  const { onePay } = await getOnePayDbConfig()
  if (!onePay) return null

  const candidateKeys =
    hintedMode === 'test'
      ? [onePay.testApiKey, onePay.liveApiKey]
      : hintedMode === 'live'
        ? [onePay.liveApiKey, onePay.testApiKey]
        : [onePay.liveApiKey, onePay.testApiKey]

  const keys = Array.from(new Set(candidateKeys.map((k) => (k || '').trim()).filter(Boolean)))
  for (const key of keys) {
    const resp = await fetch(`${ONEPAY_API_BASE}/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    })

    if (resp.ok) {
      return (await resp.json()) as OnePayPaymentResponse
    }
    if (resp.status !== 401 && resp.status !== 403 && resp.status !== 404) {
      throw new Error(`1pay.cx payment lookup failed (${resp.status})`)
    }
  }

  return null
}

function safeHexEqual(expectedHex: string, candidateHex: string): boolean {
  const cleanCandidate = candidateHex.trim().toLowerCase()
  if (!/^[0-9a-f]+$/.test(cleanCandidate) || expectedHex.length !== cleanCandidate.length) {
    return false
  }
  return crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(cleanCandidate, 'hex'))
}

/**
 * Verifies 1pay.cx webhooks using X-1pay-Signature-V2 (`t=<sec>,v1=<hex>`) with 300s replay
 * protection, falling back to legacy X-1pay-Signature (`<hex>`). Checks all configured DB secrets.
 */
export function verifyOnePayWebhookSignature(
  rawBody: string,
  headers: { v2?: string; v1?: string },
  secrets: string[]
): { valid: boolean; reason?: string } {
  const cleanSecrets = Array.from(new Set(secrets.map((s) => s.trim()).filter(Boolean)))
  if (cleanSecrets.length === 0) {
    return { valid: false, reason: 'No 1pay.cx webhook secrets configured in database.' }
  }

  if (headers.v2?.trim()) {
    const parts = headers.v2.split(',').map((p) => p.trim())
    let timestamp = ''
    const signatures: string[] = []
    for (const part of parts) {
      if (part.startsWith('t=')) {
        timestamp = part.slice(2).trim()
      } else if (part.startsWith('v1=')) {
        signatures.push(part.slice(3).trim())
      }
    }

    const tsNum = Number(timestamp)
    if (!timestamp || !Number.isFinite(tsNum) || signatures.length === 0) {
      return { valid: false, reason: 'Malformed X-1pay-Signature-V2 header.' }
    }

    const nowSec = Math.floor(Date.now() / 1000)
    if (Math.abs(nowSec - tsNum) > DEFAULT_WEBHOOK_WINDOW_SEC) {
      return { valid: false, reason: 'Webhook signature timestamp outside allowed replay window.' }
    }

    const signedPayload = `${timestamp}.${rawBody}`
    for (const secret of cleanSecrets) {
      const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex')
      if (signatures.some((sig) => safeHexEqual(expected, sig))) {
        return { valid: true }
      }
    }
    return { valid: false, reason: 'Signature mismatch for X-1pay-Signature-V2.' }
  }

  if (headers.v1?.trim()) {
    for (const secret of cleanSecrets) {
      const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
      if (safeHexEqual(expected, headers.v1)) {
        return { valid: true }
      }
    }
    return { valid: false, reason: 'Signature mismatch for X-1pay-Signature.' }
  }

  return { valid: false, reason: 'Missing X-1pay-Signature-V2 or X-1pay-Signature header.' }
}
