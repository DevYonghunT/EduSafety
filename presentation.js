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
  slideNumber: false,
  pdfSeparateFragments: false,
  pdfMaxPagesPerSlide: 1,
  plugins: [],
});

const editableSelector = "input, textarea, select, [contenteditable='true']";
const timerElement = document.querySelector("#talk-timer");
const timerValueElement = timerElement?.querySelector("time");
const timerDurationMs = 5 * 60 * 1000;

let timerStartedAt = null;
let timerIntervalId = null;

function formatTimer(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function renderTimer() {
  if (!timerElement || !timerValueElement || timerStartedAt === null) return;

  const elapsedMs = Date.now() - timerStartedAt;
  const remainingSeconds = Math.max(0, Math.ceil((timerDurationMs - elapsedMs) / 1000));
  const formattedTime = formatTimer(remainingSeconds);

  timerValueElement.textContent = formattedTime;
  timerValueElement.dateTime = `PT${remainingSeconds}S`;
  timerElement.classList.toggle("is-finished", remainingSeconds === 0);
  timerElement.setAttribute(
    "aria-label",
    remainingSeconds === 0 ? "발표 시간 5분이 지났습니다" : `발표 남은 시간 ${formattedTime}`,
  );

  if (remainingSeconds === 0 && timerIntervalId !== null) {
    window.clearInterval(timerIntervalId);
    timerIntervalId = null;
  }
}

function startTimer() {
  if (!timerElement || timerStartedAt !== null) return;

  timerStartedAt = Date.now();
  renderTimer();
  timerIntervalId = window.setInterval(renderTimer, 250);
}

function syncTimerVisibility(slideIndex) {
  if (!timerElement) return;
  timerElement.hidden = timerStartedAt === null || slideIndex === 0;
}

async function initializeDeck() {
  await deck.initialize();

  const initialSlideIndex = deck.getIndices().h;
  if (initialSlideIndex > 0) startTimer();
  syncTimerVisibility(initialSlideIndex);

  deck.on("slidechanged", ({ previousSlide, currentSlide }) => {
    previousSlide?.querySelectorAll("video").forEach((video) => video.pause());

    const currentSlideIndex = deck.getHorizontalSlides().indexOf(currentSlide);
    if (currentSlideIndex >= 1) startTimer();
    syncTimerVisibility(currentSlideIndex);
  });

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
