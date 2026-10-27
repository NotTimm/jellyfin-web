import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api';
import { Archive } from 'libarchive.js';
import Screenfull from 'screenfull';

import { PluginType } from 'constants/pluginType';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import screenSaverManager from 'scripts/screensavermanager';

import loading from '../../components/loading/loading';
import dialogHelper from '../../components/dialogHelper/dialogHelper';
import keyboardnavigation from '../../scripts/keyboardNavigation';
import { appRouter } from '../../components/router/appRouter';
import * as userSettings from '../../scripts/settings/userSettings';
import BookOsd from '../bookPlayer/BookOsd/BookOsd';
import Events from '../../utils/events.ts';
import { renderComponent } from '../../utils/reactUtils';
import { PageZoom } from './PageZoom';

import 'material-design-icons-iconfont';
import './style.scss';

// supported book file extensions
const FILE_EXTENSIONS = ['.cbr', '.cbt', '.cbz', '.cb7'];
// the comic book archive supports any kind of image format as it's just a zip archive
const IMAGE_FORMATS = ['jpg', 'jpeg', 'jpe', 'jif', 'jfif', 'jfi', 'png', 'avif', 'gif', 'bmp', 'dib', 'tiff', 'tif', 'webp'];

export class ComicsPlayer {
    constructor() {
        this.name = 'Comics Player';
        this.type = PluginType.MediaPlayer;
        this.id = 'comicsplayer';
        this.priority = 1;
        this.imageMap = new Map();

        this.previous = this.previous.bind(this);
        this.next = this.next.bind(this);
        this.onDirChanged = this.onDirChanged.bind(this);
        this.onViewChanged = this.onViewChanged.bind(this);

        this.onDialogClosed = this.onDialogClosed.bind(this);
        this.onWindowKeyDown = this.onWindowKeyDown.bind(this);
        this.toggleFullscreen = this.toggleFullscreen.bind(this);
        this.toggleFitWidth = this.toggleFitWidth.bind(this);
        this.onWheel = this.onWheel.bind(this);
        this.onPointerDown = this.onPointerDown.bind(this);
        this.onPointerMove = this.onPointerMove.bind(this);
        this.onPointerUp = this.onPointerUp.bind(this);
        this.onDoubleClick = this.onDoubleClick.bind(this);
        this.onResize = this.onResize.bind(this);
    }

    play(options) {
        this.currentPage = 0;
        this.pageCount = 0;

        const mediaSourceId = options.items[0].Id;
        this.comicsPlayerSettings = userSettings.getComicsPlayerSettings(mediaSourceId);

        screenSaverManager.block();
        const elem = this.createMediaElement(options);
        return this.setCurrentSrc(elem, options);
    }

    stop() {
        this.unbindEvents();
        this.unmountBookOsd?.();
        screenSaverManager.unblock();

        const stopInfo = {
            src: this.item
        };

        Events.trigger(this, 'stopped', [stopInfo]);

        const mediaSourceId = this.item.Id;
        userSettings.setComicsPlayerSettings(this.comicsPlayerSettings, mediaSourceId);

        this.pageZoom?.destroy();
        this.pageZoom = null;
        this.archiveSource?.release();

        const elem = this.mediaElement;
        if (elem) {
            dialogHelper.close(elem);
            this.mediaElement = null;
        }

        loading.hide();
    }

    destroy() {
        // Nothing to do here
    }

    currentTime() {
        return this.currentPage;
    }

    duration() {
        return this.pageCount;
    }

    currentItem() {
        return this.item;
    }

    volume() {
        return 100;
    }

    isMuted() {
        return false;
    }

    paused() {
        return false;
    }

    seekable() {
        return true;
    }

    onDialogClosed() {
        this.stop();
    }

    onDirChanged() {
        let langDir = this.comicsPlayerSettings.langDir;

        if (!langDir || langDir === 'ltr') {
            langDir = 'rtl';
        } else {
            langDir = 'ltr';
        }

        this.changeLanguageDirection(langDir);

        this.comicsPlayerSettings.langDir = langDir;
    }

