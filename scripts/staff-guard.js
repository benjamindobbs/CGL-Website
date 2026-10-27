// Shared gate for staff-only pages. Include after scripts/auth.js and call
// requireStaffSession(session => { ...page init... }) instead of setting
// window.onAuthReady directly.
//
// Staff come in two roles (session.role): 'admin' (everything) and 'student'
// (student staff: schedule + read-only catalog/orders/requests). Pass
// { adminOnly: true } for pages student staff can't open at all. Elements with
// class "admin-only" (sidebar links, dashboard cards, edit controls) start
// `hidden` in markup and are revealed here for admins. The server enforces the
// same split on every API call; this only keeps the UI honest.
function isAdminSession(session) {
    return !!(session && session.role === 'admin');
}

function requireStaffSession(onReady, options) {
    var adminOnly = !!(options && options.adminOnly);
    window.onAuthReady = function (session) {
        if (!session) {
            window.location.href = '/signin/?next=' + encodeURIComponent(window.location.pathname);
            return;
        }
        if (!session.isStaff) {
            document.getElementById('loading-status').innerText = 'Your account is not authorized for staff tools.';
            return;
        }
        var admin = isAdminSession(session);
        var adminEls = document.querySelectorAll('.admin-only');
        for (var i = 0; i < adminEls.length; i++) adminEls[i].hidden = !admin;
        if (adminOnly && !admin) {
            document.getElementById('loading-status').innerText = 'This tool is only available to admin staff accounts.';
            return;
        }
        document.getElementById('loading-status').style.display = 'none';
        document.getElementById('staff-ui').style.display = '';
        onReady(session);
    };
}
