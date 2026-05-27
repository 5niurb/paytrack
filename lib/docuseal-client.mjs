/**
 * Docuseal API client for e-signature workflows
 * Self-hosted Docuseal instance on NAS
 * Supports W9 and Service Contract templates
 */

const DOCUSEAL_API_BASE = process.env.DOCUSEAL_API_URL || 'http://culverdenas:8585';
const DOCUSEAL_TOKEN = process.env.DOCUSEAL_API_TOKEN;
const WEBHOOK_SECRET = process.env.DOCUSEAL_WEBHOOK_SECRET;

/**
 * Create a new submission for a template
 * @param {string} templateId - Docuseal template ID (from dashboard)
 * @param {Object} data - Template fields to prefill
 *   - worker_name: string
 *   - worker_email: string
 *   - [other template fields as needed]
 * @returns {Promise<{submissionId: string, publicLink: string}>}
 */
export async function createSubmission(templateId, data) {
  if (!DOCUSEAL_TOKEN) {
    throw new Error('DOCUSEAL_API_TOKEN is not configured');
  }

  if (!templateId) {
    throw new Error('templateId is required');
  }

  if (!data.worker_name || !data.worker_email) {
    throw new Error('worker_name and worker_email are required');
  }

  const payload = {
    template_id: templateId,
    send_email: false, // We handle email notifications ourselves
    send_sms: false,
    fields: [
      { name: 'worker_name', value: data.worker_name },
      { name: 'worker_email', value: data.worker_email },
      { name: 'timestamp', value: new Date().toISOString() },
      // Additional custom fields can be added here
      ...Object.entries(data)
        .filter(([k]) => k !== 'worker_name' && k !== 'worker_email')
        .map(([k, v]) => ({ name: k, value: v })),
    ],
  };

  try {
    const response = await fetch(`${DOCUSEAL_API_BASE}/api/submissions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DOCUSEAL_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Docuseal API error ${response.status}: ${text}`);
    }

    const submission = await response.json();

    return {
      submissionId: submission.id,
      publicLink: submission.public_link || `${DOCUSEAL_API_BASE}/submissions/${submission.id}`,
      externalId: submission.external_id,
    };
  } catch (err) {
    throw new Error(`Failed to create Docuseal submission: ${err.message}`);
  }
}

/**
 * Verify webhook signature from Docuseal
 * @param {string} signature - X-Docuseal-Signature header value
 * @param {string} payload - Raw request body
 * @returns {boolean} true if signature is valid
 */
export function verifyWebhookSignature(signature, payload) {
  if (!WEBHOOK_SECRET || !signature || !payload) {
    return false;
  }

  const crypto = await import('crypto');
  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  return signature === expectedSignature;
}

/**
 * Get submission details (for internal verification)
 * @param {string} submissionId
 * @returns {Promise<Object>}
 */
export async function getSubmission(submissionId) {
  if (!DOCUSEAL_TOKEN) {
    throw new Error('DOCUSEAL_API_TOKEN is not configured');
  }

  try {
    const response = await fetch(`${DOCUSEAL_API_BASE}/api/submissions/${submissionId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${DOCUSEAL_TOKEN}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Docuseal API error ${response.status}: ${text}`);
    }

    return await response.json();
  } catch (err) {
    throw new Error(`Failed to fetch Docuseal submission: ${err.message}`);
  }
}
