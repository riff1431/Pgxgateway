import mongoose from 'mongoose'
import { config } from './env.js'

export async function connectDB(): Promise<void> {
  try {
    const conn = await mongoose.connect(config.mongodbUri)
    console.log(`[MongoDB] Connected to database: ${conn.connection.name} @ ${conn.connection.host}`)
  } catch (error) {
    console.error('[MongoDB] Connection error:', error instanceof Error ? error.message : error)
    process.exit(1)
  }

  mongoose.connection.on('disconnected', () => {
    console.warn('[MongoDB] Disconnected from database.')
  })

  mongoose.connection.on('error', (err) => {
    console.error('[MongoDB] Runtime error:', err)
  })
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect()
  console.log('[MongoDB] Connection closed.')
}
