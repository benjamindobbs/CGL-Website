// Shared gate for staff-only pages. Include after scripts/auth.js and call
// requireStaffSession(session => { ...page init... }) instead of setting
// window.onAuthReady directly.
function requireStaffSession(onReady) {
    window.onAuthReady = function (session) {
        if (!session) {
            window.location.href = '/signin/?next=' + encodeURIComponent(window.location.pathname);
            return;
        }
        if (!session.isStaff) {
            document.getElementById('loading-status').innerText = 'Your account is not authorized for staff tools.';
            return;
        }
        document.getElementById('loading-status').style.display = 'none';
        document.getElementById('staff-ui').style.display = '';
        onReady(session);
    };
}
