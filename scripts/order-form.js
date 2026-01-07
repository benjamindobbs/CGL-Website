/**
 * Dynamic Color Selection Logic
 */


const colorData = {
    "Unisex": {
        "Asphalt": "#4E5452",
        "Lavender": "#E6E6FA",
        "Blush": "#FEC5E5",
        "Bone": "#E3DAC9",
        "Artic": "#89ccd4ff"
    },
    "Womens": {
        "Black": "#000000",
        "Lavender": "#E6E6FA",
        "Blush": "#FEC5E5",
        "Bone": "#E3DAC9",
        "Artic": "#89ccd4ff"
    }
};

function updateColors() {
    const style = document.getElementById('style').value;
    const container = document.getElementById('color-swatch-container');
    const hiddenInput = document.getElementById('selected-color');
    
    container.innerHTML = ""; // Clear placeholder
    hiddenInput.value = "";   // Reset selection

    if (colorData[style]) {
        Object.entries(colorData[style]).forEach(([name, hex]) => {
            // Create the swatch button
            const swatch = document.createElement('div');
            swatch.className = 'swatch-item';
            swatch.innerHTML = `
                <div class="color-circle" style="background-color: ${hex}"></div>
                <span>${name}</span>
            `;
            
            swatch.onclick = function() {
                // Remove 'active' class from others
                document.querySelectorAll('.swatch-item').forEach(el => el.classList.remove('active'));
                // Add to this one
                swatch.classList.add('active');
                // Set the hidden input value for Formspree
                hiddenInput.value = name;
            };
            
            container.appendChild(swatch);
        });
    }
}


function updateLinePrice() {
    const finish = document.getElementById('finish').value;
    const qty = parseInt(document.getElementById('quantity').value) || 1;
    const linePreviewDisplay = document.getElementById('line-item-total');

    let unitPrice = 0;
    if (finish === "Raised Print") unitPrice = 40;
    if (finish === "Embossed Embroidery") unitPrice = 60;

    const previewTotal = unitPrice * qty;
    
    // Update ONLY the line-item-total span, NOT the total-price span
    if (previewTotal > 0) {
        linePreviewDisplay.innerText = `$${previewTotal}`;
    } else {
        linePreviewDisplay.innerText = "$0";
    }
}

//Redirect to thanks
const form = document.querySelector(".master-order-form");

// form.addEventListener("submit", async function(event) {
//     event.preventDefault(); // Stop the page from redirecting to Formspree
    
//     const status = document.querySelector(".submit-btn");
//     const data = new FormData(event.target);
    
//     status.innerHTML = "Sending...";
//     status.disabled = true;

//     fetch(event.target.action, {
//         method: form.method,
//         body: data,
//         headers: {
//             'Accept': 'application/json'
//         }
//     }).then(response => {
//         if (response.ok) {
//             // SUCCESS: Manually go to your thank you page
//             window.location.href = "../pages/thanks.html"; 
//         } else {
//             response.json().then(data => {
//                 alert("Error: " + data.errors.map(error => error.message).join(", "));
//                 status.innerHTML = "Place Order";
//                 status.disabled = false;
//             });
//         }
//     }).catch(error => {
//         alert("Oops! There was a problem submitting your form");
//         status.innerHTML = "Place Order";
//         status.disabled = false;
//     });
// });

let cart = [];

// 1. Wait for the DOM to be fully loaded
document.addEventListener('DOMContentLoaded', () => {
    const finishSelect = document.getElementById('finish');
    const qtyInput = document.getElementById('quantity');
    const qtyBtns = document.querySelectorAll('.quantity-controls button');

    // Update price when dropdown changes
    finishSelect.addEventListener('change', updateLinePrice);

    // Update price when +/- buttons are clicked
    qtyBtns.forEach(btn => {
        btn.addEventListener('click', updateLinePrice);
    });
    
    const addToCartBtn = document.getElementById('add-to-cart-btn');

    // 2. Add the listener for the 'Add to Cart' button
    if (addToCartBtn) {
        addToCartBtn.addEventListener('click', () => {
            // Call your existing addToCart function
            addToCart();
            
            // Optional: Provide visual feedback that the item was added
            provideFeedback(addToCartBtn);
        });
    }
});

