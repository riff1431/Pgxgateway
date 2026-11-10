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
        margin: 48,
        size: 'A4',
        info: {
          Title: `Tax Invoice ${invoice.invoiceNumber}`,
          Author: 'PGX Gateway Platform',
          Subject: 'Official Merchant Service Statement',
        },
      })

      const chunks: Buffer[] = []
      doc.on('data', (chunk) => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', (err) => reject(err))

      const siteName = options?.siteName || 'PGX GATEWAY'
      const supportWhatsapp = options?.supportWhatsapp || '+1 (437) 577-8785'
      const supportEmail = options?.supportEmail || 'finance@pgxgateway.com'

      const isMaintenance = invoice.invoiceType === 'monthly_maintenance'
      const isPaid = invoice.status === 'paid'
      const isOverdue = invoice.status === 'overdue'

      // ==========================================
      // 1. TOP BRAND ACCENT BAR
      // ==========================================
      doc.rect(0, 0, 595.28, 6).fill('#0A1128')
      doc.rect(0, 6, 595.28, 3).fill('#00D4E6')

      // ==========================================
      // 2. HEADER: BRANDING & INVOICE TITLE
      // ==========================================
      // Left: Platform Logo & Title
      doc.fontSize(20).fillColor('#0A1128').font('Helvetica-Bold').text(siteName, 48, 32)
      doc.fontSize(7).fillColor('#64748B').font('Helvetica-Bold').text(
        'ENTERPRISE PAYMENT ACQUIRING & SETTLEMENT NETWORK',
        48,
        56
      )

      // Right: Document Title & Invoice Number
      const invoiceTypeLabel = isMaintenance ? 'MAINTENANCE INVOICE' : 'SETTLEMENT STATEMENT'
      doc.fontSize(16).fillColor('#0F172A').font('Helvetica-Bold').text(invoiceTypeLabel, 300, 32, {
        align: 'right',
        width: 248,
      })
      doc.fontSize(9).fillColor('#0284C7').font('Helvetica-Bold').text(`#${invoice.invoiceNumber}`, 300, 52, {
        align: 'right',
        width: 248,
      })

      // Status Pill (Using pure vector shapes to eliminate any unicode '%ǐ' font bug)
      const badgeW = 105
      const badgeH = 20
      const badgeX = 548 - badgeW
      const badgeY = 68

      const badgeFill = isPaid ? '#ECFDF5' : isOverdue ? '#FEF2F2' : '#F0F9FF'
      const badgeBorder = isPaid ? '#10B981' : isOverdue ? '#EF4444' : '#0284C7'
      const badgeDot = isPaid ? '#10B981' : isOverdue ? '#EF4444' : '#0284C7'
      const badgeText = isPaid ? 'PAID & SETTLED' : isOverdue ? 'OVERDUE' : 'PAYMENT DUE'
      const badgeTextColor = isPaid ? '#065F46' : isOverdue ? '#991B1B' : '#075985'

      doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 10).fillAndStroke(badgeFill, badgeBorder)
      // Vector dot (No unicode character)
      doc.circle(badgeX + 12, badgeY + 10, 3).fill(badgeDot)
      doc.fontSize(7.5).fillColor(badgeTextColor).font('Helvetica-Bold').text(
        badgeText,
        badgeX + 18,
        badgeY + 6.5,
        { width: badgeW - 20, align: 'center' }
      )

      // Divider line
      doc.moveTo(48, 98).lineTo(548, 98).strokeColor('#E2E8F0').lineWidth(0.8).stroke()

      // ==========================================
      // 3. HORIZONTAL 4-CHAMBER SUMMARY STRIP
      // ==========================================
      const stripY = 110
      const stripW = 500
      const stripH = 46
      doc.roundedRect(48, stripY, stripW, stripH, 6).fillAndStroke('#F8FAFC', '#E2E8F0')

      const colW = stripW / 4

      // Box 1: Invoice Date
      doc.fontSize(7).fillColor('#64748B').font('Helvetica-Bold').text('INVOICE DATE', 48 + 12, stripY + 10)
      doc.fontSize(8.5).fillColor('#0F172A').font('Helvetica-Bold').text(
        new Date(invoice.createdAt || invoice.billingCycleEnd).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        48 + 12,
        stripY + 24
      )

      // Box 2: Due Date
      doc.fontSize(7).fillColor('#64748B').font('Helvetica-Bold').text('PAYMENT DUE', 48 + colW + 8, stripY + 10)
      doc.fontSize(8.5).fillColor('#0F172A').font('Helvetica-Bold').text(
        new Date(invoice.dueDate).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        48 + colW + 8,
        stripY + 24
      )

      // Box 3: Billing Cycle
      doc.fontSize(7).fillColor('#64748B').font('Helvetica-Bold').text('BILLING CYCLE', 48 + colW * 2 + 8, stripY + 10)
      const startStr = new Date(invoice.billingCycleStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      const endStr = new Date(invoice.billingCycleEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      doc.fontSize(8).fillColor('#0F172A').font('Helvetica-Bold').text(
        `${startStr} – ${endStr}`,
        48 + colW * 2 + 8,
        stripY + 24
      )

      // Box 4: Payment Channel
      doc.fontSize(7).fillColor('#64748B').font('Helvetica-Bold').text('SETTLEMENT CHANNEL', 48 + colW * 3 + 8, stripY + 10)
      const channelLabel = invoice.paymentMethod === 'stripe' ? 'Stripe Card (Auto-Debit)' : 'Bitcoin (BTC) Manual'
      doc.fontSize(8).fillColor('#0284C7').font('Helvetica-Bold').text(
        channelLabel,
        48 + colW * 3 + 8,
        stripY + 24
      )

      // Vertical dividers inside summary strip
      for (let i = 1; i <= 3; i++) {
        doc.moveTo(48 + colW * i, stripY + 8).lineTo(48 + colW * i, stripY + stripH - 8).strokeColor('#E2E8F0').lineWidth(0.8).stroke()
      }

      // ==========================================
      // 4. PARTIES: BILLED TO vs ISSUED BY
      // ==========================================
      const partiesY = 175

      // Left Column: Billed To (Merchant)
      doc.fontSize(7.5).fillColor('#94A3B8').font('Helvetica-Bold').text('BILLED TO (MERCHANT):', 48, partiesY)
      doc.fontSize(11).fillColor('#0F172A').font('Helvetica-Bold').text(
        merchant?.legalName || invoice.merchantName,
        48,
        partiesY + 14
      )
      doc.fontSize(8.5).fillColor('#475569').font('Helvetica')
      doc.text(`Merchant Ref ID: ${merchant?.refId || 'PGX_MERCHANT'}`, 48, partiesY + 30)
      doc.text(`Account Email: ${invoice.merchantEmail}`, 48, partiesY + 44)
      if (merchant?.industry) {
        doc.text(`Industry / Sector: ${merchant.industry}`, 48, partiesY + 58)
      }

      // Right Column: Issued By
      const issuerX = 310
      doc.fontSize(7.5).fillColor('#94A3B8').font('Helvetica-Bold').text('ISSUED BY (GATEWAY OPERATOR):', issuerX, partiesY)
      doc.fontSize(11).fillColor('#0F172A').font('Helvetica-Bold').text('PGX Gateway Inc.', issuerX, partiesY + 14)
      doc.fontSize(8.5).fillColor('#475569').font('Helvetica')
      doc.text(`Official Finance Desk: ${supportWhatsapp}`, issuerX, partiesY + 30)
      doc.text(`Billing & Support: ${supportEmail}`, issuerX, partiesY + 44)
      doc.text('Verification Portal: https://pgxgateway.com', issuerX, partiesY + 58)

      // ==========================================
      // 5. ITEMIZED CHARGES TABLE
      // ==========================================
      const tableTop = 260
      const tableW = 500

      // Table Header Row
      doc.rect(48, tableTop, tableW, 26).fill('#0F172A')
      doc.fontSize(8).fillColor('#FFFFFF').font('Helvetica-Bold')
      doc.text('ITEM & SERVICE SPECIFICATION', 60, tableTop + 8)
      doc.text('BILLING BASIS', 300, tableTop + 8)
      doc.text('QTY', 420, tableTop + 8, { align: 'center', width: 30 })
      doc.text('AMOUNT (USD)', 465, tableTop + 8, { align: 'right', width: 73 })

      let rowY = tableTop + 26

      if (isMaintenance) {
        // Line Item 1: Monthly Maintenance Base Fee
        const baseAmount = invoice.payableAmount - (invoice.surchargeAmount || 0)
        doc.rect(48, rowY, tableW, 44).fill('#FFFFFF')
        doc.fontSize(9).fillColor('#0F172A').font('Helvetica-Bold').text(
          'Monthly Platform Maintenance & Node SLA',
          60,
          rowY + 9
        )
        doc.fontSize(7.5).fillColor('#64748B').font('Helvetica').text(
          'Continuous gateway uptime, security patches, 3DS 2.0 liability shift, & 99.99% uptime guarantee',
          60,
          rowY + 24
        )

        doc.fontSize(8.5).fillColor('#0F172A').font('Helvetica').text('$99.00 / mo', 300, rowY + 14)
        doc.fontSize(8.5).fillColor('#0F172A').font('Helvetica').text('1', 420, rowY + 14, { align: 'center', width: 30 })
        doc.fontSize(9.5).fillColor('#0F172A').font('Helvetica-Bold').text(
          `$${baseAmount.toFixed(2)}`,
          465,
          rowY + 14,
          { align: 'right', width: 73 }
        )

        doc.moveTo(48, rowY + 44).lineTo(548, rowY + 44).strokeColor('#E2E8F0').lineWidth(0.5).stroke()
        rowY += 44

        // Line Item 2: 3% Surcharge (if present)
        if (invoice.surchargeAmount && invoice.surchargeAmount > 0) {
          doc.rect(48, rowY, tableW, 40).fill('#F8FAFC')
          doc.fontSize(9).fillColor('#0F172A').font('Helvetica-Bold').text(
            'Stripe Card Processing Surcharge (3%)',
            60,
            rowY + 9
          )
          doc.fontSize(7.5).fillColor('#64748B').font('Helvetica').text(
            'Standard 3% credit/debit card gateway interchange pass-through fee',
            60,
            rowY + 23
          )

          doc.fontSize(8.5).fillColor('#0F172A').font('Helvetica').text('3.0%', 300, rowY + 13)
          doc.fontSize(8.5).fillColor('#0F172A').font('Helvetica').text('1', 420, rowY + 13, { align: 'center', width: 30 })
          doc.fontSize(9.5).fillColor('#0F172A').font('Helvetica-Bold').text(
            `+$${invoice.surchargeAmount.toFixed(2)}`,
            465,
            rowY + 13,
            { align: 'right', width: 73 }
          )

          doc.moveTo(48, rowY + 40).lineTo(548, rowY + 40).strokeColor('#E2E8F0').lineWidth(0.5).stroke()
          rowY += 40
        }
      } else {
        // Line Item: Weekly Volume
        doc.rect(48, rowY, tableW, 44).fill('#FFFFFF')
        doc.fontSize(9).fillColor('#0F172A').font('Helvetica-Bold').text(
          'Weekly Platform Processing Fee',
          60,
          rowY + 9
        )
        doc.fontSize(7.5).fillColor('#64748B').font('Helvetica').text(
          `Aggregated fee on verified transaction volume of $${(invoice.eligibleVolume || 0).toFixed(2)}`,
          60,
          rowY + 24
        )

        doc.fontSize(8.5).fillColor('#0F172A').font('Helvetica').text(`${invoice.feeRate || 9.0}%`, 300, rowY + 14)
        doc.fontSize(8.5).fillColor('#0F172A').font('Helvetica').text('1', 420, rowY + 14, { align: 'center', width: 30 })
        doc.fontSize(9.5).fillColor('#0F172A').font('Helvetica-Bold').text(
          `$${invoice.payableAmount.toFixed(2)}`,
          465,
          rowY + 14,
          { align: 'right', width: 73 }
        )

        doc.moveTo(48, rowY + 44).lineTo(548, rowY + 44).strokeColor('#E2E8F0').lineWidth(0.5).stroke()
        rowY += 44
      }

      // Outer table border
      doc.rect(48, tableTop, tableW, rowY - tableTop).strokeColor('#CBD5E1').lineWidth(0.8).stroke()

      // ==========================================
      // 6. TOTALS & SETTLEMENT RECONCILIATION
      // ==========================================
      const blockY = rowY + 20

      // Left Column: Settlement & Audit Trail
      const auditW = 260
      const auditH = 110
      doc.roundedRect(48, blockY, auditW, auditH, 6).fillAndStroke('#F8FAFC', '#E2E8F0')

      doc.fontSize(8).fillColor('#0F172A').font('Helvetica-Bold').text('SETTLEMENT & AUDIT TRAIL', 60, blockY + 12)

      doc.fontSize(8).fillColor('#64748B').font('Helvetica')
      doc.text('Payment Status:', 60, blockY + 30)
      doc.fontSize(8).fillColor(isPaid ? '#10B981' : '#EF4444').font('Helvetica-Bold').text(
        isPaid ? 'Settled & Reconciled' : 'Pending Settlement',
        155,
        blockY + 30
      )

      doc.fontSize(8).fillColor('#64748B').font('Helvetica')
      doc.text('Settlement Rail:', 60, blockY + 45)
      doc.fontSize(8).fillColor('#0F172A').font('Helvetica').text(
        invoice.paymentMethod === 'stripe' ? 'Stripe Card Auto-Debit' : 'Bitcoin (BTC) Desk',
        155,
        blockY + 45
      )

      if (invoice.stripeSessionId) {
        doc.fontSize(8).fillColor('#64748B').font('Helvetica').text('Gateway PI Ref:', 60, blockY + 60)
        doc.fontSize(7.5).fillColor('#0F172A').font('Helvetica').text(
          invoice.stripeSessionId.slice(0, 24),
          155,
          blockY + 60
        )
      }

      doc.fontSize(8).fillColor('#64748B').font('Helvetica').text('Settlement Date:', 60, blockY + 75)
      doc.fontSize(8).fillColor('#0F172A').font('Helvetica').text(
        invoice.paidAt ? new Date(invoice.paidAt).toUTCString().slice(0, 22) : 'Awaiting Payment',
        155,
        blockY + 75
      )

      doc.fontSize(7).fillColor('#94A3B8').font('Helvetica').text(
        'Direct settlement available via Stripe or Bitcoin (BTC) on WhatsApp Desk.',
        60,
        blockY + 92
      )

      // Right Column: Totals Calculation Card
      const totalsX = 330
      const totalsW = 218
      const baseSubtotal = isMaintenance
        ? invoice.payableAmount - (invoice.surchargeAmount || 0)
        : invoice.payableAmount

      doc.fontSize(8.5).fillColor('#64748B').font('Helvetica').text('Base Subtotal:', totalsX, blockY + 5)
      doc.fontSize(9).fillColor('#0F172A').font('Helvetica-Bold').text(
        `$${baseSubtotal.toFixed(2)} USD`,
        totalsX,
        blockY + 5,
        { align: 'right', width: totalsW }
      )

      if (invoice.surchargeAmount && invoice.surchargeAmount > 0) {
        doc.fontSize(8.5).fillColor('#64748B').font('Helvetica').text('Card Processing (3%):', totalsX, blockY + 22)
        doc.fontSize(9).fillColor('#0F172A').font('Helvetica-Bold').text(
          `+$${invoice.surchargeAmount.toFixed(2)} USD`,
          totalsX,
          blockY + 22,
          { align: 'right', width: totalsW }
        )
      }

      doc.moveTo(totalsX, blockY + 40).lineTo(totalsX + totalsW, blockY + 40).strokeColor('#CBD5E1').lineWidth(0.8).stroke()

      // High-contrast Grand Total Block
      const grandTotalY = blockY + 48
      doc.roundedRect(totalsX, grandTotalY, totalsW, 36, 6).fill('#0A1128')
      doc.fontSize(9).fillColor('#FFFFFF').font('Helvetica-Bold').text('TOTAL AMOUNT:', totalsX + 12, grandTotalY + 13)
      doc.fontSize(13).fillColor('#00F0FF').font('Helvetica-Bold').text(
        `$${invoice.payableAmount.toFixed(2)} USD`,
        totalsX,
        grandTotalY + 11,
        { align: 'right', width: totalsW - 12 }
      )

      // Payment summary
      doc.fontSize(8.5).fillColor('#10B981').font('Helvetica-Bold').text(
        `Amount Paid: ${isPaid ? `$${invoice.payableAmount.toFixed(2)}` : '$0.00'}`,
        totalsX,
        grandTotalY + 44
      )
      doc.fontSize(8.5).fillColor(isPaid ? '#64748B' : '#EF4444').font('Helvetica-Bold').text(
        `Balance Due: ${isPaid ? '$0.00' : `$${invoice.payableAmount.toFixed(2)}`}`,
        totalsX,
        grandTotalY + 44,
        { align: 'right', width: totalsW }
      )

      // ==========================================
      // 7. ENTERPRISE GUARANTEES & NOTICE STRIP
      // ==========================================
      const noticeY = 515
      doc.roundedRect(48, noticeY, 500, 68, 6).fillAndStroke('#F8FAFC', '#E2E8F0')

      const featColW = 500 / 3

      // Col 1
      doc.fontSize(8).fillColor('#0A1128').font('Helvetica-Bold').text('BANK-GRADE SECURITY', 48 + 14, noticeY + 14)
      doc.fontSize(7.5).fillColor('#64748B').font('Helvetica').text(
        'Protected by 3DS 2.0 liability shift and 256-bit SSL encryption.',
        48 + 14,
        noticeY + 28,
        { width: featColW - 24 }
      )

      // Col 2
      doc.fontSize(8).fillColor('#0A1128').font('Helvetica-Bold').text('99.99% UPTIME SLA', 48 + featColW + 10, noticeY + 14)
      doc.fontSize(7.5).fillColor('#64748B').font('Helvetica').text(
        'Continuous server monitoring, automated node updates, and failover.',
        48 + featColW + 10,
        noticeY + 28,
        { width: featColW - 24 }
      )

      // Col 3
      doc.fontSize(8).fillColor('#0A1128').font('Helvetica-Bold').text('DIRECT DESK ASSISTANCE', 48 + featColW * 2 + 10, noticeY + 14)
      doc.fontSize(7.5).fillColor('#64748B').font('Helvetica').text(
        `Instant support on WhatsApp: ${supportWhatsapp}`,
        48 + featColW * 2 + 10,
        noticeY + 28,
        { width: featColW - 24 }
      )

      // Vertical dividers inside feature strip
      doc.moveTo(48 + featColW, noticeY + 10).lineTo(48 + featColW, noticeY + 58).strokeColor('#E2E8F0').lineWidth(0.8).stroke()
      doc.moveTo(48 + featColW * 2, noticeY + 10).lineTo(48 + featColW * 2, noticeY + 58).strokeColor('#E2E8F0').lineWidth(0.8).stroke()

      // ==========================================
      // 8. LEGAL & VERIFICATION FOOTER
      // ==========================================
      const footerY = 745
      doc.moveTo(48, footerY).lineTo(548, footerY).strokeColor('#E2E8F0').lineWidth(0.8).stroke()

      doc.fontSize(7.5).fillColor('#94A3B8').font('Helvetica').text(
        'This is an official system-generated tax statement issued by PGX Gateway Inc. in association with PlayGroundX Network.',
        48,
        footerY + 12,
        { align: 'center', width: 500 }
      )
      doc.fontSize(7).fillColor('#CBD5E1').text(
        `Document Ref: ${invoice.invoiceNumber} • Generated on ${new Date().toISOString()} • Confidential & Verifiable`,
        48,
        footerY + 24,
        { align: 'center', width: 500 }
      )

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}