    changeLanguageDirection(langDir) {
        const currentPage = this.currentPage;

        this.swiperInstance.changeLanguageDirection(langDir);
        this.reload(currentPage);
    }

    onViewChanged() {
        let view = this.comicsPlayerSettings.pagesPerView;

        if (!view || view === 1) {
            view = 2;
        } else {
            view = 1;
        }

        this.changeView(view);

        this.comicsPlayerSettings.pagesPerView = view;
    }

    changeView(view) {
        const currentPage = this.currentPage;

        this.swiperInstance.params.slidesPerView = view;
        this.swiperInstance.params.slidesPerGroup = view;

        this.reload(currentPage);
    }

    reload(currentPage) {
        const effect = this.swiperInstance.params.effect;

        this.swiperInstance.params.effect = 'none';
        this.swiperInstance.update();

        this.swiperInstance.slideNext();
        this.swiperInstance.slidePrev();

        if (this.currentPage != currentPage) {
            this.swiperInstance.slideTo(currentPage);
            this.swiperInstance.update();
        }

        this.swiperInstance.params.effect = effect;
        this.swiperInstance.update();
    }

    onWindowKeyDown(e) {
        const key = keyboardnavigation.getKeyName(e);

        // Ctrl (Cmd on a Mac) + 0 shows the whole page again
        if ((e.ctrlKey || e.metaKey) && !e.altKey && key === 'Digit0') {
            e.preventDefault();
            this.pageZoom?.close();
            return;
        }

        // Skip modified keys
        if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

        const rtl = this.comicsPlayerSettings.langDir === 'rtl';
        switch (key) {
            case 'Escape':
                e.preventDefault();
                if (this.pageZoom?.fitWidth) {
                    this.toggleFitWidth();
                } else if (this.pageZoom?.active) {
                    this.pageZoom.close();
                } else {
                    this.stop();
                }
                break;
            case 'ArrowRight':
                e.preventDefault();
                rtl ? this.previous() : this.next();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                rtl ? this.next() : this.previous();
                break;
            case 'PageDown':
                e.preventDefault();
                this.next();
                break;
            case 'PageUp':
                e.preventDefault();
                this.previous();
                break;
            case 'Space':
                e.preventDefault();
                this.toggleFitWidth();
                break;
            case 'KeyM':
                this.toggleZoom();
                break;
            case 'KeyF':
                if (Screenfull.isEnabled) {
                    Screenfull.toggle();
                    this.toggleFullscreen();
                }
                break;
        }
    }

    bindEvents() {
        this.mediaElement?.addEventListener('close', this.onDialogClosed, { once: true });
        document.addEventListener('keydown', this.onWindowKeyDown);
        window.addEventListener('resize', this.onResize);
    }

    unbindEvents() {
        this.mediaElement?.removeEventListener('close', this.onDialogClosed);
        document.removeEventListener('keydown', this.onWindowKeyDown);
        window.removeEventListener('resize', this.onResize);
        this.unbindZoomEvents();
    }

    bindZoomEvents(container) {
        this.zoomContainer = container;
        container.addEventListener('wheel', this.onWheel, { passive: false });
        // capture, so a pinch is seen before the swiper starts a swipe
        container.addEventListener('pointerdown', this.onPointerDown, true);
        container.addEventListener('pointermove', this.onPointerMove);
        container.addEventListener('pointerup', this.onPointerUp);
        container.addEventListener('pointercancel', this.onPointerUp);
        container.addEventListener('dblclick', this.onDoubleClick);
    }

    unbindZoomEvents() {
        const container = this.zoomContainer;
        if (!container) return;
        container.removeEventListener('wheel', this.onWheel);
        container.removeEventListener('pointerdown', this.onPointerDown, true);
        container.removeEventListener('pointermove', this.onPointerMove);
        container.removeEventListener('pointerup', this.onPointerUp);
        container.removeEventListener('pointercancel', this.onPointerUp);
        container.removeEventListener('dblclick', this.onDoubleClick);
        this.zoomContainer = null;
    }

