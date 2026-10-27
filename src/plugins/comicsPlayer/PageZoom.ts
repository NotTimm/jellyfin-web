const MAX_SCALE = 8;
// each wheel notch zooms by this much, a quarter of it with Shift held
const WHEEL_STEP = 0.1;
const DOUBLE_TAP_SCALE = 2.5;
const PIXELS_PER_LINE = 40;
const EASE_MS = 160;

// a finger lifted slower than this just stops the page
const MIN_FLICK = 150;
const MAX_FLICK = 8000;
// a finger held still this long before lifting means "stop here"
const HELD_MS = 80;
// a glide slows to about a third of its speed every this many seconds
const GLIDE_SLOWDOWN = 0.35;
const GLIDE_STOP = 20;

interface Point {
    x: number;
    y: number;
}

/**
 * Tells a mouse wheel from a touchpad's two-finger scroll. Firefox reports
 * wheels in lines and touchpads in pixels; Chromium and Safari report
 * both in pixels, but a wheel notch has a wheelDelta that is a multiple
 * of 120. A touchpad can land on such a value mid-gesture, so scrolls
 * shortly after a touchpad one still count as a touchpad.
 */
class WheelSource {
    private touchpadUntil = 0;

    isMouseWheel(e: WheelEvent): boolean {
        let wheel = e.deltaMode === WheelEvent.DOM_DELTA_LINE;
        if (!wheel && e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
            const wheelDelta = (e as WheelEvent & { wheelDelta?: number }).wheelDelta;
            wheel = !!wheelDelta && wheelDelta % 120 === 0;
        }

        if (!wheel) {
            this.touchpadUntil = e.timeStamp + 500;
        }
        return wheel && e.timeStamp > this.touchpadUntil;
    }
}

function wheelPixels(e: WheelEvent, delta: number) {
    return e.deltaMode === WheelEvent.DOM_DELTA_LINE ? delta * PIXELS_PER_LINE : delta;
}

/**
 * Zooms and pans one comic page, like the Nebula Reader desktop app: the
 * mouse wheel zooms at the pointer, Ctrl + scroll or a pinch on a touchpad
 * zooms, a touchpad scroll or a drag pans, and on a touchscreen two
 * fingers pinch while one finger drags and flicks the page. The zoom is
 * kept across page turns and each new page starts at its top.
 */
export class PageZoom {
    readonly element: HTMLDivElement;
    active = false;
    fitWidth = false;
    onActiveChange?: (active: boolean) => void;

    private readonly img: HTMLImageElement;
    private readonly wheelSource = new WheelSource();
    private readonly pointers = new Map<number, Point>();
    private natural = { width: 0, height: 0 };
    private base = { width: 0, height: 0 };
    private scale = 1;
    private x = 0;
    private y = 0;
    // the zoom to return to after a two-page spread, which is shown whole
    private spreadScale?: number;
    private dragged = false;
    private velocity: Point = { x: 0, y: 0 };
    private lastMove = 0;
    private glideFrame = 0;
    private easeTimer?: ReturnType<typeof setTimeout>;

    constructor(container: HTMLElement) {
        this.element = document.createElement('div');
        this.element.className = 'comicsPageZoom swiper-no-swiping hide';
        this.img = document.createElement('img');
        this.img.className = 'comicsPageZoomImg';
        this.img.draggable = false;
        this.element.appendChild(this.img);
        container.appendChild(this.element);

        this.onClick = this.onClick.bind(this);
        this.element.addEventListener('click', this.onClick);
    }

    destroy() {
        cancelAnimationFrame(this.glideFrame);
        clearTimeout(this.easeTimer);
        this.element.removeEventListener('click', this.onClick);
        this.element.remove();
    }

