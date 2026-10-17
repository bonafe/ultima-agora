//The living background of the landing page: one canvas, one number (scroll progress 0..1), a story in six acts.
//
//  1. an empty square at dusk, columns in the haze          4. machines arrive: a graph of ideas takes shape
//  2. people drift in; the first lines appear               5. the space unfolds into floating panels and devices
//  3. conversation: voices ripple outward                   6. dawn: the columns return, lit from behind
//
//Everything is a function of progress, so scrolling back rewinds the picture. With "reduce motion" nothing moves by itself:
//the picture only changes as the page is scrolled.

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const bump = (a, b, c, d, v) => smooth(a, b, v) * (1 - smooth(c, d, v));     // rises between a-b, falls between c-d
const mix = (c1, c2, t) => c1.map((v, i) => lerp(v, c2[i], t));
const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

//[progress, sky top, sky bottom]
const SKY = [
    [0.00, [9, 11, 30], [30, 22, 58]],        // night over the empty square
    [0.20, [16, 18, 50], [64, 40, 88]],       // dusk
    [0.40, [8, 36, 62], [22, 86, 98]],        // people meet: sea green
    [0.60, [12, 20, 56], [10, 58, 92]],       // machines join: deep blue
    [0.80, [44, 26, 74], [126, 62, 96]],      // rose
    [1.00, [96, 56, 88], [242, 168, 98]],     // dawn
];
const sky = p => {
    let i = 0;
    while (i < SKY.length - 2 && p > SKY[i + 1][0]) i++;
    const [p0, t0, b0] = SKY[i], [p1, t1, b1] = SKY[i + 1], t = smooth(p0, p1, p);
    return [mix(t0, t1, t), mix(b0, b1, t)];
};

const WARM = [255, 214, 150];      // people
const COOL = [120, 226, 232];      // machines
const WHITE = [255, 255, 255];

//Deterministic pseudo-random so the picture is the same on every visit and in every test
const rng = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

export class AgoraArt {
    #canvas; #ctx; #w = 0; #h = 0; #dpr = 1;
    #p = 0; #target = 0; #time = 0; #last = 0; #raf = 0;
    #people; #machines; #stars; #panels;
    #ripples = []; #nextRipple = 0;
    #pointer = { x: -1e4, y: -1e4, on: false };
    #still;

