// Job request form. Backed by POST /api/requests (multipart).
const CATEGORIES = [
    { name: 'Screen Printing', blurb: 'Best for larger runs of garments with a limited number of ink colors.' },
    { name: 'Embroidery', blurb: 'Ideal for polos, quarter-zips, hats, and bags — a stitched, premium finish.' },
    { name: 'DTF Transfer (Full Color)', blurb: 'Full-color, high-resolution heat transfers. Great for photo art, name plates, or numbers.' },
    { name: 'Banner', blurb: 'Full-color vinyl banner up to 54" wide and any length, indoor or outdoor. Grommets available.' },
    { name: 'Stickers, Decals & Signs', blurb: 'Custom-cut vinyl in any size — classroom window graphics, vehicle decals, yard signs, and more.' },
    { name: 'Not sure yet', blurb: 'Not sure what you need? Our student team will help you pick the best process for the job.' },
];

// Apparel decoration and print/cut fields. Must match DECORATION_CATEGORIES,
// DESIGN_LOCATIONS, GARMENT_TYPES, APPAREL_SIZES, DECORATION_COLOR_LIMITS,
// SIZED_CATEGORIES, SURFACE_CATEGORIES, SURFACE_TYPES, JERSEY_OPTIONS,
// NAME_NUMBER_DTF_ONLY and NAME_NUMBER_METHOD_CHOICE in server/db.js.
const DECORATION_CATEGORIES = ['Screen Printing', 'Embroidery', 'DTF Transfer (Full Color)'];
const DTF_CATEGORY = 'DTF Transfer (Full Color)';
const DESIGN_LOCATIONS = ['Full Chest', 'Full Back', 'Front Pocket', 'Sleeve', 'Other'];
const GARMENT_TYPES = ['Tee-Shirt', 'Long Sleeve Tee', 'Crew Neck', 'Pull Over', 'Full Zip', 'Polo', 'Other'];
const APPAREL_SIZES = ['YS', 'YM', 'YL', 'YXL', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];
const COLOR_LIMITS = { 'Screen Printing': 4, 'Embroidery': 15 };
const SIZED_CATEGORIES = ['Banner', 'Stickers, Decals & Signs'];
const SURFACE_CATEGORIES = ['Stickers, Decals & Signs'];
const SURFACE_TYPES = ['Wall', 'Window', 'Floor', 'Vehicle', 'Sign', 'Other', 'Not sure yet'];
const JERSEY_OPTIONS = [['name_number', 'Name & Number'], ['name', 'Name Only'], ['number', 'Number Only']];
const NAME_NUMBER_DTF_ONLY = ['Full Chest', 'Full Back'];
const NAME_NUMBER_METHOD_CHOICE = ['Front Pocket', 'Sleeve'];

