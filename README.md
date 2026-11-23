<div align="center">  <br>  s o f t p l a y

a quiet little music player for the songs already on your phone

<br>  ʚᵗ᷒ᰰɞ link : https://softplay.pages.dev/

<br> <img src="https://img.shields.io/badge/HTML5-FFB6C1?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5">
<img src="https://img.shields.io/badge/CSS3-FFB6C1?style=for-the-badge&logo=css3&logoColor=white" alt="CSS3">
<img src="https://img.shields.io/badge/JavaScript-FFB6C1?style=for-the-badge&logo=javascript&logoColor=white" alt="JavaScript">

" alt="JavaScript">  <br>  · · · · · · · · · · · · · · · · · · · · ·

</div>  <br>  about

Softplay is a single-page music player dressed like a phone control center, in blush pink, ivory and pearl. It plays audio files straight from your device. Nothing is uploaded, nothing is streamed, and there is no account to make. Pick your songs, press play.

<br>  what it does

- plays audio files from your own phone or computer
- reads title, artist and cover art from MP3 tags, and falls back to the file name
- keeps your library saved in the browser between visits
- shows an up next tile, a full queue, and a soft blurred glow from the current cover
- supports lock screen and notification controls through the Media Session API
- works with touch, mouse and keyboard

<br>  getting started

1. keep index.html, style.css and script.js together in one folder
2. host the folder anywhere that serves static files (GitHub Pages, Netlify, Cloudflare Pages), or run it locally

python3 -m http.server 8000

3. open the page, tap the tulip, and choose songs from your device

<br>  controls

control	what it does

bow	shuffle
loop	repeat: off, all, one
heart	like the current song
bars	mute and unmute, animates while playing
volume slider	drag up or down
speed slider	0.5x to 1.5x, snaps to 1x
library pill	opens the queue, tap a song to play it, tap the cross to remove it
moon pill	sleep timer: off, 15, 30 or 60 minutes
sun	keep the screen awake while listening
tulip	add songs
butterfly	change colors: blush, lilac, champagne, sage
bin	clear the library, tap twice to confirm


keyboard: space play or pause, left and right seek five seconds.

<br>  supported files

mp3 m4a aac wav flac ogg opus

What actually plays depends on your browser. Cover art and tags are read from MP3 files only.

<br>  files

softplay/  
  index.html     structure and icon sprite  
  style.css      theme, layout, palettes  
  script.js      player, library, tags, controls  
  README.md      you are here

<br>  privacy

Songs are stored in your browser's IndexedDB on your own device. Files never leave it. Clearing site data, or using a private window, removes your library. Fonts are the only thing fetched from the internet (Google Fonts).

<br>  good to know

- iOS ignores the volume slider because the system controls media volume
- the sleep timer pauses playback, it does not close the page
- keep-screen-awake needs a browser that supports the Screen Wake Lock API
- the library lives per browser and per web address, so moving the site to a new address starts fresh

<br>  make it yours

All colors live as variables at the top of style.css. The four palettes are the data-palette blocks just below them, so adding a fifth is one more block and one more name in the PAL list in script.js. Fonts are Cormorant Garamond, Pinyon Script and Quicksand.

<br>  <div align="center">  · · · · · · · · · · · · · · · · · · · · ·

<br>  made with soft things in mind

<br>  </div>  
make the icons in this baby pink. 