    constructor(canvas, { still = false } = {}) {
        this.#canvas = canvas;
        this.#ctx = canvas.getContext('2d');
        this.#still = still;
        const rand = rng(7);
        this.#people = Array.from({ length: 84 }, () => ({ x: rand(), y: rand(), a: rand() * 6.28, s: 0.4 + rand() * 0.9, r: 1.4 + rand() * 1.8, depth: 0.3 + rand() * 0.7 }));
        this.#machines = Array.from({ length: 26 }, () => ({ x: 0.08 + rand() * 0.84, y: 0.1 + rand() * 0.8, a: rand() * 6.28, s: 0.3 + rand() * 0.5, r: 3 + rand() * 3, depth: 0.5 + rand() * 0.5 }));
        this.#stars = Array.from({ length: 140 }, () => ({ x: rand(), y: rand() * 0.8, r: 0.4 + rand() * 1.1, t: rand() * 6.28 }));
        this.#panels = [
            { x: 0.10, y: 0.18, w: 0.26, h: 0.22, d: 0.5, tilt: -0.05 }, { x: 0.62, y: 0.12, w: 0.24, h: 0.30, d: 1.0, tilt: 0.04 },
            { x: 0.34, y: 0.52, w: 0.30, h: 0.24, d: 0.7, tilt: 0.02 }, { x: 0.72, y: 0.58, w: 0.12, h: 0.26, d: 1.3, tilt: -0.03 },
            { x: 0.05, y: 0.62, w: 0.16, h: 0.22, d: 1.1, tilt: 0.05 },
        ];
        this.resize();
    }

    get progress() { return this.#p; }

    resize() {
        this.#dpr = Math.min(devicePixelRatio || 1, 2);
        this.#w = innerWidth; this.#h = innerHeight;
        this.#canvas.width = Math.round(this.#w * this.#dpr);
        this.#canvas.height = Math.round(this.#h * this.#dpr);
        this.#ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
        this.draw(0);
    }

    setProgress(p) {
        this.#target = clamp(p);
        if (this.#still) { this.#p = this.#target; this.draw(0); }
    }

    pointer(x, y, on = true) { this.#pointer = { x, y, on }; }

    start() {
        if (this.#still || this.#raf) return;
        this.#last = performance.now();
        const frame = now => {
            const dt = Math.min(0.05, (now - this.#last) / 1000);
            this.#last = now;
            this.#p += (this.#target - this.#p) * Math.min(1, dt * 4);        // the picture follows the scroll with a little inertia
            this.#time += dt;
            this.draw(dt);
            this.#raf = requestAnimationFrame(frame);
        };
        this.#raf = requestAnimationFrame(frame);
    }

    stop() { cancelAnimationFrame(this.#raf); this.#raf = 0; }

    draw(dt) {
        const c = this.#ctx, w = this.#w, h = this.#h, p = this.#p, t = this.#time;
        const [top, bottom] = sky(p);
        const g = c.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, rgb(top)); g.addColorStop(1, rgb(bottom));
        c.fillStyle = g; c.fillRect(0, 0, w, h);

        this.#drawSun(c, w, h, p);
        this.#drawStars(c, w, h, p, t);
        this.#drawColumns(c, w, h, p);

        const meeting = smooth(0.12, 0.38, p);                                  // how far people reach for each other
        const machinesIn = smooth(0.48, 0.64, p);
        const scrollShift = p * h * 0.35;
        const people = this.#people.map(o => this.#move(o, w, h, t, scrollShift));
        const machines = this.#machines.map(o => this.#move(o, w, h, t, scrollShift * 0.6));

        this.#drawRipples(c, people, p, t, dt);
        this.#drawLinks(c, people, meeting * 150, WARM, 0.32 * meeting);
        if (machinesIn > 0.01) {
            this.#drawLinks(c, machines, 210, COOL, 0.5 * machinesIn);
            this.#drawBridges(c, people, machines, 130, 0.18 * machinesIn);
        }
        this.#drawPeople(c, people, p, t);
        if (machinesIn > 0.01) this.#drawMachines(c, machines, machinesIn, t);
        this.#drawPanels(c, w, h, p, t);
        this.#drawPointer(c, people, meeting);
    }

    //A point's screen position: slow drift on its own orbit, pushed by scroll according to its depth (parallax)
    #move(o, w, h, t, shift) {
        const sp = this.#still ? 0 : 1;
        const x = (o.x + Math.sin(t * 0.12 * o.s * sp + o.a) * 0.035) * w;
        let y = (o.y + Math.cos(t * 0.1 * o.s * sp + o.a * 1.7) * 0.03) * h - shift * o.depth;
        y = ((y % (h * 1.1)) + h * 1.1) % (h * 1.1) - h * 0.05;            // wraps, so scrolling never empties the sky
        return { ...o, px: x, py: y };
    }

    #drawSun(c, w, h, p) {
        const rise = smooth(0.74, 1, p);
        if (rise < 0.01) return;
        const cx = w * 0.5, cy = h * (1.25 - 0.45 * rise), r = Math.max(w, h) * (0.35 + 0.25 * rise);
        const g = c.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, `rgba(255,224,160,${0.85 * rise})`);
        g.addColorStop(0.35, `rgba(255,170,110,${0.35 * rise})`);
        g.addColorStop(1, 'rgba(255,120,120,0)');
        c.fillStyle = g; c.fillRect(0, 0, w, h);
    }

    #drawStars(c, w, h, p, t) {
        const night = 1 - smooth(0.25, 0.75, p) * 0.75 - smooth(0.85, 1, p) * 0.25;
        for (const s of this.#stars) {
            const a = night * (0.35 + 0.35 * Math.sin(t * 0.8 + s.t));
            if (a < 0.02) continue;
            c.fillStyle = rgb(WHITE, a);
            c.beginPath(); c.arc(s.x * w, s.y * h - p * h * 0.08, s.r, 0, 6.283); c.fill();
        }
    }

    //Doric columns in the haze: the square at the start, and again at dawn
    #drawColumns(c, w, h, p) {
        const alpha = 0.2 * (1 - smooth(0.06, 0.26, p)) + 0.16 * smooth(0.84, 0.97, p);
        if (alpha < 0.01) return;
        const count = w < 700 ? 4 : 7, gap = w / (count + 1), colW = Math.min(46, gap * 0.34), base = h * 0.98, top = h * 0.6;
        const lift = p < 0.5 ? p * h * 0.25 : (1 - p) * h * 0.25;               // they sink away as the story goes on, and rise back
        for (let i = 0; i < count; i++) {
            const x = gap * (i + 1), y0 = top + lift, y1 = base + lift;
            const shade = c.createLinearGradient(x - colW / 2, 0, x + colW / 2, 0);
            shade.addColorStop(0, rgb(WHITE, alpha * 0.2)); shade.addColorStop(0.45, rgb(WHITE, alpha)); shade.addColorStop(1, rgb(WHITE, alpha * 0.15));
            c.fillStyle = shade;
            c.fillRect(x - colW / 2, y0, colW, y1 - y0);
            c.fillRect(x - colW * 0.72, y0 - 12, colW * 1.44, 12);               // capital
            c.fillRect(x - colW * 0.6, y0 - 22, colW * 1.2, 8);
            c.fillRect(x - colW * 0.7, y1 - 10, colW * 1.4, 10);                 // base
            c.strokeStyle = rgb(WHITE, alpha * 0.25); c.lineWidth = 1;
            for (let f = -1; f <= 1; f++) { c.beginPath(); c.moveTo(x + f * colW * 0.22, y0); c.lineTo(x + f * colW * 0.22, y1 - 10); c.stroke(); }
        }
        c.fillStyle = rgb(WHITE, alpha * 0.55);                                  // the lintel
        c.fillRect(gap * 0.5, top + lift - 40, w - gap, 18);
    }

    #drawLinks(c, pts, maxDist, color, alpha) {
        if (maxDist < 8 || alpha < 0.01) return;
        c.lineWidth = 1;
        for (let i = 0; i < pts.length; i++) {
            for (let j = i + 1; j < pts.length; j++) {
                const dx = pts[i].px - pts[j].px, dy = pts[i].py - pts[j].py, d = Math.hypot(dx, dy);
                if (d > maxDist) continue;
                c.strokeStyle = rgb(color, alpha * (1 - d / maxDist));
                c.beginPath(); c.moveTo(pts[i].px, pts[i].py); c.lineTo(pts[j].px, pts[j].py); c.stroke();
            }
        }
    }

    #drawBridges(c, people, machines, maxDist, alpha) {
        c.lineWidth = 1; c.setLineDash([3, 5]);
        for (const m of machines) {
            for (const q of people) {
                const d = Math.hypot(m.px - q.px, m.py - q.py);
                if (d > maxDist) continue;
                c.strokeStyle = rgb(mix(WARM, COOL, 0.5), alpha * (1 - d / maxDist));
                c.beginPath(); c.moveTo(m.px, m.py); c.lineTo(q.px, q.py); c.stroke();
            }
        }
        c.setLineDash([]);
    }

    #drawPeople(c, pts, p, t) {
        for (const o of pts) {
            const pulse = 1 + 0.18 * Math.sin(t * 1.4 + o.a);
            const halo = c.createRadialGradient(o.px, o.py, 0, o.px, o.py, o.r * 6);
            halo.addColorStop(0, rgb(WARM, 0.28)); halo.addColorStop(1, rgb(WARM, 0));
            c.fillStyle = halo; c.beginPath(); c.arc(o.px, o.py, o.r * 6, 0, 6.283); c.fill();
            c.fillStyle = rgb(WARM, 0.95); c.beginPath(); c.arc(o.px, o.py, o.r * pulse, 0, 6.283); c.fill();
        }
    }

    //Machines are squares turned into diamonds: a different shape, so nobody mistakes who is who
    #drawMachines(c, pts, k, t) {
        for (const o of pts) {
            const r = o.r * (0.6 + 0.4 * k) * (1 + 0.1 * Math.sin(t * 1.1 + o.a));
            c.save(); c.translate(o.px, o.py); c.rotate(Math.PI / 4 + Math.sin(t * 0.3 + o.a) * 0.15);
            c.fillStyle = rgb(COOL, 0.16 * k); c.fillRect(-r * 2.2, -r * 2.2, r * 4.4, r * 4.4);
            c.fillStyle = rgb(COOL, 0.95 * k); c.fillRect(-r, -r, r * 2, r * 2);
            c.restore();
        }
    }

    //Conversation: rings spread from a person who "speaks"; it is the act of the whole page that calls for them
    #drawRipples(c, people, p, t, dt) {
        const voice = bump(0.22, 0.34, 0.5, 0.64, p);
        if (voice > 0.05 && !this.#still) {
            this.#nextRipple -= dt;
            if (this.#nextRipple <= 0) {
                const speaker = people[Math.floor(Math.random() * people.length)];
                this.#ripples.push({ x: speaker.px, y: speaker.py, age: 0 });
                this.#nextRipple = lerp(1.4, 0.35, voice);
            }
        }
        this.#ripples = this.#ripples.filter(r => (r.age += dt) < 3.2);
        for (const r of this.#ripples) {
            const k = r.age / 3.2;
            for (let ring = 0; ring < 3; ring++) {
                const kk = k - ring * 0.08;
                if (kk <= 0) continue;
                c.strokeStyle = rgb(WARM, 0.35 * (1 - kk) * Math.max(voice, 0.25));
                c.lineWidth = 1.5;
                c.beginPath(); c.arc(r.x, r.y, kk * 260, 0, 6.283); c.stroke();
            }
        }
        if (this.#still && voice > 0.05) {                                         // reduced motion: a fixed set of rings, still part of the picture
            for (const s of people.slice(0, 5)) for (let ring = 1; ring <= 3; ring++) {
                c.strokeStyle = rgb(WARM, 0.2 * voice / ring); c.lineWidth = 1.2;
                c.beginPath(); c.arc(s.px, s.py, ring * 46, 0, 6.283); c.stroke();
            }
        }
    }

    //The space unfolds: panels float at different depths (the idea of windows, devices and rooms)
    #drawPanels(c, w, h, p, t) {
        const a = bump(0.58, 0.72, 0.9, 0.99, p);
        if (a < 0.01) return;
        for (const q of this.#panels) {
            const drift = this.#still ? 0 : Math.sin(t * 0.3 * q.d + q.x * 9) * 8;
            const x = q.x * w, y = q.y * h + drift - (p - 0.75) * h * 0.5 * q.d, pw = q.w * w, ph = q.h * h;
            c.save(); c.translate(x + pw / 2, y + ph / 2); c.rotate(q.tilt * a);
            c.fillStyle = rgb(WHITE, 0.05 * a); c.strokeStyle = rgb(WHITE, 0.3 * a); c.lineWidth = 1.2;
            c.beginPath(); c.roundRect(-pw / 2, -ph / 2, pw, ph, 10); c.fill(); c.stroke();
            c.fillStyle = rgb(WHITE, 0.14 * a); c.fillRect(-pw / 2 + 10, -ph / 2 + 10, pw * 0.4, 5);          // title bar
            for (let i = 0; i < 3; i++) c.fillRect(-pw / 2 + 10, -ph / 2 + 28 + i * 12, pw * (0.75 - i * 0.18), 4);
            c.fillStyle = rgb(COOL, 0.5 * a); c.beginPath(); c.arc(pw / 2 - 14, -ph / 2 + 12, 3, 0, 6.283); c.fill();
            c.restore();
        }
    }

    //The visitor is a person too: the first one to arrive, and the points reach toward them
    #drawPointer(c, people, meeting) {
        const m = this.#pointer;
        if (!m.on) return;
        c.lineWidth = 1;
        for (const o of people) {
            const d = Math.hypot(o.px - m.x, o.py - m.y);
            if (d > 170) continue;
            c.strokeStyle = rgb(WARM, 0.5 * (1 - d / 170));
            c.beginPath(); c.moveTo(m.x, m.y); c.lineTo(o.px, o.py); c.stroke();
        }
        const halo = c.createRadialGradient(m.x, m.y, 0, m.x, m.y, 26);
        halo.addColorStop(0, rgb(WARM, 0.5)); halo.addColorStop(1, rgb(WARM, 0));
        c.fillStyle = halo; c.beginPath(); c.arc(m.x, m.y, 26, 0, 6.283); c.fill();
        c.fillStyle = rgb(WARM, 1); c.beginPath(); c.arc(m.x, m.y, 3.2, 0, 6.283); c.fill();
    }
}
