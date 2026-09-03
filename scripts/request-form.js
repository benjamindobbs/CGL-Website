// Job request form. Backed by POST /api/requests (multipart).
const CATEGORIES = [
    { name: 'Screen Printing', blurb: 'Best for larger runs of garments with a limited number of ink colors.' },
    { name: 'Embroidery', blurb: 'Ideal for polos, quarter-zips, hats, and bags — a stitched, premium finish.' },
    { name: 'DTF Transfer (Full Color)', blurb: 'Full-color, high-resolution heat transfers. Great for photo art, name plates, or numbers.' },
    { name: 'Banner', blurb: 'Full-color vinyl banner up to 54" wide and any length, indoor or outdoor. Grommets available.' },
    { name: 'Stickers, Decals & Signs', blurb: 'Custom-cut vinyl in any size — classroom window graphics, vehicle decals, yard signs, and more.' },
    { name: 'Not sure yet', blurb: 'Not sure what you need? Our student team will help you pick the best process for the job.' },
];

requireDistrictSession((session) => {
    const $ = (id) => document.getElementById(id);

    $('requester-email').value = session.email;

    const select = $('category');
    const descEl = $('category-desc');
    for (const c of CATEGORIES) {
        const opt = document.createElement('option');
        opt.value = c.name;
        opt.textContent = c.name;
        select.appendChild(opt);
    }
    select.addEventListener('change', () => {
        const c = CATEGORIES.find((x) => x.name === select.value);
        descEl.textContent = c ? c.blurb : '';
        descEl.style.display = c ? '' : 'none';
    });

    const statusEl = $('request-status');
    const btn = $('submit-request-btn');

    function fail(msg) {
        statusEl.style.display = '';
        statusEl.style.color = '#c0392b';
        statusEl.textContent = msg;
    }

    btn.addEventListener('click', async () => {
        statusEl.style.display = 'none';

        const requesterName = $('requester-name').value.trim();
        const jobName = $('job-name').value.trim();
        const category = select.value;
        if (!requesterName) return fail('Please enter your name.');
        if (!jobName) return fail('Please enter a job name.');
        if (!category) return fail('Please pick a print process.');

        const fd = new FormData();
        fd.append('requesterName', requesterName);
        fd.append('jobName', jobName);
        fd.append('category', category);
        fd.append('building', $('building').value.trim());
        fd.append('phone', $('phone').value.trim());
        fd.append('quantity', $('quantity').value.trim());
        fd.append('neededBy', $('needed-by').value);
        fd.append('description', $('description').value.trim());
        for (const file of $('files').files) fd.append('files', file);

        btn.disabled = true;
        btn.innerHTML = 'Sending…';
        try {
            const res = await authFetchForm('/api/requests', fd);
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                statusEl.style.display = '';
                statusEl.style.color = '#27ae60';
                statusEl.textContent = 'Request sent — check your email for a confirmation. You can submit another below.';
                ['requester-name', 'job-name', 'building', 'phone', 'quantity', 'needed-by', 'description'].forEach((id) => { $(id).value = ''; });
                $('files').value = '';
                select.value = '';
                descEl.style.display = 'none';
            } else {
                fail(data.error || 'Something went wrong. Please try again.');
            }
        } catch (err) {
            fail('Connection problem — please try again.');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<span class="material-symbols-outlined">send</span> Submit Request';
        }
    });
});