requireDistrictSession((session) => {
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));

    $('requester-email').value = session.email;

    const select = $('category');
    const descEl = $('category-desc');
    for (const c of CATEGORIES) {
        const opt = document.createElement('option');
        opt.value = c.name;
        opt.textContent = c.name;
        select.appendChild(opt);
    }

    // ---- Team roster: an imported jersey roster (GET /api/jerseys/mine) fills
    // the colors and sizes and unlocks "Use for Name/Number" on locations.
    let roster = null; // { id, job_name, jersey_style, players }
    const rosterAttached = () => !!roster && $('team-roster').checked;

    // ---- Design locations: a checkbox per location. Once ticked it shows a
    // colors pick (screen printing / embroidery) or an "Other" write-in. With a
    // roster attached, the four standard spots also offer Use for Name/Number:
    // that swaps the colors pick for Jersey Options, Full Chest/Back become DTF
    // transfers, and Front Pocket/Sleeve pick DTF or Embroidery.
    const locationRows = DESIGN_LOCATIONS.map((name, i) => {
        const row = document.createElement('div');
        row.className = 'decor-location';
        const label = document.createElement('label');
        label.className = 'checkbox-item';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = name;
        label.append(box, ` ${name}`);
        const other = document.createElement('input');
        other.type = 'text';
        other.placeholder = 'Please specify';
        other.hidden = true;
        const loc = { name, row, box, other, limit: -1, ack: false };
        row.append(label, other);

        if (name !== 'Other') {
            loc.nnLabel = document.createElement('label');
            loc.nnLabel.className = 'checkbox-item decor-nn';
            loc.nn = document.createElement('input');
            loc.nn.type = 'checkbox';
            loc.nnLabel.append(loc.nn, ' Use for Name/Number');
            loc.jersey = document.createElement('select');
            loc.jersey.setAttribute('aria-label', `Jersey options for ${name}`);
            loc.jersey.add(new Option('Jersey Options', ''));
            loc.jersey.options[0].disabled = true;
            for (const [value, text] of JERSEY_OPTIONS) loc.jersey.add(new Option(text, value));
            loc.jersey.value = '';
            row.append(loc.nnLabel, loc.jersey);
            loc.nn.addEventListener('change', () => {
                loc.ack = false;
                if (loc.nn.checked && NAME_NUMBER_DTF_ONLY.includes(name) && select.value !== DTF_CATEGORY) openDtfDialog(loc);
                syncLocations();
            });
        }
        if (NAME_NUMBER_METHOD_CHOICE.includes(name)) {
            loc.methodWrap = document.createElement('span');
            loc.methodWrap.className = 'decor-method';
            loc.methodWrap.innerHTML = ['dtf', 'embroidery'].map((m) =>
                `<label class="checkbox-item"><input type="radio" name="method-${i}" value="${m}"> ${m === 'dtf' ? 'DTF' : 'Embroidery'}</label>`).join('');
            loc.methodWrap.addEventListener('change', syncLocations);
            row.append(loc.methodWrap);
        }
        if (NAME_NUMBER_DTF_ONLY.includes(name)) {
            loc.dtfNote = document.createElement('small');
            loc.dtfNote.className = 'decor-dtf-note';
            loc.dtfNote.textContent = 'DTF transfer';
            row.append(loc.dtfNote);
        }

        loc.colors = document.createElement('select');
        loc.colors.hidden = true;
        row.append(loc.colors);
        $('location-list').appendChild(row);
        box.addEventListener('change', syncLocations);
        return loc;
    });

    const usesNameNumber = (loc) => !!(loc.nn && loc.nn.checked);
    const methodOf = (loc) => {
        const picked = loc.methodWrap && loc.methodWrap.querySelector('input:checked');
        return picked ? picked.value : '';
    };

    // Max colors for a ticked row: the job's process, or for a name/number row
    // 15 when embroidered and none for DTF.
    function rowLimit(loc) {
        if (usesNameNumber(loc)) return methodOf(loc) === 'embroidery' ? COLOR_LIMITS.Embroidery : 0;
        return COLOR_LIMITS[select.value] || 0;
    }

    // Rebuilds a row's colors pick when its limit changes, keeping a choice
    // that still fits (switching Embroidery -> Screen Printing drops 5+).
    function fillColors(loc, limit) {
        if (loc.limit === limit) return;
        loc.limit = limit;
        const keep = loc.colors.value;
        loc.colors.innerHTML = '<option value="">Number of colors</option>';
        for (let n = 1; n <= limit; n++) loc.colors.add(new Option(`${n} color${n === 1 ? '' : 's'}`, String(n)));
        loc.colors.add(new Option('Not sure', 'not_sure'));
        loc.colors.value = [...loc.colors.options].some((o) => o.value === keep) ? keep : '';
    }

    function syncLocations() {
        const limit = COLOR_LIMITS[select.value] || 0;
        $('location-note').textContent = (limit
            ? `Tick every spot that gets a design, then pick its number of colors (up to ${limit}).`
            : 'Tick every spot that gets a design. DTF is full color, so there’s no color count.') +
            (rosterAttached() ? ' Tick Use for Name/Number where players’ names or numbers go.' : '');
        for (const loc of locationRows) {
            const ticked = loc.box.checked;
            if (loc.nn) {
                loc.nnLabel.hidden = !(ticked && rosterAttached());
                if (loc.nnLabel.hidden) loc.nn.checked = false;
                loc.jersey.hidden = !usesNameNumber(loc);
            }
            if (loc.methodWrap) loc.methodWrap.hidden = !usesNameNumber(loc);
            if (loc.dtfNote) loc.dtfNote.hidden = !usesNameNumber(loc);
            const rl = ticked ? rowLimit(loc) : 0;
            fillColors(loc, rl);
            loc.colors.hidden = !rl;
            loc.other.hidden = !(ticked && loc.name === 'Other');
        }
    }

    // ---- "Names/Numbers are only available as DTF transfers" pop-up. Cancel
    // (or Esc) unticks Name/Number on that row.
    const dtfDialog = $('dtf-dialog');
    let dtfLoc = null;
    function openDtfDialog(loc) {
        dtfLoc = loc;
        $('dtf-dialog-location').textContent = loc.name;
        $('dtf-dialog-process').textContent = select.value.toLowerCase();
        $('dtf-ack').checked = false;
        $('dtf-ok').disabled = true;
        dtfDialog.showModal();
    }
    $('dtf-ack').addEventListener('change', () => { $('dtf-ok').disabled = !$('dtf-ack').checked; });
    dtfDialog.addEventListener('close', () => {
        if (!dtfLoc) return;
        if (dtfDialog.returnValue === 'ok' && $('dtf-ack').checked) {
            dtfLoc.ack = true;
        } else {
            dtfLoc.nn.checked = false;
            dtfLoc.ack = false;
        }
        dtfDialog.returnValue = '';
        dtfLoc = null;
        syncLocations();
    });

    // ---- Roster import
    let rosterChoices = [];
    async function showRosterPicker() {
        const picker = $('roster-picker');
        picker.hidden = false;
        picker.innerHTML = '<p class="field-note">Loading your rosters…</p>';
        const res = await authFetch('/api/jerseys/mine').catch(() => null);
        rosterChoices = res && res.ok ? await res.json() : [];
        picker.innerHTML = (rosterChoices.length
            ? rosterChoices.map((r) => `
                <button type="button" class="roster-option" data-id="${r.id}">
                    <strong>${esc(r.job_name)}</strong>
                    <small>${r.players.length} player${r.players.length === 1 ? '' : 's'} · ${esc(r.jersey_style)} jerseys · updated ${new Date(r.updated_at).toLocaleDateString()}</small>
                </button>`).join('')
            : '<p class="field-note">You don’t have any saved rosters yet.</p>') +
            '<p class="field-note"><a href="/jerseys/" target="_blank" rel="noopener">Build a new roster</a> (opens in a new tab), then <button type="button" class="link-btn" data-refresh>refresh this list</button>.</p>';
    }
    $('roster-picker').addEventListener('click', (e) => {
        if (e.target.closest('[data-refresh]')) { showRosterPicker(); return; }
        const option = e.target.closest('.roster-option');
        if (!option) return;
        attachRoster(rosterChoices.find((r) => String(r.id) === option.dataset.id));
        $('roster-picker').hidden = true;
    });

    // Fills Qty by Size from the roster: a color group per player color
    // (case-insensitive), counting players per size. Players with no color
    // share a group the requester has to name.
    function attachRoster(r) {
        if (!r) return;
        roster = r;
        const groups = [];
        for (const p of r.players) {
            const key = p.color.trim().toLowerCase();
            let g = groups.find((x) => x.key === key);
            if (!g) groups.push(g = { key, color: p.color.trim(), qty: '', sizes: [] });
            const s = g.sizes.find((x) => x.size === p.size);
            if (s) s.qty += 1;
            else g.sizes.push({ size: p.size, qty: 1 });
        }
        document.querySelector('input[name="qty-mode"][value="sizes"]').checked = true;
        colorQty.setGroups(groups);
        syncQuantity();
        const n = r.players.length;
        $('roster-summary').textContent =
            `Roster: ${r.job_name} (${n} player${n === 1 ? '' : 's'}, ${r.jersey_style} jerseys). ` +
            'Colors and sizes are filled in below, and you can still change them.' +
            (groups.some((g) => !g.color) ? ' Some players have no color, so enter one for that group.' : '');
        $('roster-import-btn').textContent = 'Change roster';
        $('roster-remove-btn').hidden = false;
        syncLocations();
    }

    // Quantities stay as they are; names/numbers come off every location.
    function detachRoster() {
        roster = null;
        $('roster-summary').textContent = 'Import a roster you built with the team jersey roster tool. It fills in the colors and sizes, and lets you put each player’s name or number on a design location.';
        $('roster-import-btn').textContent = 'Import roster';
        $('roster-remove-btn').hidden = true;
        $('roster-picker').hidden = true;
        syncLocations();
    }

    $('team-roster').addEventListener('change', () => {
        $('roster-box').hidden = !$('team-roster').checked;
        if (!$('team-roster').checked) detachRoster();
    });
    $('roster-import-btn').addEventListener('click', showRosterPicker);
    $('roster-remove-btn').addEventListener('click', detachRoster);
    syncLocations();

    // ---- Garment type
    for (const g of GARMENT_TYPES) $('garment-type').add(new Option(g, g));
    $('garment-type').addEventListener('change', () => {
        $('garment-other').hidden = $('garment-type').value !== 'Other';
    });

    // ---- Finished size + surface (banners, stickers, decals & signs)
    for (const s of SURFACE_TYPES) $('surface-type').add(new Option(s, s));
    $('surface-type').addEventListener('change', () => {
        $('surface-other').hidden = $('surface-type').value !== 'Other';
    });

    // ---- Quantity: free text for other categories; for decoration, one group
    // per garment color with a Total or a Qty by Size table.
    const colorQty = createColorQtyEditor($('color-qty'), { sizes: APPAREL_SIZES });

    function qtyMode() {
        return document.querySelector('input[name="qty-mode"]:checked').value;
    }

    function syncQuantity() {
        const decoration = DECORATION_CATEGORIES.includes(select.value);
        $('qty-mode').hidden = !decoration;
        $('quantity').hidden = decoration;
        $('color-qty').hidden = !decoration;
        $('quantity-label').textContent = decoration ? 'Garment Colors & Quantity' : 'Quantity';
        $('quantity-label').htmlFor = decoration ? '' : 'quantity';
        colorQty.setMode(qtyMode());
    }
    document.querySelectorAll('input[name="qty-mode"]').forEach((r) => r.addEventListener('change', syncQuantity));

    select.addEventListener('change', () => {
        const c = CATEGORIES.find((x) => x.name === select.value);
        descEl.textContent = c ? c.blurb : '';
        descEl.style.display = c ? '' : 'none';
        $('apparel-fields').hidden = !DECORATION_CATEGORIES.includes(select.value);
        $('printcut-fields').hidden = !SIZED_CATEGORIES.includes(select.value);
        $('surface-group').hidden = !SURFACE_CATEGORIES.includes(select.value);
        syncLocations();
        syncQuantity();
    });

    const statusEl = $('request-status');
    const btn = $('submit-request-btn');

    function fail(msg) {
        statusEl.style.display = '';
        statusEl.style.color = '#c0392b';
        statusEl.textContent = msg;
    }

    // Reads and checks the decoration fields. Returns an error message, or
    // appends the fields to fd and returns null. The server repeats every check.
    function addDecoration(fd) {
        const locations = [];
        for (const loc of locationRows) {
            if (!loc.box.checked) continue;
            const other = loc.other.value.trim();
            if (loc.name === 'Other' && !other) return 'Please specify the "Other" design location.';
            const nameNumber = usesNameNumber(loc) ? loc.jersey.value : '';
            const method = usesNameNumber(loc) ? methodOf(loc) : '';
            if (usesNameNumber(loc)) {
                if (!nameNumber) return `Pick the jersey option for the ${loc.name}.`;
                if (loc.methodWrap && !method) return `Pick DTF or Embroidery for the names/numbers on the ${loc.name}.`;
                // The process may have changed since the box was ticked.
                if (loc.dtfNote && select.value !== DTF_CATEGORY && !loc.ack) {
                    openDtfDialog(loc);
                    return `Please acknowledge that names/numbers on the ${loc.name} are DTF transfers.`;
                }
            }
            const limit = rowLimit(loc);
            if (limit && !loc.colors.value) return `Pick the number of colors for ${other || loc.name}.`;
            locations.push({
                location: loc.name, other, colors: limit ? loc.colors.value : '',
                nameNumber, method, dtfAck: !!(loc.dtfNote && nameNumber && loc.ack),
            });
        }
        if (!locations.length) return 'Pick at least one design location.';
        if (rosterAttached()) fd.append('rosterId', String(roster.id));

        const garmentType = $('garment-type').value;
        const garmentOther = $('garment-other').value.trim();
        if (!garmentType) return 'Please pick a garment type.';
        if (garmentType === 'Other' && !garmentOther) return 'Please specify the "Other" garment type.';

        const mode = qtyMode();
        const groups = colorQty.getGroups();
        const seen = [];
        for (const g of groups) {
            if (!g.color) return 'Please enter a garment color for each color.';
            if (seen.includes(g.color.toLowerCase())) return `${g.color} is listed twice. Combine them into one color.`;
            seen.push(g.color.toLowerCase());
            if (mode === 'total') {
                if (!/^\d+$/.test(g.qty) || Number(g.qty) < 1) return `The quantity for ${g.color} must be a whole number of at least 1.`;
            } else {
                g.sizes = g.sizes.filter((s) => Number(s.qty) !== 0);
                const bad = g.sizes.find((s) => !/^\d+$/.test(s.qty));
                if (bad) return `The quantity for ${g.color} size ${bad.size} must be a whole number.`;
                if (!g.sizes.length) return `Enter a quantity for at least one size of ${g.color}.`;
            }
        }

        fd.append('locations', JSON.stringify(locations));
        fd.append('garmentType', garmentType);
        fd.append('garmentOther', garmentOther);
        fd.append('blankRef', $('blank-ref').value.trim());
        fd.append('qtyMode', mode);
        fd.append('colors', JSON.stringify(groups));
        return null;
    }

    // Finished size (and surface, for stickers/decals/signs). Returns an error
    // message, or appends the fields to fd and returns null.
    function addPrintCut(fd, category) {
        const itemSize = $('item-size').value.trim();
        if (!itemSize) return 'Please enter the finished size.';
        fd.append('itemSize', itemSize);
        if (!SURFACE_CATEGORIES.includes(category)) return null;
        const surfaceType = $('surface-type').value;
        const surfaceOther = $('surface-other').value.trim();
        if (!surfaceType) return 'Please pick a surface type.';
        if (surfaceType === 'Other' && !surfaceOther) return 'Please specify the "Other" surface.';
        fd.append('surfaceType', surfaceType);
        fd.append('surfaceOther', surfaceOther);
        return null;
    }

    function resetForm() {
        ['requester-name', 'job-name', 'building', 'phone', 'quantity', 'needed-by', 'description',
            'garment-other', 'blank-ref', 'item-size', 'surface-other'].forEach((id) => { $(id).value = ''; });
        $('files').value = '';
        select.value = '';
        $('garment-type').value = '';
        $('garment-other').hidden = true;
        $('surface-type').value = '';
        $('surface-other').hidden = true;
        for (const loc of locationRows) {
            loc.box.checked = false;
            loc.other.value = '';
            loc.colors.value = '';
            loc.ack = false;
            if (loc.nn) { loc.nn.checked = false; loc.jersey.value = ''; }
            if (loc.methodWrap) loc.methodWrap.querySelectorAll('input').forEach((r) => { r.checked = false; });
        }
        $('team-roster').checked = false;
        $('roster-box').hidden = true;
        detachRoster();
        colorQty.setGroups([]);
        document.querySelector('input[name="qty-mode"][value="total"]').checked = true;
        descEl.style.display = 'none';
        $('apparel-fields').hidden = true;
        $('printcut-fields').hidden = true;
        syncLocations();
        syncQuantity();
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
        if (DECORATION_CATEGORIES.includes(category)) {
            const problem = addDecoration(fd);
            if (problem) return fail(problem);
        } else {
            fd.append('quantity', $('quantity').value.trim());
        }
        if (SIZED_CATEGORIES.includes(category)) {
            const problem = addPrintCut(fd, category);
            if (problem) return fail(problem);
        }
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
                resetForm();
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