    /**
     * Shows `src` in the viewer, at its top. Images already shown in the
     * page (as the current one always is) are ready at once.
     */
    setPage(src: string) {
        this.stopGlide();
        this.img.src = src;
        const apply = () => {
            if (this.img.getAttribute('src') !== src) return;
            this.natural = { width: this.img.naturalWidth, height: this.img.naturalHeight };

            // a spread is shown whole; the zoom comes back on the next page
            if (!this.fitWidth) {
                if (this.isSpread() && this.spreadScale === undefined) {
                    this.spreadScale = this.scale;
                    this.scale = 1;
                } else if (!this.isSpread() && this.spreadScale !== undefined) {
                    this.scale = this.spreadScale;
                    this.spreadScale = undefined;
                }
            }

            this.layout();
            if (this.fitWidth) this.scale = this.fitWidthScale();
            this.x = (this.element.clientWidth - this.base.width * this.scale) / 2;
            this.y = 0;
            this.render();
        };

        if (this.img.complete && this.img.naturalWidth) {
            apply();
        } else {
            this.img.decode().then(apply, () => { /* a broken page stays blank */ });
        }
    }

    open(src: string) {
        if (this.active) return;
        this.active = true;
        this.scale = 1;
        this.spreadScale = undefined;
        this.element.classList.remove('hide');
        this.setPage(src);
        this.onActiveChange?.(true);
    }

    close() {
        if (!this.active) return;
        this.stopGlide();
        this.pointers.clear();
        this.active = false;
        this.fitWidth = false;
        this.element.classList.add('hide');
        this.onActiveChange?.(false);
    }

    /** Fit to Width: the page as wide as the view, from its top, and back. */
    toggleFitWidth(src: string) {
        if (!this.fitWidth) {
            this.open(src);
            this.fitWidth = true;
            this.spreadScale = undefined;
            this.ease(this.fitWidthScale(), { x: 0, y: 0 });
        } else {
            this.fitWidth = false;
            this.ease(1, { x: 0, y: 0 }, () => this.close());
        }
    }

    /** Zooms in at the middle of the view, or back out to the whole page. */
    toggle(src: string) {
        if (this.fitWidth) {
            this.toggleFitWidth(src);
        } else if (this.active) {
            this.ease(1, { x: 0, y: 0 }, () => this.close());
        } else {
            this.open(src);
            const at = { x: this.element.clientWidth / 2, y: this.element.clientHeight / 2 };
            this.ease(DOUBLE_TAP_SCALE, this.offsetForZoom(DOUBLE_TAP_SCALE, at));
        }
    }

    onResize() {
        if (!this.active) return;
        const scale = this.fitWidth ? undefined : this.scale;
        this.layout();
        this.scale = scale ?? this.fitWidthScale();
        this.render();
    }

    /** Handles a wheel event over the page; `src` is the current page. */
    onWheel(e: WheelEvent, src: string) {
        const command = e.ctrlKey || e.metaKey;
        const fine = e.shiftKey;
        // Shift + wheel comes in as a sideways scroll on most systems
        const delta = fine && !e.deltaY ? e.deltaX : e.deltaY;

        e.preventDefault();
        if (!this.wheelSource.isMouseWheel(e)) {
            this.onTouchpadScroll(e, src);
            return;
        }
        if (!delta) return;

        if (command || this.fitWidth) {
            // Ctrl (Cmd on a Mac) + wheel scrolls a zoomed page, with Shift
            // sideways; in Fit to Width the wheel always scrolls
            if (!this.active) return;
            const pixels = -wheelPixels(e, delta);
            if (command && fine) {
                this.panBy(pixels, 0);
            } else {
                this.panBy(0, pixels);
            }
            return;
        }

        const step = fine ? WHEEL_STEP / 4 : WHEEL_STEP;
        const scale = delta < 0 ? this.scale * (1 + step) : this.scale / (1 + step);
        this.zoomAt(scale, this.point(e), src);
    }

