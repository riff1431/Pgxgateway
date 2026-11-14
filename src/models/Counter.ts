import mongoose, { Document, Schema } from 'mongoose'

export interface ICounter {
  _id: string
  seq: number
}

const CounterSchema = new Schema<ICounter>({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
})

export const Counter = mongoose.model<ICounter>('Counter', CounterSchema)

/**
 * Atomically increments and returns the next integer sequence for a given identifier.
 */
export async function getNextSequence(sequenceName: string): Promise<number> {
  const counter = await Counter.findByIdAndUpdate(
    sequenceName,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  )
  return counter.seq
}

/**
 * Returns a formatted sequential identifier such as ARXO-0001, ARXO-0002...
 */
export async function getNextFormattedId(prefix: string, padLength = 4): Promise<string> {
  const seq = await getNextSequence(`${prefix}_SEQ`)
  return `${prefix}-${String(seq).padStart(padLength, '0')}`
}
