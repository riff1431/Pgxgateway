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
  customerId?: string
  customerEmail?: string
  setupFutureUsage?: 'off_session' | 'on_session'
  successUrl: string
  cancelUrl: string
  metadata?: Record<string, string>
  lineItems?: Array<{
    name: string
    description?: string
    amount: number
    quantity?: number
  }>
}

export async function createStripeCheckoutSession(params: CreateSessionParams): Promise<Stripe.Checkout.Session> {
  const stripe = getStripeClient(params.secretKey)
  const currency = (params.currency || 'USD').toLowerCase()
  const unitAmountCents = Math.round(params.amount * 100)

  if (unitAmountCents < 50) {
    throw new Error('Transaction amount must be at least $0.50.')
  }

  const sessionLineItems: Stripe.Checkout.SessionCreateParams.LineItem[] =
    params.lineItems && params.lineItems.length > 0
      ? params.lineItems.map((item) => ({
          price_data: {
            currency,
            product_data: {
              name: item.name,
              description: item.description,
            },
            unit_amount: Math.round(item.amount * 100),
          },
          quantity: item.quantity || 1,
        }))
      : [
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
        ]

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'payment',
    line_items: sessionLineItems,
    metadata: {
      merchant_ref_id: params.merchantRefId,
      reseller_id: params.resellerId,
      order_id: params.orderId || '',
      ...(params.metadata || {}),
    },
    payment_intent_data: {
      setup_future_usage: params.setupFutureUsage || undefined,
      metadata: {
        merchant_ref_id: params.merchantRefId,
        reseller_id: params.resellerId,
        order_id: params.orderId || '',
        ...(params.metadata || {}),
      },
    },
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
  }

  if (params.customerId) {
    sessionParams.customer = params.customerId
  } else if (params.customerEmail) {
    sessionParams.customer_email = params.customerEmail
  }

  const session = await stripe.checkout.sessions.create(sessionParams)
  return session
}

export interface CreateCustomerParams {
  secretKey: string
  email: string
  name?: string
  merchantRefId?: string
  metadata?: Record<string, string>
}

export async function getOrCreateStripeCustomer(params: CreateCustomerParams): Promise<Stripe.Customer> {
  const stripe = getStripeClient(params.secretKey)
  const email = params.email.trim().toLowerCase()

  const existingCustomers = await stripe.customers.list({
    email,
    limit: 1,
  })

  if (existingCustomers.data && existingCustomers.data.length > 0) {
    return existingCustomers.data[0]
  }

  const newCustomer = await stripe.customers.create({
    email,
    name: params.name?.trim() || undefined,
    metadata: {
      merchant_ref_id: params.merchantRefId || '',
      ...(params.metadata || {}),
    },
  })

  return newCustomer
}

export interface OffSessionChargeParams {
  secretKey: string
  customerId: string
  amount: number // in major units (e.g. 101.97 USD)
  currency?: string
  description: string
  merchantRefId: string
  resellerId: string
  metadata?: Record<string, string>
}

export async function chargeStripeOffSession(params: OffSessionChargeParams): Promise<Stripe.PaymentIntent> {
  const stripe = getStripeClient(params.secretKey)
  const currency = (params.currency || 'usd').toLowerCase()
  const amountCents = Math.round(params.amount * 100)

  // Find saved payment methods for customer
  const paymentMethods = await stripe.paymentMethods.list({
    customer: params.customerId,
    type: 'card',
    limit: 5,
  })

  if (!paymentMethods.data || paymentMethods.data.length === 0) {
    throw new Error(`No saved card payment methods found on file for customer ${params.customerId}. Merchant must update billing card.`)
  }

  const defaultPaymentMethod = paymentMethods.data[0].id

  // Create and confirm PaymentIntent off-session
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency,
    customer: params.customerId,
    payment_method: defaultPaymentMethod,
    off_session: true,
    confirm: true,
    description: params.description,
    metadata: {
      merchant_ref_id: params.merchantRefId,
      reseller_id: params.resellerId,
      ...(params.metadata || {}),
    },
  })

  return paymentIntent
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
