// Gate for the district-staff self-service tools (job request, jersey rosters).
// Include after scripts/auth.js and call
//   requireDistrictSession(session => { ...page init... })
// instead of setting window.onAuthReady directly. Requires #loading-status and
// #app-ui elements on the page.
function requireDistrictSession(onReady) {
    window.onAuthReady = function (session) {
        if (!session) {
            window.location.href = '/signin/?next=' + encodeURIComponent(window.location.pathname);
            return;
        }
        // Server sets session.isDistrict (hartfordschools.org staff or an
        // allow-listed collaborator). Fall back to the domain check for a
        // cached session from before that flag existed.
        var allowed = session.isDistrict === true ||
            String(session.email || '').toLowerCase().endsWith('@hartfordschools.org');
        if (!allowed) {
            document.getElementById('loading-status').innerText =
                'This tool is for school staff accounts. Student accounts can’t use it.';
            return;
        }
        document.getElementById('loading-status').style.display = 'none';
        document.getElementById('app-ui').style.display = '';
        onReady(session);
    };
}
