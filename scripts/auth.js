// Shared sign-in helper for any page that needs a signed-in school account.
// Include after the Google Identity Services script:
//   <script src="https://accounts.google.com/gsi/client" async defer onload="gisLoaded()"></script>
//   <script src="/scripts/auth.js"></script>
// Pages implement window.onAuthReady(session) — session is null when signed out,
// or { userKey, email, isStaff } when signed in. It fires once restoration finishes.

const GOOGLE_CLIENT_ID = '245572615958-jg9jin9k68eh70pk659ifhjc8unbopta.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/userinfo.email';
const SESSION_KEY = 'cgl_session';

let tokenClient;
let gisInited = false;
let sessionToken = localStorage.getItem(SESSION_KEY) || null;
let currentSession = null;

function gisLoaded() {
    if (gisInited) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPES,
        callback: '',
    });
    gisInited = true;
}

// The GIS script tag's inline onload="gisLoaded()" can fire before this file has
// executed (it loads async), in which case that call throws "gisLoaded is not
// defined" and nothing ever initializes. Poll for the library ourselves so init
// happens regardless of script load order.
(function waitForGis() {
    if (gisInited) return;
    if (window.google && google.accounts && google.accounts.oauth2) {
        gisLoaded();
        return;
    }
    // Pages that only read session state (to show nav links, etc.) include this
    // file without the GIS script — nothing to wait for in that case.
    if (!document.querySelector('script[src*="accounts.google.com/gsi/client"]')) return;
    setTimeout(waitForGis, 100);
})();

function requestSignIn() {
    if (!gisInited) return;
    tokenClient.callback = async (resp) => {
        if (resp.error !== undefined) {
            console.error('Auth error:', resp);
            if (typeof window.onAuthError === 'function') window.onAuthError('Sign-in was cancelled or failed.');
            return;
        }
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: resp.access_token }),
            });
            if (!res.ok) {
                if (typeof window.onAuthError === 'function') {
                    window.onAuthError('Sign-in failed. Please use a hartfordschools.org or students.hartfordschools.org account.');
                }
                return;
            }
            const data = await res.json();
            sessionToken = data.sessionToken;
            localStorage.setItem(SESSION_KEY, sessionToken);
            await refreshSession();
        } catch (err) {
            console.error('Login error:', err);
            if (typeof window.onAuthError === 'function') window.onAuthError('Connection problem during sign-in.');
        }
    };
    tokenClient.requestAccessToken({ prompt: 'consent' });
}

function signOut() {
    sessionToken = null;
    currentSession = null;
    localStorage.removeItem(SESSION_KEY);
    if (typeof window.onAuthReady === 'function') window.onAuthReady(null);
}

function authFetch(path, options = {}) {
    return fetch(path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + sessionToken,
            ...(options.headers || {}),
        },
    });
}

async function refreshSession() {
    if (!sessionToken) {
        currentSession = null;
        if (typeof window.onAuthReady === 'function') window.onAuthReady(null);
        return;
    }
    try {
        const res = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + sessionToken } });
        if (!res.ok) {
            localStorage.removeItem(SESSION_KEY);
            sessionToken = null;
            currentSession = null;
            if (typeof window.onAuthReady === 'function') window.onAuthReady(null);
            return;
        }
        currentSession = await res.json();
        if (typeof window.onAuthReady === 'function') window.onAuthReady(currentSession);
    } catch (err) {
        console.error('Session check failed:', err);
        if (typeof window.onAuthReady === 'function') window.onAuthReady(null);
    }
}

document.addEventListener('DOMContentLoaded', refreshSession);
