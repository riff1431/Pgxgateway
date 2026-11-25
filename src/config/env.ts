import dotenv from 'dotenv'

dotenv.config()

const nodeEnv = process.env.NODE_ENV || 'development'
const isProd = nodeEnv === 'production'

const jwtSecret = process.env.JWT_SECRET || (isProd ? '' : 'pgx_dev_jwt_secret_change_me')
if (isProd && !jwtSecret) {
  throw new Error('[Config] FATAL: JWT_SECRET environment variable must be set in production.')
}

if (isProd && (!process.env.SUPERADMIN_PASSWORD || !process.env.ADMIN_PASSWORD)) {
  console.warn('[Config] Warning: SUPERADMIN_PASSWORD / ADMIN_PASSWORD not set in environment; set them explicitly in production.')
}

export const config = {
  env: nodeEnv,
  port: parseInt(process.env.PORT || '5000', 10),
  mongodbUri: process.env.MONGODB_URI || '',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
    url: process.env.CLOUDINARY_URL || '',
  },
  superAdmin: {
    email: process.env.SUPERADMIN_EMAIL || 'superadmin@pgxgateway.com',
    password: process.env.SUPERADMIN_PASSWORD || (isProd ? '' : 'SuperAdminPass2026!'),
    secretKey: process.env.SUPERADMIN_SECRET_KEY || '',
  },
  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@pgxgateway.com',
    password: process.env.ADMIN_PASSWORD || (isProd ? '' : 'AdminSecurePass2026!'),
    secretKey: process.env.ADMIN_SECRET_KEY || '',
  },
  ecomBridge: {
    url: process.env.ECOM_BRIDGE_URL || 'https://api.pgxmarketplace.shop',
    secret: process.env.GATEWAY_BRIDGE_SECRET || '',
    enabled: process.env.ENABLE_ECOM_BRIDGE !== 'false',
  },
  bridges: {
    marketplace: {
      id: 'marketplace' as const,
      name: 'PGX MarketPlace (Stripe #1 - Digital SaaS)',
      domain: 'pgxmarketplace.shop',
      url: process.env.ECOM_BRIDGE_1_URL || process.env.ECOM_BRIDGE_URL || 'https://api.pgxmarketplace.shop',
      secret: process.env.GATEWAY_BRIDGE_1_SECRET || process.env.GATEWAY_BRIDGE_SECRET || '',
      enabled: process.env.ENABLE_BRIDGE_1 !== 'false',
    },
    leads: {
      id: 'leads' as const,
      name: 'PGX Leads (Stripe #2 - B2B Intel)',
      domain: 'pgxleads.shop',
      url: process.env.ECOM_BRIDGE_2_URL || process.env.ECOM_BRIDGE_LEADS_URL || 'https://pgxleads.shop',
      secret: process.env.GATEWAY_BRIDGE_2_SECRET || process.env.GATEWAY_BRIDGE_LEADS_SECRET || '',
      enabled: process.env.ENABLE_BRIDGE_2 !== 'false',
    },
  },
  resellerArxo: {
    apiKey: process.env.ARXO_RESELLER_API_KEY || '',
  },
  mailgun: {
    apiKey: process.env.MAILGUN_API_KEY || '',
    domain: process.env.MAILGUN_DOMAIN || 'pgxgateway.com',
    from: process.env.MAILGUN_FROM || 'PGX Gateway <support@pgxgateway.com>',
  },
}
