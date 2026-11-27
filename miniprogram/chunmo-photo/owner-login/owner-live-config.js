// Set only the approved, isolated test origin in a local WeChat test checkout.
/** @typedef {{version: string, text: string}} Policy */
/** @type {{origin: string, appId: string, deployment?: string, unified?: boolean, terms?: Policy, privacy?: Policy}} */
const config = { origin: '', appId: '' };
module.exports = config;
