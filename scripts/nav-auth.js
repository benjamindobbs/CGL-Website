// Reveals role-gated elements once the auth session resolves:
//   .staff-only     — shown for a whitelisted staff session (session.isStaff)
//   .district-only   — shown for a @hartfordschools.org staff session
// Both are `hidden` in markup by default. Works on any element (nav tabs,
// homepage cards, etc.), not just links.
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

    var prev = typeof window.onAuthReady === 'function' ? window.onAuthReady : null;
    window.onAuthReady = function (session) {
        applyRoleVisibility(session);
        if (prev) prev(session);
    };

    // If auth already resolved before this script ran, catch up from the cache.
    if (typeof currentSession !== 'undefined' && currentSession) applyRoleVisibility(currentSession);
})();
