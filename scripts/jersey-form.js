// Team jersey roster tool. GET/POST/PUT /api/jerseys.
const SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];

requireDistrictSession(() => {
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));

    let editingId = null;
    let players = [];

    // ---- Editor ------------------------------------------------------------
    function blankRow() {
        return { name: '', number: '', size: '', color: '', info: '' };
    }

    function renderRows() {
        const tbody = $('player-rows');
        tbody.innerHTML = players.map((p, i) => `
            <tr data-i="${i}">
                <td><input type="text" data-f="name" value="${esc(p.name)}"></td>
                <td><input type="text" data-f="number" value="${esc(p.number)}" class="col-number"></td>
                <td>
                    <select data-f="size">
                        <option value="">—</option>
                        ${SIZES.map((s) => `<option ${s === p.size ? 'selected' : ''}>${s}</option>`).join('')}
                    </select>
                </td>
                <td><input type="text" data-f="color" value="${esc(p.color)}"></td>
                <td><input type="text" data-f="info" value="${esc(p.info)}"></td>
                <td><button type="button" class="link-btn row-remove" data-i="${i}" aria-label="Remove row">&times;</button></td>
            </tr>
        `).join('');
    }

    $('player-rows').addEventListener('input', (e) => {
        const tr = e.target.closest('tr');
        if (!tr) return;
        const i = Number(tr.dataset.i);
        const f = e.target.dataset.f;
        if (players[i] && f) players[i][f] = e.target.value;
    });

    $('player-rows').addEventListener('click', (e) => {
        if (!e.target.classList.contains('row-remove')) return;
        players.splice(Number(e.target.dataset.i), 1);
        if (!players.length) players.push(blankRow());
        renderRows();
    });

    $('add-row-btn').addEventListener('click', () => { players.push(blankRow()); renderRows(); });

    $('paste-apply-btn').addEventListener('click', () => {
        const text = $('paste-box').value;
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
            const cols = (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) => c.trim());
            const [name = '', number = '', sizeRaw = '', color = '', info = ''] = cols;
            const size = SIZES.includes(sizeRaw.toUpperCase()) ? sizeRaw.toUpperCase() : '';
            players.push({ name, number, size, color, info });
        }
        // drop the leading empty row if it's still untouched
        if (players.length && lines.length && !players[0].name && !players[0].size && players.length > lines.length) {
            players.shift();
        }
        $('paste-box').value = '';
        renderRows();
    });

    function currentStyle() {
        const el = document.querySelector('input[name="jersey-style"]:checked');
        return el ? el.value : 'male';
    }

    function newRoster() {
        editingId = null;
        $('editor-title').textContent = 'New Roster';
        $('job-name').value = '';
        document.querySelector('input[name="jersey-style"][value="male"]').checked = true;
        players = [blankRow()];
        renderRows();
        $('roster-status').style.display = 'none';
        $('job-name').focus();
    }

    function loadRoster(job) {
        editingId = job.id;
        $('editor-title').textContent = `Editing: ${job.job_name}`;
        $('job-name').value = job.job_name;
        const styleEl = document.querySelector(`input[name="jersey-style"][value="${job.jersey_style}"]`);
        if (styleEl) styleEl.checked = true;
        players = job.players.length ? job.players.map((p) => ({ ...p })) : [blankRow()];
        renderRows();
        $('roster-status').style.display = 'none';
        $('editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    $('new-roster-btn').addEventListener('click', newRoster);

    // ---- Save ------------------------------------------------------------
    function fail(msg) {
        const el = $('roster-status');
        el.style.display = '';
        el.style.color = '#c0392b';
        el.textContent = msg;
    }

    $('save-roster-btn').addEventListener('click', async () => {
        $('roster-status').style.display = 'none';

        const jobName = $('job-name').value.trim();
        if (!jobName) return fail('Give the roster a job name.');

        const filled = players.filter((p) => p.name.trim() || p.size || p.number.trim() || p.color.trim() || p.info.trim());
        if (!filled.length) return fail('Add at least one player.');
        for (let i = 0; i < filled.length; i++) {
            if (!filled[i].name.trim()) return fail(`Row ${i + 1}: name on jersey is required.`);
            if (!SIZES.includes(filled[i].size)) return fail(`Row ${i + 1}: choose a size.`);
        }

        const payload = { jobName, jerseyStyle: currentStyle(), players: filled };
        const btn = $('save-roster-btn');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
            const res = editingId
                ? await authFetch(`/api/jerseys/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) })
                : await authFetch('/api/jerseys', { method: 'POST', body: JSON.stringify(payload) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) { fail(data.error || 'Could not save the roster.'); return; }

            editingId = data.id;
            $('editor-title').textContent = `Editing: ${jobName}`;
            players = filled.map((p) => ({ ...p }));
            renderRows();
            const el = $('roster-status');
            el.style.display = '';
            el.style.color = '#27ae60';
            el.textContent = 'Saved.';
            await loadMine();
        } catch (err) {
            fail('Connection problem — please try again.');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Roster';
        }
    });

    // ---- My rosters list ------------------------------------------------
    let myRosters = [];

    async function loadMine() {
        try {
            const res = await authFetch('/api/jerseys/mine');
            myRosters = res.ok ? await res.json() : [];
        } catch (err) {
            myRosters = [];
        }
        const wrap = $('roster-list');
        if (!myRosters.length) {
            wrap.innerHTML = '<p class="placeholder-text" style="margin:0;">No rosters yet. Fill in the form below and Save.</p>';
            return;
        }
        wrap.innerHTML = myRosters.map((j) => `
            <div class="roster-row" data-id="${j.id}">
                <button type="button" class="link-btn roster-open" data-id="${j.id}">${esc(j.job_name)}</button>
                <span class="field-note">${j.jersey_style === 'female' ? 'Female' : 'Male'} · ${j.players.length} player${j.players.length === 1 ? '' : 's'} · updated ${new Date(j.updated_at).toLocaleDateString()}</span>
            </div>
        `).join('');
    }

    $('roster-list').addEventListener('click', (e) => {
        if (!e.target.classList.contains('roster-open')) return;
        const job = myRosters.find((j) => String(j.id) === e.target.dataset.id);
        if (job) loadRoster(job);
    });

    newRoster();
    loadMine();
});