    private onTouchpadScroll(e: WheelEvent, src: string) {
        if (e.ctrlKey) {
            // a touchpad pinch, or Ctrl + two-finger scroll
            this.zoomAt(this.scale * Math.exp(-wheelPixels(e, e.deltaY) / 100), this.point(e), src);
        } else if (this.active) {
            this.panBy(-wheelPixels(e, e.deltaX), -wheelPixels(e, e.deltaY));
        }
    }

    onDoubleClick(e: MouseEvent, src: string) {
        if (this.fitWidth) return;
        if (this.active) {
            this.ease(1, { x: 0, y: 0 }, () => this.close());
        } else {
            this.open(src);
            this.ease(DOUBLE_TAP_SCALE, this.offsetForZoom(DOUBLE_TAP_SCALE, this.point(e)));
        }
    }

    /**
     * Pointer events from anywhere in the player. Returns true when the
     * viewer takes the gesture, so the page swiper should leave it alone.
     */
    onPointerDown(e: PointerEvent, src: string): boolean {
        if (e.pointerType === 'mouse') {
            if (!this.active || e.button !== 0) return false;
            this.element.setPointerCapture(e.pointerId);
        } else if (!this.active && this.pointers.size === 0) {
            // one finger on the whole page turns pages; remember it in case
            // a second finger joins it for a pinch
            this.pointers.set(e.pointerId, this.point(e));
            return false;
        }

        this.stopGlide();
        this.dragged = false;
        this.pointers.set(e.pointerId, this.point(e));
        this.velocity = { x: 0, y: 0 };
        this.lastMove = e.timeStamp;

        if (!this.active && this.pointers.size === 2) {
            this.open(src);
        }
        return this.active;
    }

    onPointerMove(e: PointerEvent) {
        const last = this.pointers.get(e.pointerId);
        if (!last) return;
        const now = this.point(e);

        if (!this.active) {
            this.pointers.set(e.pointerId, now);
            return;
        }

        if (this.pointers.size === 2) {
            const [other] = [...this.pointers].filter(([id]) => id !== e.pointerId).map(([, p]) => p);
            const before = Math.hypot(last.x - other.x, last.y - other.y);
            const after = Math.hypot(now.x - other.x, now.y - other.y);
            const midBefore = { x: (last.x + other.x) / 2, y: (last.y + other.y) / 2 };
            const midAfter = { x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 };

            if (before > 0) {
                this.fitWidth = false;
                this.zoomAt(this.scale * after / before, midBefore);
            }
            this.panBy(midAfter.x - midBefore.x, midAfter.y - midBefore.y);
        } else {
            const moved = { x: now.x - last.x, y: now.y - last.y };
            if (Math.abs(moved.x) + Math.abs(moved.y) > 0) this.dragged = true;
            this.trackVelocity(moved, e.timeStamp);
            this.panBy(moved.x, moved.y);
        }
        this.pointers.set(e.pointerId, now);
    }

    onPointerUp(e: PointerEvent) {
        if (!this.pointers.delete(e.pointerId) || !this.active) return;

        if (this.pointers.size === 1) {
            // from a pinch to one finger: carry on dragging from here
            this.velocity = { x: 0, y: 0 };
            this.lastMove = e.timeStamp;
        } else if (this.pointers.size === 0) {
            if (this.scale <= 1.01 && !this.fitWidth) {
                this.close();
            } else if (e.pointerType !== 'mouse') {
                this.flick(e.timeStamp);
            }
        }
    }

    private onClick(e: MouseEvent) {
        // the end of a drag isn't a click on the page
        if (this.dragged) {
            e.stopPropagation();
            this.dragged = false;
        }
    }

    private isSpread() {
        return this.natural.width > this.natural.height;
    }

    private layout() {
        const { width, height } = this.natural;
        const ratio = width && height ?
            Math.min(this.element.clientWidth / width, this.element.clientHeight / height) :
            0;
        this.base = { width: width * ratio, height: height * ratio };
        this.img.style.width = `${this.base.width}px`;
        this.img.style.height = `${this.base.height}px`;
    }

    private fitWidthScale() {
        return this.base.width ? Math.max(this.element.clientWidth / this.base.width, 1) : 1;
    }

