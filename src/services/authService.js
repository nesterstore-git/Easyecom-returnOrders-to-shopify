const axios = require('axios');
const { config } = require('../config/config');
const logger = require('../utils/logger');

/**
 * Generates an access token from the EasyEcom API v2.1
 * Endpoint: POST https://api.easyecom.io/access/token
 *
 * @returns {Promise<{token: string, tokenType: string, expiresIn: number, companyData: object}>}
 */
async function generateToken() {
  const url = `${config.easyecom.baseUrl}/access/token`;

  const requestBody = {
    email: config.easyecom.email,
    password: config.easyecom.password,
    location_key: config.easyecom.locationKey,
  };

  logger.info('Requesting EasyEcom access token...', { url, email: requestBody.email });

  // x-api-key is mandatory even for the token generation endpoint (per EasyEcom docs)
  const response = await axios.post(url, requestBody, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.easyecom.xApiKey,
    },
  });

  const { data, message } = response.data;

  if (!data) {
    throw new Error(`Token generation failed: ${message || 'Unknown error'}`);
  }

  // Extract the JWT token from the nested token object inside data
  const tokenInfo = data.token || data;
  const token = tokenInfo.jwt_token || tokenInfo.access_token || tokenInfo.token;

  if (!token) {
    throw new Error('No token found in API response. Check the response structure.');
  }

  logger.success('Access token generated successfully!', {
    companyname: data.companyname,
    time_zone: data.time_zone,
    token_type: tokenInfo.token_type,
    expires_in: tokenInfo.expires_in,
  });

  return {
    token,
    tokenType: tokenInfo.token_type || 'bearer',
    expiresIn: tokenInfo.expires_in,
    companyData: {
      companyname: data.companyname,
      all_location: data.all_location,
      time_zone: data.time_zone,
    },
  };
}

module.exports = { generateToken };
