'use strict';

// Invoice presentation helpers extracted from server.js (Wave 2.B split).
// Pure formatting + outbound-notification builders for the pay-period invoice:
// the daily-entry SVG table image (MMS), the Resend HTML email, and the Twilio
// MMS send. Grouped here to keep server.js focused on bootstrap + mounting.

const debug = require('./debug');

function formatHoursEmailDisplay(decimalHours) {
  const h = Math.floor(decimalHours);
  const m = Math.round((decimalHours - h) * 60);
  return `${h}:${String(m).padStart(2, '0')} / ${decimalHours.toFixed(2)}`;
}

function formatHoursShort(decimalHours) {
  const h = Math.floor(decimalHours);
  const m = Math.round((decimalHours - h) * 60);
  return `${h}h${m > 0 ? String(m).padStart(2, '0') + 'm' : ''}`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Phone number for Lea (invoice review SMS recipient)
const LEA_PHONE = process.env.LEA_PHONE_NUMBER || '+13105033934';

function buildInvoiceImageSvg(employeeName, periodStart, periodEnd, summary, entries) {
  const W = 760;
  const MARGIN = 14;
  const TW = W - MARGIN * 2;

  const cols = [
    { label: 'Date', w: 0.118 },
    { label: 'Hours', w: 0.098 },
    { label: 'Wages', w: 0.108 },
    { label: 'Svc Comm', w: 0.112 },
    { label: 'Sales Comm', w: 0.112 },
    { label: 'Tips', w: 0.09 },
    { label: '-Cash Tips', w: 0.108 },
    { label: '-Payouts', w: 0.098 },
    { label: 'Day Total', w: 0.156 },
  ];

  const ROW_H = 28;
  const HEAD_H = 36;
  const TITLE_H = 44;
  const FOOT_H = 38;
  const rows = entries || [];
  const totalH = TITLE_H + HEAD_H + rows.length * ROW_H + FOOT_H + MARGIN;

  const xs = [];
  let cx = MARGIN;
  for (const c of cols) {
    xs.push(cx);
    cx += c.w * TW;
  }
  xs.push(cx);

  const ty = (rowY, h) => rowY + h * 0.67;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}">
<rect width="${W}" height="${totalH}" fill="white"/>
`;

  const titleTy = 28;
  const titleAttrs = 'font-size="13" fill="#222" font-weight="bold" text-anchor="middle"';
  const titleContent = `${escapeXml(employeeName)} — ${periodStart} to ${periodEnd}`;
  svg += `<text x="${W / 2}" y="${titleTy}" ${titleAttrs} font-family="sans-serif">${titleContent}</text>\n`;

  const hy = TITLE_H;
  const headAttrs = 'font-size="10" fill="#333" font-weight="bold"';
  svg += `<rect x="${MARGIN}" y="${hy}" width="${TW}" height="${HEAD_H}" fill="#e8e8e8"/>\n`;
  for (let i = 0; i < cols.length; i++) {
    const tx = i === 0 ? xs[i] + 4 : xs[i + 1] - 4;
    const anchor = i === 0 ? 'start' : 'end';
    svg += `<text x="${tx}" y="${ty(hy, HEAD_H)}" ${headAttrs} text-anchor="${anchor}"`;
    svg += ` font-family="sans-serif">${cols[i].label}</text>\n`;
  }

  let ry = TITLE_H + HEAD_H;
  for (let r = 0; r < rows.length; r++) {
    const e = rows[r];
    const dayTotal =
      e.wages + e.commissions + e.productCommissions + e.tips - e.cashTips - (e.payouts || 0);
    const bg = r % 2 === 0 ? '#ffffff' : '#f7f7f7';
    const vals = [
      e.date,
      formatHoursShort(e.hours),
      '$' + e.wages.toFixed(2),
      '$' + e.commissions.toFixed(2),
      '$' + e.productCommissions.toFixed(2),
      '$' + e.tips.toFixed(2),
      e.cashTips > 0 ? '-$' + e.cashTips.toFixed(2) : '-',
      (e.payouts || 0) > 0 ? '-$' + e.payouts.toFixed(2) : '-',
      '$' + dayTotal.toFixed(2),
    ];

    svg += `<rect x="${MARGIN}" y="${ry}" width="${TW}" height="${ROW_H}" fill="${bg}"/>\n`;
    for (let i = 0; i < cols.length; i++) {
      const tx = i === 0 ? xs[i] + 4 : xs[i + 1] - 4;
      const anchor = i === 0 ? 'start' : 'end';
      const red = (i === 6 || i === 7) && vals[i] !== '-';
      const bold = i === 8;
      const fill = red ? '#cc0000' : '#222';
      const weight = bold ? 'bold' : 'normal';
      const rowAttrs = `font-size="10" fill="${fill}" font-weight="${weight}"`;
      svg += `<text x="${tx}" y="${ty(ry, ROW_H)}" ${rowAttrs} text-anchor="${anchor}"`;
      svg += ` font-family="sans-serif">${escapeXml(vals[i])}</text>\n`;
    }
    svg += `<line x1="${MARGIN}" y1="${ry + ROW_H}" x2="${MARGIN + TW}" y2="${ry + ROW_H}"`;
    svg += ` stroke="#e0e0e0" stroke-width="0.5"/>\n`;
    ry += ROW_H;
  }

  svg += `<rect x="${MARGIN}" y="${ry}" width="${TW}" height="${FOOT_H}" fill="#d4edda"/>\n`;
  const footAttrs = 'fill="#155724" font-weight="bold" font-family="sans-serif"';
  svg += `<text x="${MARGIN + 4}" y="${ty(ry, FOOT_H)}" font-size="11" ${footAttrs}>TOTAL PAYABLE</text>\n`;
  const totalStr = summary.totalPayable.toFixed(2);
  svg += `<text x="${MARGIN + TW - 4}" y="${ty(ry, FOOT_H)}" font-size="12" ${footAttrs}`;
  svg += ` text-anchor="end">$${totalStr}</text>\n`;

  const borderH = HEAD_H + rows.length * ROW_H + FOOT_H;
  svg += `<rect x="${MARGIN}" y="${TITLE_H}" width="${TW}" height="${borderH}"`;
  svg += ` fill="none" stroke="#aaa" stroke-width="1"/>\n`;

  for (let i = 1; i < cols.length; i++) {
    const xi = xs[i].toFixed(1);
    svg += `<line x1="${xi}" y1="${TITLE_H}" x2="${xi}" y2="${ry + FOOT_H}"`;
    svg += ` stroke="#ddd" stroke-width="0.5"/>\n`;
  }

  svg += '</svg>';
  return svg;
}

async function sendInvoiceSms(employeeName, periodStart, periodEnd, totalPayable, entries, invoiceId) {
  const SID = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  if (!SID || !TOKEN) {
    debug.log('[InvoiceSMS] Twilio not configured — skipping SMS');
    return { sent: false, reason: 'Twilio not configured' };
  }

  const BASE_URL = 'https://paytrack.lemedspa.app';
  const mediaUrl = `${BASE_URL}/api/invoice-media/${invoiceId}`;
  const totalStr = totalPayable.toFixed(2);
  const body = `Invoice submitted: ${employeeName} (${periodStart}–${periodEnd})\n` +
    `Total payable: $${totalStr}`;

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
      },
      body: new URLSearchParams({ From: '+12134442242', To: LEA_PHONE, Body: body, MediaUrl0: mediaUrl }),
    });
    const result = await res.json();
    if (res.ok) {
      debug.log(`[InvoiceSMS] MMS sent to Lea, SID: ${result.sid}`);
      return { sent: true };
    }
    console.error('[InvoiceSMS] Twilio error:', result);
    return { sent: false, reason: result.message };
  } catch (err) {
    console.error('[InvoiceSMS] Error:', err.message);
    return { sent: false, reason: err.message };
  }
}

// Simple email sending function (using fetch to external email API)
async function sendInvoiceEmail(employee, periodStart, periodEnd, summary, entries) {
  // Check if Resend API key is configured
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!RESEND_API_KEY) {
    debug.log('[Email] No RESEND_API_KEY configured - email not sent');
    return { sent: false, reason: 'No API key configured' };
  }

  const tdStyle = 'border: 1px solid #ddd; padding: 8px;';
  const tdRight = 'border: 1px solid #ddd; padding: 8px; text-align: right;';

  // Build daily entries detail table
  let entriesTableRows = '';
  if (entries && entries.length > 0) {
    entries.forEach(entry => {
      const dayTotal = entry.wages + entry.commissions + entry.productCommissions +
        entry.tips - entry.cashTips - (entry.payouts || 0);
      const cashTipsStr = entry.cashTips > 0 ? '-$' + entry.cashTips.toFixed(2) : '-';
      const payoutsStr = (entry.payouts || 0) > 0 ? '-$' + entry.payouts.toFixed(2) : '-';
      entriesTableRows += `
        <tr>
          <td style="${tdStyle}">${entry.date}</td>
          <td style="${tdRight}">${formatHoursEmailDisplay(entry.hours)}</td>
          <td style="${tdRight}">$${entry.wages.toFixed(2)}</td>
          <td style="${tdRight}">$${entry.commissions.toFixed(2)}</td>
          <td style="${tdRight}">$${entry.productCommissions.toFixed(2)}</td>
          <td style="${tdRight}">$${entry.tips.toFixed(2)}</td>
          <td style="${tdRight}; color: #cc0000;">${cashTipsStr}</td>
          <td style="${tdRight}; color: #cc0000;">${payoutsStr}</td>
          <td style="${tdRight}; font-weight: 600;">$${dayTotal.toFixed(2)}</td>
        </tr>
      `;
    });
  }

  const tableStyle = 'border-collapse: collapse; width: 100%; margin-bottom: 20px; font-size: 12px;';
  const entriesTable = entries && entries.length > 0 ? `
    <h3 style="margin-top: 32px; margin-bottom: 8px; font-size: 14px; color: #333;">Daily Entry Detail</h3>
    <table style="${tableStyle}">
      <thead>
        <tr style="background: #f5f5f5;">
          <th style="${tdStyle} text-align: left;">Date</th>
          <th style="${tdRight} text-align: right;">Time/Hours Worked</th>
          <th style="${tdRight} text-align: right;">Wages</th>
          <th style="${tdRight} text-align: right;">Svc Comm</th>
          <th style="${tdRight} text-align: right;">Sales Comm</th>
          <th style="${tdRight} text-align: right;">Tips</th>
          <th style="${tdRight} text-align: right;">Cash Tips</th>
          <th style="${tdRight} text-align: right;">Payouts</th>
          <th style="${tdRight} text-align: right;">Day Total</th>
        </tr>
      </thead>
      <tbody>${entriesTableRows}</tbody>
    </table>
  ` : '';

  const cellStyle = 'border: 1px solid #ddd; padding: 10px;';
  const cellRightStyle = cellStyle + ' text-align: right;';
  const cellRedStyle = cellStyle + ' color: #cc0000;';
  const cellRedRightStyle = cellRightStyle + ' color: #cc0000;';
  const hoursLabel = formatHoursEmailDisplay(summary.totalHours);
  const hourlyWageStr = employee.hourlyWage;
  const timeWorkedLabel = `Time/Hours Worked (${hoursLabel} @ $${hourlyWageStr}/hr)`;
  const payoutsRow = summary.totalPayouts > 0 ? `
      <tr>
        <td style="${cellRedStyle}">Less: Payouts Already Made</td>
        <td style="${cellRedRightStyle}">-$${summary.totalPayouts.toFixed(2)}</td>
      </tr>` : '';

  const emailBody = `
    <h2>LeMed Spa - Pay Period Invoice</h2>
    <p><strong>Employee:</strong> ${employee.name}</p>
    <p><strong>Pay Period:</strong> ${periodStart} to ${periodEnd}</p>

    <table style="border-collapse: collapse; width: 100%; margin: 20px 0;">
      <tr style="background: #f5f5f5;">
        <th style="${cellStyle} text-align: left;">Description</th>
        <th style="${cellRightStyle}">Amount</th>
      </tr>
      <tr>
        <td style="${cellStyle}">${timeWorkedLabel}</td>
        <td style="${cellRightStyle}">$${summary.totalWages.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="${cellStyle}">Service Commissions</td>
        <td style="${cellRightStyle}">$${summary.totalCommissions.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="${cellStyle}">Sales Commissions</td>
        <td style="${cellRightStyle}">$${summary.totalProductCommissions.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="${cellStyle}">Tips</td>
        <td style="${cellRightStyle}">$${summary.totalTips.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="${cellRedStyle}">Less: Cash Tips Already Received</td>
        <td style="${cellRedRightStyle}">-$${summary.totalCashTips.toFixed(2)}</td>
      </tr>
      ${payoutsRow}
      <tr style="background: #e8f5e9;">
        <td style="${cellStyle}"><strong>TOTAL PAYABLE</strong></td>
        <td style="${cellRightStyle}"><strong>$${summary.totalPayable.toFixed(2)}</strong></td>
      </tr>
    </table>

    ${entriesTable}

    <p style="color: #666; font-size: 12px;">Submitted via LM PayTrack</p>
  `;

  const recipients = ['lea@lemedspa.com', 'ops@lemedspa.com'];
  const cc = employee.email ? [employee.email] : [];

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'LM PayTrack <paytrack@lemedspa.com>',
        to: recipients,
        cc: cc,
        subject: `Pay Period Invoice - ${employee.name} - ${periodStart} to ${periodEnd}`,
        html: emailBody,
      }),
    });

    const result = await response.json();

    if (response.ok) {
      debug.log('[Email] Invoice sent successfully:', result.id);
      return { sent: true, id: result.id };
    } else {
      console.error('[Email] Failed to send:', result);
      return { sent: false, reason: result.message || 'API error' };
    }
  } catch (error) {
    console.error('[Email] Error sending invoice:', error.message);
    return { sent: false, reason: error.message };
  }
}

module.exports = {
  formatHoursEmailDisplay,
  formatHoursShort,
  escapeXml,
  LEA_PHONE,
  buildInvoiceImageSvg,
  sendInvoiceSms,
  sendInvoiceEmail,
};
