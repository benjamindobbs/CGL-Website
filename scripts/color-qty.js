// "Colors & quantity" editor, shared by the job request form
// (scripts/request-form.js) and the job packet builder (admin/packets/).
// One group per garment color ("+ Add Another Color"). Each group has a total,
// or in Qty by Size mode a size table whose Adult / Youth pick decides which
// size boxes show. Styles: .color-group* in main.css.
//
//   const editor = createColorQtyEditor(containerEl, { sizes, onChange });
//   editor.setMode('total' | 'sizes');
//   editor.getGroups()  -> [{ color, qty, sizes: [{ size, qty }] }], values as typed
//                          (qty in 'total' mode, sizes in 'sizes' mode; only the
//                          sizes showing for the group's range, blanks left out)
//   editor.setGroups(groups)  (same shape; [] or omitted -> one empty group)
function createColorQtyEditor(container, opts) {
    var sizes = opts.sizes;
    var onChange = opts.onChange || function () {};
    var RANGES = [['adult', 'Adult sizes'], ['youth', 'Youth sizes'], ['both', 'Youth & Adult']];
    var isYouth = function (size) { return size.charAt(0) === 'Y'; };
    var mode = 'total';
    var groups = [];

    var list = document.createElement('div');
    list.className = 'color-groups';
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'link-btn';
    addBtn.textContent = '+ Add Another Color';
    var totalNote = document.createElement('small');
    totalNote.className = 'field-note';
    container.append(list, addBtn, totalNote);

    addBtn.addEventListener('click', function () {
        addGroup();
        refresh();
        onChange();
    });
    container.addEventListener('input', refresh);

    // The range that shows every size a group already has a quantity for.
    function rangeFor(groupSizes) {
        var youth = groupSizes.some(function (s) { return isYouth(s.size); });
        var adult = groupSizes.some(function (s) { return !isYouth(s.size); });
        return youth && adult ? 'both' : youth ? 'youth' : 'adult';
    }

    function addGroup(data) {
        data = data || { color: '', qty: '', sizes: [] };
        var el = document.createElement('div');
        el.className = 'color-group';

        var head = document.createElement('div');
        head.className = 'color-group-head';
        var color = document.createElement('input');
        color.type = 'text';
        color.className = 'cg-color';
        color.placeholder = 'Color, e.g. Navy';
        color.setAttribute('aria-label', 'Garment color');
        color.value = data.color || '';
        var range = document.createElement('select');
        range.className = 'cg-range';
        range.setAttribute('aria-label', 'Size range');
        RANGES.forEach(function (r) { range.add(new Option(r[1], r[0])); });
        range.value = rangeFor(data.sizes || []);
        var total = document.createElement('input');
        total.type = 'number';
        total.min = '1';
        total.step = '1';
        total.className = 'cg-total';
        total.placeholder = 'Quantity';
        total.setAttribute('aria-label', 'Quantity');
        total.value = data.qty == null ? '' : data.qty;
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove-btn';
        remove.setAttribute('aria-label', 'Remove this color');
        remove.innerHTML = '&times;';
        head.append(color, range, total, remove);

        var grid = document.createElement('div');
        grid.className = 'size-grid';
        var cells = sizes.map(function (size) {
            var cell = document.createElement('label');
            cell.className = 'size-cell';
            var input = document.createElement('input');
            input.type = 'number';
            input.min = '0';
            input.step = '1';
            input.inputMode = 'numeric';
            var found = (data.sizes || []).filter(function (s) { return s.size === size; })[0];
            input.value = found ? found.qty : '';
            cell.append(size, input);
            grid.appendChild(cell);
            return { size: size, cell: cell, input: input };
        });

        el.append(head, grid);
        list.appendChild(el);
        var group = { el: el, color: color, range: range, total: total, remove: remove, grid: grid, cells: cells };
        groups.push(group);

        range.addEventListener('change', function () { syncGroup(group); });
        remove.addEventListener('click', function () {
            groups.splice(groups.indexOf(group), 1);
            el.remove();
            refresh();
            onChange();
        });
        syncGroup(group);
        return group;
    }

    function showsSize(group, size) {
        var r = group.range.value;
        return r === 'both' || (r === 'youth') === isYouth(size);
    }

    function syncGroup(group) {
        var bySize = mode === 'sizes';
        group.range.hidden = !bySize;
        group.total.hidden = bySize;
        group.grid.hidden = !bySize;
        group.cells.forEach(function (c) { c.cell.hidden = !showsSize(group, c.size); });
    }

    function refresh() {
        groups.forEach(function (g) { g.remove.hidden = groups.length < 2; });
        var sum = 0;
        getGroups().forEach(function (g) {
            if (mode === 'total') sum += Number(g.qty) || 0;
            else g.sizes.forEach(function (s) { sum += Number(s.qty) || 0; });
        });
        totalNote.textContent = groups.length > 1 || mode === 'sizes' ? 'Total: ' + sum : '';
    }

    function getGroups() {
        return groups.map(function (g) {
            return {
                color: g.color.value.trim(),
                qty: mode === 'total' ? g.total.value.trim() : '',
                sizes: mode === 'sizes'
                    ? g.cells.filter(function (c) { return showsSize(g, c.size) && c.input.value.trim() !== ''; })
                        .map(function (c) { return { size: c.size, qty: c.input.value.trim() }; })
                    : [],
            };
        });
    }

    function setGroups(data) {
        groups.slice().forEach(function (g) { g.el.remove(); });
        groups = [];
        (data && data.length ? data : [null]).forEach(function (d) { addGroup(d); });
        refresh();
    }

    function setMode(next) {
        mode = next;
        groups.forEach(syncGroup);
        refresh();
    }

    setGroups([]);
    return { setMode: setMode, getGroups: getGroups, setGroups: setGroups };
}
