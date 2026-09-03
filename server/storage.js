// Artwork blob storage on Tigris (S3-compatible), signed with aws4fetch. Boots
// fine unconfigured — isStorageConfigured() is false and the request route
// refuses uploads with a 503 while still accepting text-only submissions.
//
// Provisioned by `fly storage create`, which injects:
//   AWS_ACCESS_KEY_ID  AWS_SECRET_ACCESS_KEY  AWS_ENDPOINT_URL_S3
//   AWS_REGION (usually "auto")  BUCKET_NAME
const { AwsClient } = require('aws4fetch');

const ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || '';
const SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || '';
const ENDPOINT = (process.env.AWS_ENDPOINT_URL_S3 || 'https://fly.storage.tigris.dev').replace(/\/+$/, '');
const REGION = process.env.AWS_REGION || 'auto';
const BUCKET = process.env.BUCKET_NAME || '';

function isStorageConfigured() {
    return Boolean(ACCESS_KEY_ID && SECRET_ACCESS_KEY && BUCKET);
}

if (!isStorageConfigured()) {
    console.warn('[storage] Tigris not configured — artwork uploads are disabled.');
}

const aws = isStorageConfigured()
    ? new AwsClient({ accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY, region: REGION, service: 's3' })
    : null;

const objectUrl = (key) => `${ENDPOINT}/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;

async function putObject(key, body, contentType) {
    const res = await aws.fetch(objectUrl(key), {
        method: 'PUT',
        body,
        headers: contentType ? { 'Content-Type': contentType } : {},
    });
    if (!res.ok) throw new Error(`storage PUT ${res.status}: ${await res.text().catch(() => '')}`);
}

// A time-limited GET URL a browser can open directly to download the object.
async function presignGetUrl(key, expiresSeconds = 3600) {
    const signed = await aws.sign(`${objectUrl(key)}?X-Amz-Expires=${expiresSeconds}`, {
        method: 'GET',
        aws: { signQuery: true },
    });
    return signed.url;
}

async function deleteObject(key) {
    const res = await aws.fetch(objectUrl(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`storage DELETE ${res.status}`);
}

module.exports = { isStorageConfigured, putObject, presignGetUrl, deleteObject };