    currentPageUrl() {
        return this.archiveSource?.urls[this.currentPage];
    }

    onWheel(e) {
        if (this.swiperInstance) this.pageZoom?.onWheel(e, this.currentPageUrl());
    }

    onPointerDown(e) {
        if (!this.swiperInstance || !this.pageZoom?.onPointerDown(e, this.currentPageUrl())) return;
        // the zoom took the gesture: undo any swipe it started as
        this.swiperInstance.slideTo(this.swiperInstance.activeIndex, 0);
    }

    onPointerMove(e) {
        this.pageZoom?.onPointerMove(e);
    }

    onPointerUp(e) {
        this.pageZoom?.onPointerUp(e);
    }

    onDoubleClick(e) {
        if (this.swiperInstance) this.pageZoom?.onDoubleClick(e, this.currentPageUrl());
    }

    onResize() {
        this.pageZoom?.onResize();
    }

    onZoomActiveChange(active) {
        if (!this.swiperInstance) return;
        this.swiperInstance.allowTouchMove = !active;
        if (!active && this.swiperInstance.activeIndex !== this.currentPage) {
            this.swiperInstance.slideTo(this.currentPage, 0);
        }
    }

    toggleZoom() {
        if (this.swiperInstance) this.pageZoom?.toggle(this.currentPageUrl());
    }

    toggleFitWidth() {
        if (this.swiperInstance) this.pageZoom?.toggleFitWidth(this.currentPageUrl());
    }

    toggleFullscreen() {
        setTimeout(() => {
            this.swiperInstance?.update();
            this.pageZoom?.onResize();
        }, 200);
    }

    createMediaElement(options) {
        let elem = this.mediaElement;
        if (elem) {
            return elem;
        }

        elem = document.getElementById('comicsPlayer');
        if (!elem) {
            elem = dialogHelper.createDialog({
                exitAnimationDuration: 400,
                size: 'fullscreen',
                autoFocus: false,
                scrollY: false,
                exitAnimation: 'fadeout',
                removeOnClose: true
            });

            elem.id = 'comicsPlayer';
            elem.classList.add('slideshowDialog');
            elem.innerHTML = `<div id="bookOsdMount"></div><div dir=${this.comicsPlayerSettings.langDir} class="slideshowSwiperContainer">
                                <div class="swiper-wrapper"></div>
                                <div class="swiper-pagination"></div>
                            </div>`;

            dialogHelper.open(elem);
        }

        this.mediaElement = elem;
        this.unmountBookOsd = renderComponent(BookOsd, {
            item: options.items[0],
            onExit: this.onDialogClosed,
            onPrevious: this.previous,
            onNext: this.next,
            onToggleDirection: this.onDirChanged,
            onToggleLayout: this.onViewChanged,
            onToggleFitWidth: this.toggleFitWidth,
            onToggleFullscreen: this.toggleFullscreen
        }, elem.querySelector('#bookOsdMount'));

        this.bindEvents();
        return elem;
    }

