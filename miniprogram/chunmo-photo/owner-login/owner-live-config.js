// Set only the approved, isolated test origin in a local WeChat test checkout.
/** @type {{origin: string, appId: string, deployment?: string, unified?: boolean, terms?: {version: string, text: string} | null}} */
const config = { origin: '', appId: '' };
module.exports = config;
