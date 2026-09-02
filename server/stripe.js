// Stripe client + config, read from the environment. The app boots fine with
// no keys set — isStripeConfigured() is false and the order route returns 503
// for any order that needs payment, so local/dev and pre-launch deploys work.
//
// Required secrets (fly secrets set … ; see fly.toml):
//   STRIPE_SECRET_KEY      sk_live_… / sk_test_…
//   STRIPE_WEBHOOK_SECRET  whsec_…  (from the dashboard endpoint or `stripe listen`)
//   PUBLIC_BASE_URL        e.g. https://cgl-website.fly.dev  (no trailing slash)
const Stripe = require('stripe');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

// No apiVersion pin: the SDK falls back to the account's default API version,
// which is correct for the long-stable Checkout / Refunds / Webhooks surfaces
// this app uses. Pin here only if a future change needs a specific version.
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

function isStripeConfigured() {
    return Boolean(stripe && STRIPE_WEBHOOK_SECRET && PUBLIC_BASE_URL);
}

if (!isStripeConfigured()) {
    console.warn(
        '[stripe] not fully configured — online card payment is disabled ' +
        '(need STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, PUBLIC_BASE_URL).'
    );
}

module.exports = { stripe, isStripeConfigured, STRIPE_WEBHOOK_SECRET, PUBLIC_BASE_URL };
