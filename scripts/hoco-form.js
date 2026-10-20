// Single-item checkout for HoCo tickets. Same flow as order-form.js — POST a
// cart to /api/orders, which re-prices it and returns a Stripe Checkout URL —
// but the cart is always one line: this ticket, at the chosen quantity.
// The per-person limit and sell-out are enforced server-side (server/tickets.js);
// the page just mirrors them so the picker never offers more than is allowed.
const TICKET_UUID = 'ticket-hoco-2026';

let ticket = null;
let maxTickets = 0;

window.onAuthReady = function (session) {
    if (!session) {
        window.location.href = '/signin/?next=' + encodeURIComponent(window.location.pathname);
        return;
    }
    document.getElementById('email').value = session.email;
    loadTicket();
};

function formatCents(cents) {
    return `$${(cents / 100).toFixed(2)}`;
}

async function loadTicket() {
    const statusEl = document.getElementById('loading-status');
    try {
        const [itemsRes, statusRes] = await Promise.all([
            fetch('/api/items'),
            authFetch(`/api/orders/tickets/${TICKET_UUID}`),
        ]);
        const items = await itemsRes.json();
        ticket = items.find((item) => item.uuid === TICKET_UUID) || null;

        if (!ticket || !statusRes.ok) {
            statusEl.innerText = 'HoCo tickets aren’t on sale right now.';
            return;
        }

        const status = await statusRes.json();
        if (status.available <= 0) {
            statusEl.innerText = 'HoCo tickets are sold out.';
            return;
        }
        if (status.canBuy <= 0) {
            statusEl.innerText = `You’ve got your ${status.limit} tickets — see you at HoCo!`;
            return;
        }

        maxTickets = status.canBuy;
        document.getElementById('ticket-name').innerText = ticket.name;
        document.getElementById('ticket-detail').innerText = ticket.detail || '';
        document.getElementById('unit-price').innerText = formatCents(ticket.price_cents);
        document.getElementById('ticket-limit').innerText = status.purchased > 0
            ? `Limit ${status.limit} per person — you can buy ${status.canBuy} more.`
            : `Limit ${status.limit} per person.`;
        updateTotal();

        statusEl.hidden = true;
        document.getElementById('hoco-ui').hidden = false;
    } catch (err) {
        console.error('Failed to load ticket:', err);
        statusEl.innerText = 'Could not load tickets. Please refresh.';
    }
}

function currentQty() {
    return parseInt(document.getElementById('quantity').value) || 1;
}

function updateTotal() {
    const total = ticket ? ticket.price_cents * currentQty() : 0;
    document.getElementById('total-price').innerText = formatCents(total);
}

function changeQty(amount) {
    const qtyInput = document.getElementById('quantity');
    const newVal = currentQty() + amount;
    if (newVal >= 1 && newVal <= maxTickets) qtyInput.value = newVal;
    updateTotal();
}

async function submitTicketOrder(event) {
    event.preventDefault();
    const submitBtn = document.getElementById('submit-order-btn');
    const statusEl = document.getElementById('order-status');
    const originalLabel = submitBtn.innerHTML;
    statusEl.hidden = true;

    if (!ticket) return;

    submitBtn.innerHTML = 'Processing...';
    submitBtn.disabled = true;

    const showError = (message) => {
        statusEl.innerText = message;
        statusEl.hidden = false;
        submitBtn.innerHTML = originalLabel;
        submitBtn.disabled = false;
    };

    try {
        const res = await authFetch('/api/orders', {
            method: 'POST',
            body: JSON.stringify({
                customerName: document.getElementById('name').value,
                email: document.getElementById('email').value,
                studentId: document.getElementById('student_id').value,
                cart: [{ uuid: TICKET_UUID, qty: currentQty() }],
                returnPath: '/hoco/',
            }),
        });
        const result = await res.json().catch(() => ({}));

        if (res.ok) {
            window.location.href = result.checkoutUrl || '/thanks/';
        } else {
            showError('Error: ' + (result.error || 'Submission failed'));
        }
    } catch (err) {
        showError('Oops! There was a connection problem.');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-qty]').forEach((btn) => {
        btn.addEventListener('click', () => changeQty(Number(btn.dataset.qty)));
    });
    document.getElementById('hoco-form').addEventListener('submit', submitTicketOrder);
});
