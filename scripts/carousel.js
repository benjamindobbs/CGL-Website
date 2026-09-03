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
    "/assets/carousel/carousel-01.JPG" // Ghost of image 1 for a seamless loop
];

document.addEventListener('DOMContentLoaded', () => {
    const track = document.getElementById('carousel-track');
    if (!track) return;

    photos.forEach((src) => {
        const slide = document.createElement('img');
        slide.className = 'carousel-slide';
        slide.src = src;
        slide.alt = '';
        track.appendChild(slide);
    });
});
