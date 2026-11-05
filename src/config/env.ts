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
}
