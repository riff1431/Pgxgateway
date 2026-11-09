import dns from 'node:dns'
import mongoose from 'mongoose'
import { config } from './env.js'

// Configure public DNS resolvers to ensure Atlas SRV lookups work reliably on Windows
try {
  dns.setServers(['8.8.8.8', '1.1.1.1'])
} catch {
  // Ignore in environments where custom DNS servers cannot be set
}

export async function connectDB(): Promise<void> {
  try {
    const conn = await mongoose.connect(config.mongodbUri, {
      maxPoolSize: 20,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000,
    })
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
