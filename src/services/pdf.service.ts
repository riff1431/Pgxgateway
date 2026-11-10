import PDFDocument from 'pdfkit'
import { IInvoice } from '../models/Invoice.js'
import { IMerchant } from '../models/Merchant.js'

export async function generateInvoicePdfBuffer(
  invoice: IInvoice,
  merchant?: IMerchant | null,
  options?: {
    siteName?: string
    supportWhatsapp?: string
    supportEmail?: string
  }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin: 40,
        size: 'A4',
        info: {
          Title: `Invoice ${invoice.invoiceNumber}`,
          Author: 'PGX Gateway Platform',
          Subject: 'Merchant Platform Service Invoice',
        },
      })

      const chunks: Buffer[] = []
      doc.on('data', (chunk) => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', (err) => reject(err))

      const siteName = options?.siteName || 'PGX GATEWAY PLATFORM'
      const supportWhatsapp = options?.supportWhatsapp || '+1 (437) 577-8785'
      const supportEmail = options?.supportEmail || 'finance@pgxgateway.com'

      const isMaintenance = invoice.invoiceType === 'monthly_maintenance'
      const isPaid = invoice.status === 'paid'

      // ==========================================
      // 1. TOP HEADER ACCENT BAR & BRANDING
      // ==========================================
      // Draw top header brand strip (Dark slate & Cyan accent)
      doc.rect(0, 0, 595.28, 12).fill('#060b20')
      doc.rect(0, 8, 595.28, 4).fill('#00d4e6')

      // Main Branding
      doc.fontSize(22).fillColor('#060b20').font('Helvetica-Bold').text(siteName, 40, 35)
      doc.fontSize(8.5).fillColor('#64748b').font('Helvetica').text('Next-Generation Payment Gateway & Settlement Network', 40, 60)

      // Invoice Title & Status Badge (Right aligned)
      const invoiceTitle = isMaintenance ? 'MAINTENANCE INVOICE' : 'SETTLEMENT STATEMENT'
      doc.fontSize(16).fillColor('#0f172a').font('Helvetica-Bold').text(invoiceTitle, 350, 35, { align: 'right', width: 205 })

      const statusText = isPaid
        ? '● PAID & SETTLED'
        : invoice.status === 'overdue'
        ? '● OVERDUE (GRACE ACTIVE)'
        : '● PAYMENT DUE'
      const statusColor = isPaid ? '#10b981' : invoice.status === 'overdue' ? '#ef4444' : '#0284c7'
      const statusBg = isPaid ? '#ecfdf5' : invoice.status === 'overdue' ? '#fef2f2' : '#f0f9ff'

      // Status Pill
      doc.roundedRect(445, 58, 110, 20, 10).fillAndStroke(statusBg, statusColor)
      doc.fontSize(8).fillColor(statusColor).font('Helvetica-Bold').text(statusText, 445, 64, { align: 'center', width: 110 })

      // Divider Line
      doc.moveTo(40, 92).lineTo(555, 92).strokeColor('#e2e8f0').lineWidth(1).stroke()

      // ==========================================
      // 2. METADATA & PARTIES (BILLED TO / ISSUER)
      // ==========================================
      const metaY = 105

      // Left Column: Billed To (Merchant)
      doc.fontSize(8).fillColor('#94a3b8').font('Helvetica-Bold').text('BILLED TO (MERCHANT):', 40, metaY)
      doc.fontSize(12).fillColor('#0f172a').font('Helvetica-Bold').text(merchant?.legalName || invoice.merchantName, 40, metaY + 12)
      doc.fontSize(8.5).fillColor('#475569').font('Helvetica')
      doc.text(`Ref ID: ${merchant?.refId || 'PGX_MERCHANT'}`, 40, metaY + 28)
      doc.text(`Email: ${invoice.merchantEmail}`, 40, metaY + 40)
      if (merchant?.industry) {
        doc.text(`Industry: ${merchant.industry}`, 40, metaY + 52)
      }

      // Middle Column: Issuer Details
      doc.fontSize(8).fillColor('#94a3b8').font('Helvetica-Bold').text('ISSUED BY:', 220, metaY)
      doc.fontSize(9.5).fillColor('#0f172a').font('Helvetica-Bold').text('PGX Gateway Inc.', 220, metaY + 12)
      doc.fontSize(8.5).fillColor('#475569').font('Helvetica')
      doc.text(`Finance WhatsApp: ${supportWhatsapp}`, 220, metaY + 28)
      doc.text(`Billing Email: ${supportEmail}`, 220, metaY + 40)
      doc.text('Portal: https://pgxgateway.com', 220, metaY + 52)

      // Right Column: Invoice Details Box
      doc.roundedRect(380, metaY - 5, 175, 82, 6).fillAndStroke('#f8fafc', '#e2e8f0')
      doc.fontSize(8).fillColor('#64748b').font('Helvetica-Bold').text('Invoice #:', 392, metaY + 5)
      doc.fontSize(8).fillColor('#0f172a').font('Helvetica').text(invoice.invoiceNumber, 455, metaY + 5)

      doc.fontSize(8).fillColor('#64748b').font('Helvetica-Bold').text('Invoice Date:', 392, metaY + 19)
      doc.fontSize(8).fillColor('#0f172a').font('Helvetica').text(new Date(invoice.createdAt || invoice.billingCycleEnd).toLocaleDateString(), 455, metaY + 19)

      doc.fontSize(8).fillColor('#64748b').font('Helvetica-Bold').text('Due Date:', 392, metaY + 33)
      doc.fontSize(8).fillColor('#0f172a').font('Helvetica').text(new Date(invoice.dueDate).toLocaleDateString(), 455, metaY + 33)

      doc.fontSize(8).fillColor('#64748b').font('Helvetica-Bold').text('Cycle Period:', 392, metaY + 47)
      const periodStr = `${new Date(invoice.billingCycleStart).toLocaleDateString()} - ${new Date(invoice.billingCycleEnd).toLocaleDateString()}`
      doc.fontSize(7.5).fillColor('#0f172a').font('Helvetica').text(periodStr, 455, metaY + 47)

      doc.fontSize(8).fillColor('#64748b').font('Helvetica-Bold').text('Payment Rail:', 392, metaY + 61)
      const railStr = invoice.paymentMethod === 'stripe' ? 'Stripe Card (Auto-Debit)' : 'Bitcoin (BTC) / Wire'
      doc.fontSize(7.5).fillColor('#0f172a').font('Helvetica').text(railStr, 455, metaY + 61)

      // ==========================================
      // 3. ITEMIZED CHARGES TABLE
      // ==========================================
      const tableTop = 205

      // Header row
      doc.rect(40, tableTop, 515, 24).fill('#0f172a')
      doc.fontSize(8.5).fillColor('#ffffff').font('Helvetica-Bold')
      doc.text('LINE ITEM & SERVICE DESCRIPTION', 50, tableTop + 7)
      doc.text('RATE / BASIS', 330, tableTop + 7)
      doc.text('QTY', 430, tableTop + 7)
      doc.text('AMOUNT (USD)', 480, tableTop + 7, { align: 'right', width: 65 })

      let currentY = tableTop + 24

      if (isMaintenance) {
        // Line Item 1: Maintenance base
        const baseAmount = invoice.payableAmount - (invoice.surchargeAmount || 0)
        doc.rect(40, currentY, 515, 42).fill('#ffffff')
        doc.fontSize(9).fillColor('#0f172a').font('Helvetica-Bold').text('Monthly Platform Maintenance & Node Infrastructure SLA', 50, currentY + 8)
        doc.fontSize(7.5).fillColor('#64748b').font('Helvetica').text('30-day recurring gateway connectivity, security patches, 3D Secure, & 99.99% uptime SLA', 50, currentY + 22)

        doc.fontSize(8.5).fillColor('#0f172a').font('Helvetica').text('$99.00 / mo', 330, currentY + 12)
        doc.fontSize(8.5).fillColor('#0f172a').font('Helvetica').text('1', 430, currentY + 12)
        doc.fontSize(9).fillColor('#0f172a').font('Helvetica-Bold').text(`$${baseAmount.toFixed(2)}`, 480, currentY + 12, { align: 'right', width: 65 })

        currentY += 42

        // Line Item 2: 3% Surcharge (if present)
        if (invoice.surchargeAmount && invoice.surchargeAmount > 0) {
          doc.rect(40, currentY, 515, 36).fill('#f8fafc')
          doc.fontSize(9).fillColor('#0f172a').font('Helvetica-Bold').text('Stripe Card Processing Surcharge (3%)', 50, currentY + 8)
          doc.fontSize(7.5).fillColor('#64748b').font('Helvetica').text('Standard credit/debit card gateway interchange pass-through fee', 50, currentY + 20)

          doc.fontSize(8.5).fillColor('#0f172a').font('Helvetica').text('3.0%', 330, currentY + 10)
          doc.fontSize(8.5).fillColor('#0f172a').font('Helvetica').text('1', 430, currentY + 10)
          doc.fontSize(9).fillColor('#0f172a').font('Helvetica-Bold').text(`+$${invoice.surchargeAmount.toFixed(2)}`, 480, currentY + 10, { align: 'right', width: 65 })

          currentY += 36
        }
      } else {
        // Weekly volume line item
        doc.rect(40, currentY, 515, 42).fill('#ffffff')
        doc.fontSize(9).fillColor('#0f172a').font('Helvetica-Bold').text('Weekly Platform Processing Fee', 50, currentY + 8)
        doc.fontSize(7.5).fillColor('#64748b').font('Helvetica').text(`Aggregated on verified processing volume of $${(invoice.eligibleVolume || 0).toFixed(2)}`, 50, currentY + 22)

        doc.fontSize(8.5).fillColor('#0f172a').font('Helvetica').text(`${invoice.feeRate || 9.0}%`, 330, currentY + 12)
        doc.fontSize(8.5).fillColor('#0f172a').font('Helvetica').text('1', 430, currentY + 12)
        doc.fontSize(9).fillColor('#0f172a').font('Helvetica-Bold').text(`$${invoice.payableAmount.toFixed(2)}`, 480, currentY + 12, { align: 'right', width: 65 })

        currentY += 42
      }

      // Border line under items
      doc.moveTo(40, currentY).lineTo(555, currentY).strokeColor('#cbd5e1').lineWidth(1).stroke()

      // ==========================================
      // 4. SUMMARY TOTALS & RECONCILIATION
      // ==========================================
      const summaryTop = currentY + 15

      // Left box: Settlement & Ledger Reference
      doc.roundedRect(40, summaryTop, 290, 95, 6).fillAndStroke('#f8fafc', '#e2e8f0')
      doc.fontSize(8.5).fillColor('#0f172a').font('Helvetica-Bold').text('SETTLEMENT & AUDIT TRAIL', 52, summaryTop + 10)
      doc.fontSize(8).fillColor('#475569').font('Helvetica')
      doc.text(`Payment Status: ${isPaid ? 'Settled & Verified' : 'Awaiting Payment Settlement'}`, 52, summaryTop + 26)
      if (invoice.stripeSessionId) {
        doc.text(`Gateway Reference / PI: ${invoice.stripeSessionId}`, 52, summaryTop + 38)
      }
      if (invoice.paidAt) {
        doc.text(`Settled At: ${new Date(invoice.paidAt).toUTCString()}`, 52, summaryTop + 50)
      } else {
        doc.text(`Grace Period Active Until: ${new Date(invoice.dueDate).toLocaleDateString()}`, 52, summaryTop + 50)
      }
      doc.fontSize(7.5).fillColor('#64748b').text('Direct settlement available via Stripe or Bitcoin (BTC) on WhatsApp Desk.', 52, summaryTop + 68)

      // Right box: Financial Totals Table
      const totalsX = 350
      const totalWidth = 205

      const baseAmount = isMaintenance
        ? invoice.payableAmount - (invoice.surchargeAmount || 0)
        : invoice.payableAmount

      doc.fontSize(8.5).fillColor('#64748b').font('Helvetica').text('Base Subtotal:', totalsX, summaryTop + 5)
      doc.fontSize(8.5).fillColor('#0f172a').font('Helvetica-Bold').text(`$${baseAmount.toFixed(2)}`, totalsX, summaryTop + 5, { align: 'right', width: totalWidth })

      if (invoice.surchargeAmount && invoice.surchargeAmount > 0) {
        doc.fontSize(8.5).fillColor('#64748b').font('Helvetica').text('3% Card Surcharge:', totalsX, summaryTop + 20)
        doc.fontSize(8.5).fillColor('#0f172a').font('Helvetica-Bold').text(`+$${invoice.surchargeAmount.toFixed(2)}`, totalsX, summaryTop + 20, { align: 'right', width: totalWidth })
      }

      doc.moveTo(totalsX, summaryTop + 38).lineTo(totalsX + totalWidth, summaryTop + 38).strokeColor('#cbd5e1').lineWidth(0.5).stroke()

      // Grand Total Highlight
      doc.roundedRect(totalsX - 5, summaryTop + 44, totalWidth + 10, 32, 4).fill('#060b20')
      doc.fontSize(10).fillColor('#ffffff').font('Helvetica-Bold').text('TOTAL AMOUNT:', totalsX + 5, summaryTop + 54)
      doc.fontSize(12).fillColor('#00d4e6').font('Helvetica-Bold').text(`$${invoice.payableAmount.toFixed(2)} USD`, totalsX, summaryTop + 53, { align: 'right', width: totalWidth })

      // Paid / Balance Due
      doc.fontSize(8.5).fillColor('#10b981').font('Helvetica-Bold').text(`Amount Paid: ${isPaid ? `$${invoice.payableAmount.toFixed(2)}` : '$0.00'}`, totalsX, summaryTop + 84)
      doc.fontSize(8.5).fillColor(isPaid ? '#64748b' : '#ef4444').font('Helvetica-Bold').text(`Balance Due: ${isPaid ? '$0.00' : `$${invoice.payableAmount.toFixed(2)}`}`, totalsX, summaryTop + 84, { align: 'right', width: totalWidth })

      // ==========================================
      // 5. FOOTER & COMPLIANCE NOTES
      // ==========================================
      const footerY = 750
      doc.moveTo(40, footerY).lineTo(555, footerY).strokeColor('#e2e8f0').lineWidth(1).stroke()

      doc.fontSize(7.5).fillColor('#94a3b8').font('Helvetica').text(
        'This is an official computer-generated tax invoice issued by PGX Gateway Platform. All processing terms are governed by your Merchant Agreement.',
        40,
        footerY + 10,
        { align: 'center', width: 515 }
      )
      doc.fontSize(7).fillColor('#cbd5e1').text(
        `Document Ref: ${invoice.invoiceNumber} • Generated on ${new Date().toISOString()} • Bank-Grade 256-Bit SSL Protection`,
        40,
        footerY + 22,
        { align: 'center', width: 515 }
      )

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}
