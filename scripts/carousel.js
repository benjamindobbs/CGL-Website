const photos = [
    "/assets/carousel/carousel-01.JPG",
    "/assets/carousel/carousel-02.JPG",
    "/assets/carousel/carousel-03.JPG",
    "/assets/carousel/carousel-04.JPG",
    "/assets/carousel/carousel-05.JPG",
    "/assets/carousel/carousel-06.JPG",
    "/assets/carousel/carousel-07.JPG",
    "/assets/carousel/carousel-08.JPG",
    "/assets/carousel/carousel-09.JPG",
    "/assets/carousel/carousel-10.JPG",
    "/assets/carousel/carousel-11.JPG",
    "/assets/carousel/carousel-12.JPG"
];

// Fraction of each photo's "leg" spent holding still vs. sliding to the next one.
const HOLD_RATIO = 0.78;
// Full loop duration, regardless of how many photos are in the array.
const CYCLE_SECONDS = 80;

document.addEventListener('DOMContentLoaded', () => {
    const track = document.getElementById('carousel-track');
    if (!track) return;

    // Repeat the first photo at the end so the loop can snap back seamlessly.
    const slides = [...photos, photos[0]];

    slides.forEach((src) => {
        const slide = document.createElement('img');
        slide.className = 'carousel-slide';
        slide.src = src;
        slide.alt = '';
        track.appendChild(slide);
    });

    track.style.setProperty('--carousel-slides', slides.length);
    injectScrollKeyframes(slides.length);
});

// Builds an @keyframes scroll rule with one hold-then-slide "leg" per real
// photo, sized to the actual slide count so nothing has to be hand-tuned
// when photos are added or removed from the array above.
function injectScrollKeyframes(totalSlides) {
    const realPhotoCount = totalSlides - 1;
    const legWidth = 100 / realPhotoCount;
    const holdWidth = legWidth * HOLD_RATIO;

    const stops = [];
    for (let i = 0; i < realPhotoCount; i++) {
        const start = (i * legWidth).toFixed(4);
        const holdEnd = (i * legWidth + holdWidth).toFixed(4);
        const position = (-(i / totalSlides) * 100).toFixed(4);
        stops.push(`${start}%, ${holdEnd}% { transform: translateX(${position}%); }`);
    }
    const ghostPosition = (-(realPhotoCount / totalSlides) * 100).toFixed(4);
    stops.push(`100% { transform: translateX(${ghostPosition}%); }`);

    const style = document.createElement('style');
    style.textContent = `.carousel-track { animation-duration: ${CYCLE_SECONDS}s; }\n@keyframes scroll {\n${stops.join('\n')}\n}`;
    document.head.appendChild(style);
}