    private point(e: MouseEvent): Point {
        const rect = this.element.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    private offsetForZoom(scale: number, at: Point): Point {
        return {
            x: at.x - (at.x - this.x) * scale / this.scale,
            y: at.y - (at.y - this.y) * scale / this.scale
        };
    }

    private zoomAt(scale: number, at: Point, src?: string) {
        scale = Math.min(Math.max(scale, 1), MAX_SCALE);
        if (!this.active) {
            if (scale <= 1 || !src) return;
            this.open(src);
        }
        this.stopGlide();
        this.spreadScale = undefined;
        const offset = this.offsetForZoom(scale, at);
        this.scale = scale;
        this.x = offset.x;
        this.y = offset.y;
        this.render();

        if (scale === 1 && !this.fitWidth && this.pointers.size === 0) {
            this.close();
        }
    }

    private panBy(dx: number, dy: number) {
        this.x += dx;
        this.y += dy;
        this.render();
    }

    /** Keeps the page from being pushed past its own edges. */
    private clamp() {
        const clampAxis = (offset: number, size: number, view: number) => {
            if (size <= view) return (view - size) / 2;
            return Math.min(0, Math.max(view - size, offset));
        };
        this.x = clampAxis(this.x, this.base.width * this.scale, this.element.clientWidth);
        this.y = clampAxis(this.y, this.base.height * this.scale, this.element.clientHeight);
    }

    private render() {
        this.clamp();
        this.img.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    }

    /** A quick move to another zoom, fast enough to feel like a snap. */
    private ease(scale: number, offset: Point, done?: () => void) {
        clearTimeout(this.easeTimer);
        this.stopGlide();
        this.scale = scale;
        this.x = offset.x;
        this.y = offset.y;
        this.img.classList.add('comicsPageZoomEase');
        this.render();
        this.easeTimer = setTimeout(() => {
            this.img.classList.remove('comicsPageZoomEase');
            done?.();
        }, EASE_MS);
    }

    private trackVelocity(moved: Point, time: number) {
        const dt = (time - this.lastMove) / 1000;
        if (dt > HELD_MS / 1000) {
            // paused mid-drag: start over from here
            this.velocity = { x: 0, y: 0 };
        } else if (dt > 0) {
            this.velocity = {
                x: this.velocity.x * 0.3 + moved.x * 0.7 / dt,
                y: this.velocity.y * 0.3 + moved.y * 0.7 / dt
            };
        }
        this.lastMove = time;
    }

    /** Lets a page flicked by a finger glide on to a stop. */
    private flick(time: number) {
        const speed = Math.hypot(this.velocity.x, this.velocity.y);
        if (time - this.lastMove > HELD_MS || speed < MIN_FLICK) return;
        const factor = Math.min(speed, MAX_FLICK) / speed;
        const velocity = { x: this.velocity.x * factor, y: this.velocity.y * factor };

        let last = performance.now();
        const step = (now: number) => {
            // a frame that came late (tab hidden) doesn't jump
            const dt = Math.min((now - last) / 1000, 0.05);
            last = now;
            const before = { x: this.x, y: this.y };
            this.panBy(velocity.x * dt, velocity.y * dt);
            // stop along an edge the page has reached
            if (this.x === before.x) velocity.x = 0;
            if (this.y === before.y) velocity.y = 0;

            const decay = Math.exp(-dt / GLIDE_SLOWDOWN);
            velocity.x *= decay;
            velocity.y *= decay;
            if (Math.abs(velocity.x) < GLIDE_STOP && Math.abs(velocity.y) < GLIDE_STOP) {
                this.glideFrame = 0;
                return;
            }
            this.glideFrame = requestAnimationFrame(step);
        };
        this.glideFrame = requestAnimationFrame(step);
    }

    private stopGlide() {
        cancelAnimationFrame(this.glideFrame);
        this.glideFrame = 0;
    }
}
