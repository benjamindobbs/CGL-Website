// Shows the staff-only navbar links (marked `.nav-tab.staff-only`, `hidden` by
// default) once an active staff session is present. Include on any page AFTER
// scripts/auth.js and after any page code that assigns window.onAuthReady
// (e.g. the inline requireStaffSession(...) call on admin pages), so this wraps
// rather than clobbers the page's own handler.
(function () {
    function renderNav(session) {
        var show = !!(session && session.isStaff);
        var links = document.querySelectorAll('.nav-tab.staff-only');
        for (var i = 0; i < links.length; i++) links[i].hidden = !show;
    }

    var prev = typeof window.onAuthReady === 'function' ? window.onAuthReady : null;
    window.onAuthReady = function (session) {
        renderNav(session);
        if (prev) prev(session);
    };

    // If auth already resolved before this script ran, catch up from the cache.
    if (typeof currentSession !== 'undefined' && currentSession) renderNav(currentSession);
})();
