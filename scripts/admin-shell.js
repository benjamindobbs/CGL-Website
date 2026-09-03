// Wires the shared admin sidebar shell (markup is inlined in each /admin/* page):
//  - highlights the nav link matching the current path, sets the topbar title
//  - fills the topbar with the signed-in email once auth resolves
//  - runs the mobile drawer (hamburger opens, scrim / Esc / close button dismiss)
//  - sign-out link
// Include LAST on admin pages, after scripts/auth.js and the page's own
// requireStaffSession(...) block.
(function () {
    var sidebar = document.getElementById('admin-sidebar');
    if (!sidebar) return;

    // ---- Active link + topbar title ------------------------------------
    var path = window.location.pathname.replace(/index\.html$/, '');
    if (path.charAt(path.length - 1) !== '/') path += '/';

    var links = sidebar.querySelectorAll('.admin-nav a');
    var best = null;
    var bestLen = -1;
    for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href');
        if (path === href || path.indexOf(href) === 0) {
            if (href.length > bestLen) { best = links[i]; bestLen = href.length; }
        }
    }
    if (best) {
        best.classList.add('is-active');
        best.setAttribute('aria-current', 'page');
        var titleEl = document.getElementById('admin-topbar-title');
        if (titleEl && !titleEl.textContent.trim()) {
            // textContent would include the icon ligature ("receipt_long Orders"),
            // so prefer data-title, else the trailing text node after the <span>.
            var label = best.getAttribute('data-title') ||
                (best.lastChild && best.lastChild.textContent.trim()) ||
                best.textContent.trim();
            titleEl.textContent = label;
        }
    }

    // ---- Signed-in email in the topbar -------------------------------
    function showUser(session) {
        var el = document.getElementById('admin-topbar-user');
        if (el && session && session.email) el.textContent = session.email;
    }
    var prev = typeof window.onAuthReady === 'function' ? window.onAuthReady : null;
    window.onAuthReady = function (session) {
        if (prev) prev(session);
        showUser(session);
    };
    if (typeof currentSession !== 'undefined' && currentSession) showUser(currentSession);

    // ---- Mobile drawer ---------------------------------------------------
    var scrim = document.getElementById('admin-scrim');
    function openNav() {
        sidebar.classList.add('open');
        if (scrim) scrim.hidden = false;
    }
    function closeNav() {
        sidebar.classList.remove('open');
        if (scrim) scrim.hidden = true;
    }
    var menuBtn = document.getElementById('admin-menu-btn');
    var closeBtn = document.getElementById('admin-sidebar-close');
    if (menuBtn) menuBtn.addEventListener('click', openNav);
    if (closeBtn) closeBtn.addEventListener('click', closeNav);
    if (scrim) scrim.addEventListener('click', closeNav);
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeNav();
    });

    // ---- Sign out ------------------------------------------------------
    var out = document.getElementById('admin-signout');
    if (out) {
        out.addEventListener('click', function () {
            if (typeof signOut === 'function') signOut();
            window.location.href = '/';
        });
    }
})();
