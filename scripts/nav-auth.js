// Reveals role-gated elements once the auth session resolves:
//   .staff-only     — shown for a whitelisted staff session (session.isStaff)
//   .district-only   — shown for a district session (session.isDistrict)
// Both are `hidden` in markup by default. Works on any element (nav tabs,
// homepage cards, etc.), not just links.
//
// Also drives the header #auth-btn: "Sign In" (links to /signin/) when signed
// out, "Sign Out" (calls signOut()) when signed in.
//
// Include on any page AFTER scripts/auth.js and after any page code that assigns
// window.onAuthReady (e.g. the inline requireStaffSession(...) call), so this
// wraps rather than clobbers the page's own handler.
(function () {
    function isDistrict(session) {
        if (session && typeof session.isDistrict === 'boolean') return session.isDistrict;
        return !!(session && session.email &&
            String(session.email).toLowerCase().endsWith('@hartfordschools.org'));
    }

    function applyRoleVisibility(session) {
        var staff = !!(session && session.isStaff);
        var district = staff || isDistrict(session);

        var staffEls = document.querySelectorAll('.staff-only');
        for (var i = 0; i < staffEls.length; i++) staffEls[i].hidden = !staff;

        var districtEls = document.querySelectorAll('.district-only');
        for (var j = 0; j < districtEls.length; j++) districtEls[j].hidden = !district;
    }

    function updateAuthButton(session) {
        var btn = document.getElementById('auth-btn');
        if (!btn) return;
        var icon = document.getElementById('auth-btn-icon');
        var label = document.getElementById('auth-btn-label');
        if (session) {
            if (icon) icon.textContent = 'logout';
            if (label) label.textContent = 'Sign Out';
            btn.removeAttribute('href');
            btn.setAttribute('role', 'button');
            btn.setAttribute('tabindex', '0');
        } else {
            if (icon) icon.textContent = 'login';
            if (label) label.textContent = 'Sign In';
            btn.setAttribute('href', '/signin/?next=' +
                encodeURIComponent(window.location.pathname + window.location.search));
            btn.removeAttribute('role');
            btn.removeAttribute('tabindex');
        }
    }

    var authBtn = document.getElementById('auth-btn');
    if (authBtn) {
        authBtn.addEventListener('click', function (e) {
            // Signed-in state has no href — treat the click as sign-out.
            if (authBtn.getAttribute('role') === 'button') {
                e.preventDefault();
                if (typeof signOut === 'function') signOut();
            }
        });
    }

    function onAuth(session) {
        applyRoleVisibility(session);
        updateAuthButton(session);
    }

    var prev = typeof window.onAuthReady === 'function' ? window.onAuthReady : null;
    window.onAuthReady = function (session) {
        onAuth(session);
        if (prev) prev(session);
    };

    // If auth already resolved before this script ran, catch up from the cache.
    if (typeof currentSession !== 'undefined' && currentSession) onAuth(currentSession);
})();
