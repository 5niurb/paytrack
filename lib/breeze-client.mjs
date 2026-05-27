/**
 * BreEZe API client for professional license verification
 * Queries California state license databases for clinical staff
 * Supports: MD, DO, RN, LVN, Acupuncturist, Aesthetician, etc.
 */

const BREEZE_API_BASE = 'https://api.breeze.ca.gov/v1';
const BREEZE_TOKEN = process.env.BREEZE_API_TOKEN;

/**
 * Query license by name and/or license number
 * @param {string} profession - License type (md, do, rn, lvn, acupuncturist, aesthetician, etc.)
 * @param {string} licenseNumber - License number (optional if name provided)
 * @param {string} firstName - First name (optional)
 * @param {string} lastName - Last name (optional)
 * @returns {Promise<{status: string, licenseNumber: string, expiryDate: string, profession: string, verified_at: string}>}
 */
export async function queryLicense(profession, { licenseNumber, firstName, lastName }) {
  if (!BREEZE_TOKEN) {
    throw new Error('BREEZE_API_TOKEN is not configured');
  }

  if (!profession) {
    throw new Error('profession is required');
  }

  if (!licenseNumber && !firstName && !lastName) {
    throw new Error('Either licenseNumber or (firstName + lastName) must be provided');
  }

  const params = new URLSearchParams();
  params.append('profession', profession.toLowerCase());

  if (licenseNumber) {
    params.append('license_number', licenseNumber.trim());
  }
  if (firstName) {
    params.append('first_name', firstName.trim());
  }
  if (lastName) {
    params.append('last_name', lastName.trim());
  }

  const url = `${BREEZE_API_BASE}/verify?${params.toString()}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${BREEZE_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 404) {
      // License not found
      return {
        status: 'not_found',
        licenseNumber: licenseNumber || null,
        expiryDate: null,
        profession,
        verified_at: new Date().toISOString(),
      };
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`BreEZe API error ${response.status}: ${text}`);
    }

    const data = await response.json();

    // Normalize BreEZe response to our format
    return {
      status: data.status === 'active' || data.status === 'valid' ? 'valid' : data.status === 'expired' ? 'expired' : 'invalid',
      licenseNumber: data.license_number || licenseNumber,
      expiryDate: data.expiry_date || data.expiration_date || null,
      profession,
      verified_at: new Date().toISOString(),
      raw: data, // Include raw response for debugging
    };
  } catch (err) {
    throw new Error(`BreEZe query failed for ${profession} ${licenseNumber || `${firstName} ${lastName}`}: ${err.message}`);
  }
}

/**
 * Check if a license is expiring within N days
 * @param {string} expiryDate - ISO or YYYY-MM-DD format
 * @param {number} warningDays - Number of days before expiry to warn (default 30)
 * @returns {boolean} true if expiry is within warningDays
 */
export function isExpiringWithin(expiryDate, warningDays = 30) {
  if (!expiryDate) return false;

  const expiry = new Date(expiryDate);
  if (isNaN(expiry.getTime())) return false;

  const today = new Date();
  const daysUntilExpiry = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));

  return daysUntilExpiry <= warningDays && daysUntilExpiry > 0;
}

/**
 * Check if a license is already expired
 * @param {string} expiryDate - ISO or YYYY-MM-DD format
 * @returns {boolean} true if past expiry date
 */
export function isExpired(expiryDate) {
  if (!expiryDate) return false;

  const expiry = new Date(expiryDate);
  if (isNaN(expiry.getTime())) return false;

  return new Date() > expiry;
}