    setCurrentSrc(elem, options) {
        const item = options.items[0];
        this.item = item;
        this.streamInfo = {
            started: true,
            ended: false,
            item: this.item,
            mediaSource: {
                Id: item.Id
            }
        };

        loading.show();

        Archive.init({
            workerUrl: appRouter.baseUrl() + '/libraries/worker-bundle.js'
        });

        const api = ServerConnections.getApi(item.ServerId);
        if (!api) {
            console.error('[ComicsPlayer] no Api instance available for server', item.ServerId);
            return;
        }

        const downloadUrl = getLibraryApi(api).getDownloadUrl({ itemId: item.Id });
        this.archiveSource = new ArchiveSource(downloadUrl);

        //eslint-disable-next-line import/no-unresolved
        import('swiper/css/bundle');

        return this.archiveSource.load()
            // eslint-disable-next-line import/no-unresolved
            .then(() => import('swiper/bundle'))
            .then(({ Swiper }) => {
                loading.hide();

                this.pageCount = this.archiveSource.urls.length;
                this.currentPage = options.startPositionTicks / 10000 || 0;
                this.currentSrc = () => downloadUrl;

                const container = elem.querySelector('.slideshowSwiperContainer');
                this.swiperInstance = new Swiper(container, {
                    direction: 'horizontal',
                    // loop is disabled due to the lack of Swiper support in virtual slides
                    loop: false,
                    autoplay: false,
                    preloadImages: true,
                    slidesPerView: this.comicsPlayerSettings.pagesPerView,
                    slidesPerGroup: this.comicsPlayerSettings.pagesPerView,
                    slidesPerColumn: 1,
                    initialSlide: this.currentPage,
                    pagination: {
                        el: '.swiper-pagination',
                        clickable: true,
                        type: 'fraction'
                    },
                    // reduces memory consumption for large libraries while allowing preloading of images
                    virtual: {
                        slides: this.archiveSource.urls,
                        cache: true,
                        renderSlide: this.getImgFromUrl,
                        addSlidesBefore: 1,
                        addSlidesAfter: 1
                    }
                });

                // save current page ( a page is an image file inside the archive )
                this.swiperInstance.on('slideChange', () => {
                    // while zoomed in the zoom turns the pages, one at a time
                    if (this.pageZoom?.active) return;
                    this.currentPage = this.swiperInstance.activeIndex;
                    Events.trigger(this, 'pause');
                });

                this.pageZoom = new PageZoom(container);
                this.pageZoom.onActiveChange = active => this.onZoomActiveChange(active);
                this.bindZoomEvents(container);
            });
    }

    next() {
        if (this.pageZoom?.active) {
            this.turnZoomedPage(1);
        } else {
            this.swiperInstance?.slideNext();
        }
    }

    previous() {
        if (this.pageZoom?.active) {
            this.turnZoomedPage(-1);
        } else {
            this.swiperInstance?.slidePrev();
        }
    }

    turnZoomedPage(step) {
        const page = this.currentPage + step;
        if (page < 0 || page >= this.pageCount) return;
        this.currentPage = page;
        this.pageZoom.setPage(this.currentPageUrl());
        // keep the page number below in step
        this.swiperInstance.slideTo(page, 0);
        Events.trigger(this, 'pause');
    }

    getImgFromUrl(url) {
        return `<div class="swiper-slide">
                   <img src="${url}" class="swiper-slide-img" draggable="false">
               </div>`;
    }

    canPlayMediaType(mediaType) {
        return (mediaType || '').toLowerCase() === 'book';
    }

    canPlayItem(item) {
        return item.Path && FILE_EXTENSIONS.some(ext => item.Path.endsWith(ext));
    }
}

class ArchiveSource {
    constructor(url) {
        this.url = url;
        this.files = [];
        this.urls = [];
    }

    async load() {
        const res = await fetch(this.url);
        if (!res.ok) {
            return;
        }

        const blob = await res.blob();
        this.archive = await Archive.open(blob);
        this.raw = await this.archive.getFilesArray();
        await this.archive.extractFiles();

        let files = await this.archive.getFilesArray();

        // metadata files and files without a file extension should not be considered as a page
        files = files.filter((file) => {
            const name = file.file.name;
            const index = name.lastIndexOf('.');
            return index !== -1 && IMAGE_FORMATS.includes(name.slice(index + 1).toLowerCase());
        });
        files.sort((a, b) => {
            if (a.file.name < b.file.name) {
                return -1;
            } else {
                return 1;
            }
        });

        for (const file of files) {
            const url = URL.createObjectURL(file.file);
            this.urls.push(url);
        }
    }

    release() {
        this.files = [];
        this.urls.forEach(URL.revokeObjectURL);
        this.urls = [];
    }
}

export default ComicsPlayer;
