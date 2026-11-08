import Stripe from 'stripe'

// Cache stripe instances by secret key to avoid instantiating repeatedly
const stripeInstances = new Map<string, Stripe>()

export function getStripeClient(secretKey: string): Stripe {
  const trimmed = secretKey.trim()
  if (!trimmed) {
    throw new Error('Stripe Secret Key is not configured for this reseller.')
  }

  let client = stripeInstances.get(trimmed)
  if (!client) {
    client = new Stripe(trimmed, {
      apiVersion: '2025-02-24.acacia' as Stripe.LatestApiVersion,
      typescript: true,
    })
    stripeInstances.set(trimmed, client)
  }

  return client
}

export interface CreateSessionParams {
  secretKey: string
  amount: number // in major units (e.g., 100.00 USD)
  currency?: string
  productName?: string
  merchantRefId: string
  resellerId: string
  orderId?: string
  customerEmail?: string
  successUrl: string
  cancelUrl: string
}

export async function createStripeCheckoutSession(params: CreateSessionParams): Promise<Stripe.Checkout.Session> {
  const stripe = getStripeClient(params.secretKey)
  const currency = (params.currency || 'USD').toLowerCase()
  const unitAmountCents = Math.round(params.amount * 100)

  if (unitAmountCents < 50) {
    throw new Error('Transaction amount must be at least $0.50.')
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: params.customerEmail || undefined,
    line_items: [
      {
        price_data: {
          currency,
          product_data: {
            name: params.productName || `Payment to ${params.merchantRefId}`,
            description: params.orderId ? `Order #${params.orderId}` : `Ref: ${params.merchantRefId}`,
          },
          unit_amount: unitAmountCents,
        },
        quantity: 1,
      },
    ],
    metadata: {
      merchant_ref_id: params.merchantRefId,
      reseller_id: params.resellerId,
      order_id: params.orderId || '',
    },
    payment_intent_data: {
      metadata: {
        merchant_ref_id: params.merchantRefId,
        reseller_id: params.resellerId,
        order_id: params.orderId || '',
      },
    },
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
  })

  return session
}

export function constructWebhookEvent(
  payload: Buffer | string,
  signature: string,
  webhookSecret: string
): Stripe.Event {
  const trimmedSecret = webhookSecret.trim()
  if (!trimmedSecret) {
    throw new Error('Stripe Webhook Secret is not configured for this reseller.')
  }

  // We can use any dummy stripe instance to verify signatures
  const stripe = new Stripe('dummy_key_for_webhook_signature', {
    apiVersion: '2025-02-24.acacia' as Stripe.LatestApiVersion,
  })

  return stripe.webhooks.constructEvent(payload, signature, trimmedSecret)
}
