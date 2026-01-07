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

function updatePrice() {
    const finishSelect = document.getElementById('finish');
    const priceDisplay = document.getElementById('total-price');
    const hiddenPrice = document.getElementById('hidden-price');
    
    let price = 0;

    if (finishSelect.value === "Raised Print") {
        price = 40;
    } else if (finishSelect.value === "Embossed Embroidery") {
        price = 60;
    }

    if (price > 0) {
        const formattedPrice = `$${price}`;
        priceDisplay.innerText = formattedPrice;
        hiddenPrice.value = formattedPrice;
        
        // Visual flair: make the price "pop" when it changes
        priceDisplay.style.transform = "scale(1.1)";
        setTimeout(() => { priceDisplay.style.transform = "scale(1)"; }, 200);
    }
}