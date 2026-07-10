require('dotenv').config();

const config = {
  easyecom: {
    baseUrl: process.env.EASYECOM_BASE_URL || 'https://api.easyecom.io',
    email: process.env.EASYECOM_EMAIL,
    password: process.env.EASYECOM_PASSWORD,
    locationKey: process.env.EASYECOM_LOCATION_KEY,
    xApiKey: process.env.EASYECOM_X_API_KEY,
  },
  shopify: {
    storeUrl: process.env.SHOPIFY_STORE_URL,
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-01',
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecret: process.env.SHOPIFY_API_SECRET,
    redirectUri: process.env.SHOPIFY_REDIRECT_URI || 'http://localhost:3000/auth/callback',
  },
};

function validateConfig() {
  const required = ['email', 'password', 'locationKey', 'xApiKey'];
  const envNames = {
    email: 'EASYECOM_EMAIL',
    password: 'EASYECOM_PASSWORD',
    locationKey: 'EASYECOM_LOCATION_KEY',
    xApiKey: 'EASYECOM_X_API_KEY',
  };
  const missing = required.filter((key) => !config.easyecom[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.map((k) => envNames[k]).join(', ')}\n\nCopy .env.example to .env and fill in your credentials.`
    );
  }
}

function validateShopifyConfig() {
  const missing = [];
  if (!config.shopify.storeUrl || config.shopify.storeUrl.includes('your-store-name')) {
    missing.push('SHOPIFY_STORE_URL');
  }
  if (!config.shopify.accessToken || config.shopify.accessToken.includes('your_access_token')) {
    missing.push('SHOPIFY_ACCESS_TOKEN');
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing Shopify credentials: ${missing.join(', ')}\n\n` +
      `Get them from: Shopify Admin > Settings > Apps > Develop Apps > Create App > API credentials`
    );
  }
}

module.exports = { config, validateConfig, validateShopifyConfig };