// Optional: Makes the button turn green briefly when clicked
function provideFeedback(button) {
    const originalText = button.innerHTML;
    button.innerHTML = "✓ Added!";
    button.style.borderColor = "#27ae60";
    button.style.color = "#27ae60";
    
    setTimeout(() => {
        button.innerHTML = originalText;
        button.style.borderColor = "#1B75BB";
        button.style.color = "#1B75BB";
    }, 1500);
}

// Function for the +/- buttons
function changeQty(amount) {
    const qtyInput = document.getElementById('quantity');
    let currentVal = parseInt(qtyInput.value);
    let newVal = currentVal + amount;
    if (newVal >= 1 && newVal <= 99) {
        qtyInput.value = newVal;
    }
}

function addToCart() {
    const finish = document.getElementById('finish').value;
    const style = document.getElementById('style').value;
    const size = document.getElementById('size').value;
    const color = document.getElementById('selected-color').value;
    const qty = parseInt(document.getElementById('quantity').value);
    
    // Price logic
    const unitPrice = finish === "Raised Print" ? 40 : 60;
    const lineTotal = unitPrice * qty;

    if (!finish || !style || !size || !color) {
        alert("Please complete all selections first.");
        return;
    }

    // Add object with quantity and line total to array
    const item = { 
        qty, 
        finish, 
        style, 
        size, 
        color, 
        unitPrice, 
        lineTotal 
    };
    
    cart.push(item);
    
    // Reset quantity to 1 for the next item
    document.getElementById('quantity').value = 1;
    document.getElementById('line-item-total').innerText = "$0";
    renderCart();

}

function renderCart() {
    const cartDisplay = document.getElementById('cart-items-display');
    const grandTotalDisplay = document.getElementById('total-price'); // The final total
    const hiddenInput = document.getElementById('hidden-cart-data');
    
    cartDisplay.innerHTML = "";
    let grandTotal = 0;

    // Calculate total based ONLY on items actually in the cart array
    cart.forEach((item, index) => {
        grandTotal += item.lineTotal;
        
        const itemDiv = document.createElement('div');
        itemDiv.className = 'cart-item-row';
        itemDiv.innerHTML = `
            <div class="cart-item-info">
                <span class="qty-badge">${item.qty}x</span>
                <div><strong>${item.finish}</strong><br><small>${item.size} / ${item.color}</small></div>
            </div>
            <div class="cart-item-price">
                <span>$${item.lineTotal}</span>
                <button type="button" class="remove-btn" onclick="removeItem(${index})">&times;</button>
            </div>
        `;
        cartDisplay.appendChild(itemDiv);
    });

    grandTotalDisplay.innerText = `$${grandTotal}`;
    hiddenInput.value = JSON.stringify(cart, null, 2);
}


function removeItem(index) {
    cart.splice(index, 1);
    renderCart();
}

async function submitFinalOrder() {
    const form = document.getElementById('master-order-form');
    const submitBtn = document.getElementById('submit-order-btn');
    const cartData = document.getElementById('hidden-cart-data').value;

    // 1. Validation: Is the cart empty?
    if (cart.length === 0) {
        alert("Your cart is empty. Please add at least one item.");
        return;
    }

    // 2. Validation: Are name/email filled out?
    if (!form.checkValidity()) {
        form.reportValidity(); // This shows the browser's built-in "Please fill out this field"
        return;
    }

    // 3. Visual Feedback
    submitBtn.innerHTML = "Processing...";
    submitBtn.disabled = true;

    // 4. Send to Formspree
    const formData = new FormData(form);

    try {
        const response = await fetch(form.action, {
            method: 'POST',
            body: formData,
            headers: { 'Accept': 'application/json' }
        });

        if (response.ok) {
            // Success! Clear local cart and redirect
            cart = [];
            window.location.href = "../pages/thanks.html";
        } else {
            const result = await response.json();
            alert("Error: " + (result.errors ? result.errors[0].message : "Submission failed"));
            submitBtn.innerHTML = "Submit Full Order";
            submitBtn.disabled = false;
        }
    } catch (error) {
        alert("Oops! There was a connection problem.");
        submitBtn.innerHTML = "Submit Full Order";
        submitBtn.disabled = false;
    }
}