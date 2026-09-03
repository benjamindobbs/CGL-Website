// Reusable "i" info popover. Any element with a data-info="..." attribute gets a
// small info button appended after it; clicking toggles a bubble with that text.
// One document listener closes any open bubble on outside-click or Escape.
(function () {
    function build(el) {
        if (el.dataset.infoTipReady) return;
        el.dataset.infoTipReady = '1';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'info-tip';
        btn.setAttribute('aria-label', 'More information');
        btn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">info</span>';

        const pop = document.createElement('span');
        pop.className = 'info-tip-pop';
        pop.setAttribute('role', 'tooltip');
        pop.textContent = el.dataset.info;

        btn.appendChild(pop);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = btn.classList.contains('open');
            closeAll();
            if (!open) btn.classList.add('open');
        });

        el.insertAdjacentElement('afterend', btn);
    }

    function closeAll() {
        document.querySelectorAll('.info-tip.open').forEach((b) => b.classList.remove('open'));
    }

    function init() {
        document.querySelectorAll('[data-info]').forEach(build);
    }

    document.addEventListener('click', closeAll);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
    document.addEventListener('DOMContentLoaded', init);

    // Expose for pages that add [data-info] elements after load.
    window.initInfoTips = init;
})();
