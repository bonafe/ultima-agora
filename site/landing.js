//Landing page behaviour: the background art follows the scroll, chapters fade in as they are reached.
import { AgoraArt } from './art.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canvas = document.getElementById('art');
const art = new AgoraArt(canvas, { still: reduced });

const progress = () => {
    const room = document.documentElement.scrollHeight - innerHeight;
    return room > 0 ? scrollY / room : 0;
};
const update = () => {
    art.setProgress(progress());
    const bar = document.getElementById('progress');
    if (bar) bar.style.transform = `scaleX(${progress()})`;
    document.querySelector('.top')?.classList.toggle('solid', scrollY > 40);
};

addEventListener('scroll', update, { passive: true });
addEventListener('resize', () => { art.resize(); update(); });
addEventListener('pointermove', event => art.pointer(event.clientX, event.clientY, event.pointerType !== 'touch'), { passive: true });
document.addEventListener('pointerleave', () => art.pointer(0, 0, false));
document.addEventListener('visibilitychange', () => document.hidden ? art.stop() : art.start());

const seen = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('in'); seen.unobserve(entry.target); }
}, { threshold: 0.18 });
document.querySelectorAll('.reveal').forEach(el => seen.observe(el));

update();
art.setProgress(progress());
art.start();

//Offline after the first visit, like the app
addEventListener('load', () => import('../core/offline/register_sw.js').then(m => m.registerOfflineShell()));
