const photos = [
    { src: "assets/carousel/carousel-01.JPG", caption: 'Place Holder' },
    { src: 'assets/carousel/carousel-02.JPG', caption: 'Place Holder' },
    { src: 'assets/carousel/carousel-03.JPG', caption: 'Place Holder' },
    { src: 'assets/carousel/carousel-04.JPG', caption: 'Place Holder' },
    { src: "assets/carousel/carousel-05.JPG", caption: 'Place Holder' },
    { src: 'assets/carousel/carousel-06.JPG', caption: 'Place Holder' },
    { src: 'assets/carousel/carousel-07.JPG', caption: 'Place Holder' },
    { src: 'assets/carousel/carousel-08.JPG', caption: 'Place Holder' },
    { src: 'assets/carousel/carousel-09.JPG', caption: 'Place Holder' },
    { src: 'assets/carousel/carousel-10.JPG', caption: 'Place Holder' },
    { src: 'assets/carousel/carousel-11.JPG', caption: 'Place Holder' },
    { src: "assets/carousel/carousel-01.JPG", caption: 'Place Holder' }

];

document.addEventListener('DOMContentLoaded', () => {
    const grid = document.getElementById('carousel-track');

    photos.forEach((photo) => {
        const card = document.createElement('img');
        card.className = 'carousel-track';
        

        card.src= photo.src;
        card.alt= photo.caption;

        grid.appendChild(card);
    });
});