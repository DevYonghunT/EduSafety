const deck = new globalThis.Reveal({
  width: 1440,
  height: 810,
  margin: 0,
  minScale: 0.2,
  maxScale: 1.6,
  controls: true,
  controlsTutorial: false,
  progress: true,
  hash: true,
  history: false,
  keyboard: true,
  overview: true,
  center: false,
  touch: true,
  loop: false,
  rtl: false,
  navigationMode: "linear",
  shuffle: false,
  fragments: true,
  fragmentInURL: false,
  embedded: false,
  help: true,
  pause: true,
  showNotes: false,
  autoPlayMedia: false,
  preloadIframes: null,
  autoAnimate: false,
  transition: "none",
  backgroundTransition: "none",
  slideNumber: "c/t",
  pdfSeparateFragments: false,
  pdfMaxPagesPerSlide: 1,
  plugins: [],
});

const editableSelector = "input, textarea, select, [contenteditable='true']";

async function initializeDeck() {
  await deck.initialize();

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.code !== "Space" && event.key !== " ") return;
      if (event.target instanceof Element && event.target.closest(editableSelector)) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      if (event.repeat) return;

      const { h } = deck.getIndices();
      const lastSlideIndex = deck.getHorizontalSlides().length - 1;
      const nextSlideIndex = event.shiftKey
        ? Math.max(0, h - 1)
        : Math.min(lastSlideIndex, h + 1);

      deck.slide(nextSlideIndex, 0, -1);
    },
    { capture: true },
  );
}

initializeDeck().catch((error) => {
  console.error("EduSafety presentation initialization failed", error);
});
