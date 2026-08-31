// Uniforms catalog, keyed by product name -> color -> size ('' for unsized
// products) -> item row. Populated from GET /api/items once signed in.
let catalog = {};
let cart = [];

window.onAuthReady = function (session) {
    if (!session) {
        window.location.href = '/signin/?next=' + encodeURIComponent(window.location.pathname);
        return;
    }
    document.getElementById('email').value = session.email;
    loadCatalog();
};

async function loadCatalog() {
    try {
        const res = await fetch('/api/items?category=Uniforms');
        const items = await res.json();

        catalog = {};
        for (const item of items) {
            const size = item.variant_size || '';
            catalog[item.name] ??= {};
            catalog[item.name][item.variant_color] ??= {};
            catalog[item.name][item.variant_color][size] = item;
        }

        const productSelect = document.getElementById('product');
        for (const name of Object.keys(catalog)) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            productSelect.appendChild(opt);
        }

        document.getElementById('loading-status').style.display = 'none';
        document.getElementById('order-ui').style.display = '';
    } catch (err) {
        console.error('Failed to load catalog:', err);
        document.getElementById('loading-status').innerText = 'Could not load the catalog. Please refresh.';
    }
}

function currentProduct() {
    return catalog[document.getElementById('product').value] || null;
}

function updateColors() {
    const product = currentProduct();
    const container = document.getElementById('color-swatch-container');
    const hiddenInput = document.getElementById('selected-color');
    const sizeGroup = document.getElementById('size-group');
    const sizeSelect = document.getElementById('size');

    container.innerHTML = '';
    hiddenInput.value = '';
    sizeSelect.innerHTML = '<option value="" disabled selected>Select Size</option>';
    sizeGroup.style.display = 'none';

    const detailEl = document.getElementById('product-detail');
    const anyItem = product ? Object.values(Object.values(product)[0])[0] : null;
    if (anyItem) {
        detailEl.innerText = anyItem.detail;
        detailEl.style.display = '';
    } else {
        detailEl.style.display = 'none';
    }

    if (!product) return;

    Object.keys(product).forEach((color) => {
        const swatch = document.createElement('div');
        swatch.className = 'swatch-item';
        swatch.innerHTML = `
            <div class="color-circle" style="background-color: ${color === 'White' ? '#F5F5F5' : '#000000'}; border: 1px solid #ccc;"></div>
            <span>${color}</span>
        `;
        swatch.onclick = function () {
            document.querySelectorAll('.swatch-item').forEach((el) => el.classList.remove('active'));
            swatch.classList.add('active');
            hiddenInput.value = color;
            updateSizeOptions();
            updateLinePrice();
        };
        container.appendChild(swatch);
    });
}

function updateSizeOptions() {
    const product = currentProduct();
    const color = document.getElementById('selected-color').value;
    const sizeGroup = document.getElementById('size-group');
    const sizeSelect = document.getElementById('size');

    if (!product || !color) return;

    const sizes = Object.keys(product[color]).filter((s) => s !== '');
    if (sizes.length === 0) {
        sizeGroup.style.display = 'none';
        return;
    }

    sizeSelect.innerHTML = '<option value="" disabled selected>Select Size</option>';
    sizes.forEach((size) => {
        const opt = document.createElement('option');
        opt.value = size;
        opt.textContent = size;
        sizeSelect.appendChild(opt);
    });
    sizeGroup.style.display = '';
}

function selectedItem() {
    const product = currentProduct();
    const color = document.getElementById('selected-color').value;
    if (!product || !color) return null;

    const sizeGroup = document.getElementById('size-group');
    const size = sizeGroup.style.display === 'none' ? '' : document.getElementById('size').value;
    if (sizeGroup.style.display !== 'none' && !size) return null;

    return product[color][size] || null;
}

function updateLinePrice() {
    const item = selectedItem();
    const qty = parseInt(document.getElementById('quantity').value) || 1;
    const linePreviewDisplay = document.getElementById('line-item-total');
    const total = item ? item.price_cents * qty : 0;
    linePreviewDisplay.innerText = `$${(total / 100).toFixed(2)}`;
}

function changeQty(amount) {
    const qtyInput = document.getElementById('quantity');
    const newVal = parseInt(qtyInput.value) + amount;
    if (newVal >= 1 && newVal <= 99) qtyInput.value = newVal;
    updateLinePrice();
}

function addToCart() {
    const item = selectedItem();
    const qty = parseInt(document.getElementById('quantity').value);

    if (!item) {
        alert('Please complete all selections first.');
        return;
    }

    cart.push({
        uuid: item.uuid,
        name: item.name,
        color: item.variant_color,
        size: item.variant_size,
        qty,
        unitPriceCents: item.price_cents,
        lineTotalCents: item.price_cents * qty,
    });

    document.getElementById('quantity').value = 1;
    document.getElementById('line-item-total').innerText = '$0';
    renderCart();
}

function renderCart() {
    const cartDisplay = document.getElementById('cart-items-display');
    const grandTotalDisplay = document.getElementById('total-price');

    cartDisplay.innerHTML = '';
    let grandTotal = 0;

    cart.forEach((line, index) => {
        grandTotal += line.lineTotalCents;

        const itemDiv = document.createElement('div');
        itemDiv.className = 'cart-item-row';
        const sizeText = line.size ? ` / ${line.size}` : '';
        itemDiv.innerHTML = `
            <div class="cart-item-info">
                <span class="qty-badge">${line.qty}x</span>
                <div><strong>${line.name}</strong><br><small>${line.color}${sizeText}</small></div>
            </div>
            <div class="cart-item-price">
                <span>$${(line.lineTotalCents / 100).toFixed(2)}</span>
                <button type="button" class="remove-btn" onclick="removeItem(${index})">&times;</button>
            </div>
        `;
        cartDisplay.appendChild(itemDiv);
    });

    grandTotalDisplay.innerText = `$${(grandTotal / 100).toFixed(2)}`;
}

function removeItem(index) {
    cart.splice(index, 1);
    renderCart();
}

async function submitFinalOrder() {
    const form = document.getElementById('master-order-form');
    const submitBtn = document.getElementById('submit-order-btn');
    const statusEl = document.getElementById('order-status');
    statusEl.style.display = 'none';

    if (cart.length === 0) {
        alert('Your cart is empty. Please add at least one item.');
        return;
    }

    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }

    submitBtn.innerHTML = 'Processing...';
    submitBtn.disabled = true;

    try {
        const res = await authFetch('/api/orders', {
            method: 'POST',
            body: JSON.stringify({
                customerName: document.getElementById('name').value,
                email: document.getElementById('email').value,
                studentId: document.getElementById('student_id').value,
                cart: cart.map((l) => ({ uuid: l.uuid, qty: l.qty })),
            }),
        });

        if (res.ok) {
            cart = [];
            window.location.href = '/thanks/';
        } else {
            const result = await res.json();
            statusEl.innerText = 'Error: ' + (result.error || 'Submission failed');
            statusEl.style.display = '';
            submitBtn.innerHTML = 'Place Order';
            submitBtn.disabled = false;
        }
    } catch (err) {
        statusEl.innerText = 'Oops! There was a connection problem.';
        statusEl.style.display = '';
        submitBtn.innerHTML = 'Place Order';
        submitBtn.disabled = false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('product').addEventListener('change', updateColors);
    document.getElementById('size').addEventListener('change', updateLinePrice);
    document.querySelectorAll('.quantity-controls button').forEach((btn) => {
        btn.addEventListener('click', updateLinePrice);
    });
    document.getElementById('add-to-cart-btn').addEventListener('click', addToCart);
});
