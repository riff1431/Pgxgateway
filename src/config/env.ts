import dotenv from 'dotenv'

dotenv.config()

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '5000', 10),
  mongodbUri:
    process.env.MONGODB_URI ||
    'mongodb+srv://huippertechnology_db_user:sRmWI22kylD9yT0I@cluster0.flqb6iy.mongodb.net/pgxdb?retryWrites=true&w=majority&appName=Cluster0',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  jwtSecret: process.env.JWT_SECRET || 'pgx_secret_key_super_secure_jwt_token_2026_fintech_auth',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || 'wumsaw2a',
    apiKey: process.env.CLOUDINARY_API_KEY || '276828639658817',
    apiSecret: process.env.CLOUDINARY_API_SECRET || 'r4otxf3HaqwbyJIo4D4NXK8WRT4',
    url: process.env.CLOUDINARY_URL || 'cloudinary://276828639658817:r4otxf3HaqwbyJIo4D4NXK8WRT4@wumsaw2a',
  },
  superAdmin: {
    email: process.env.SUPERADMIN_EMAIL || 'superadmin@pgxgateway.com',
    password: process.env.SUPERADMIN_PASSWORD || 'SuperAdminPass2026!',
    secretKey: process.env.SUPERADMIN_SECRET_KEY || 'pgx_superadmin_master_secret_2026',
  },
  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@pgxgateway.com',
    password: process.env.ADMIN_PASSWORD || 'AdminSecurePass2026!',
    secretKey: process.env.ADMIN_SECRET_KEY || 'pgx_admin_secret_super_secure_key_2026',
  },
  ecomBridge: {
    url: process.env.ECOM_BRIDGE_URL || 'http://localhost:4000',
    secret: process.env.GATEWAY_BRIDGE_SECRET || 'pgx-digital-super-secret-gateway-bridge-key-2026',
    enabled: process.env.ENABLE_ECOM_BRIDGE !== 'false',
  },
  resellerArxo: {
    apiKey: process.env.ARXO_RESELLER_API_KEY || 'pgx_reseller_arxo_live_secret_key_2026',
  },
}
